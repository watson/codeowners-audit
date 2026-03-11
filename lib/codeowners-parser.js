/**
 * Remove inline comments, preserving escaped "#".
 * @param {string} line
 * @returns {string}
 */
function stripInlineComment (line) {
  let escaped = false
  for (let index = 0; index < line.length; index++) {
    const char = line[index]
    if (char === '#' && !escaped) {
      return line.slice(0, index)
    }

    escaped = char === '\\' && !escaped
    if (char !== '\\') {
      escaped = false
    }
  }
  return line
}

/**
 * Split a CODEOWNERS line into tokens while preserving escaped spaces.
 * @param {string} line
 * @returns {string[]}
 */
function tokenizeCodeownersLine (line) {
  return line.match(/(?:\\.|[^\s])+/g) || []
}

/**
 * Unescape CODEOWNERS token sequences.
 * @param {string} token
 * @returns {string}
 */
function unescapeToken (token) {
  return token.replaceAll(/\\(.)/g, '$1')
}

/**
 * Detect GitHub-invalid CODEOWNERS pattern syntax.
 * GitHub documents that escaped leading "#" and bracket expressions do not work.
 * @param {string} rawPattern
 * @returns {boolean}
 */
function isGithubInvalidCodeownersPattern (rawPattern) {
  if (rawPattern.startsWith('\\#')) {
    return true
  }

  let escaped = false
  for (const char of rawPattern) {
    if (char === '[' && !escaped) {
      return true
    }

    escaped = char === '\\' && !escaped
    if (char !== '\\') {
      escaped = false
    }
  }

  return false
}

/**
 * Escape regex-special characters.
 * @param {string} char
 * @returns {string}
 */
function escapeRegexChar (char) {
  return /[\\^$.*+?()[\]{}|]/.test(char) ? `\\${char}` : char
}

/**
 * Convert a glob-like CODEOWNERS pattern to regex source.
 * @param {string} pattern
 * @returns {string}
 */
function globToRegexSource (pattern) {
  let source = ''
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        source += '.*'
        index++
      } else {
        source += '[^/]*'
      }
      continue
    }

    if (char === '?') {
      source += '[^/]'
      continue
    }

    source += escapeRegexChar(char)
  }
  return source
}

/**
 * Build a matcher for a CODEOWNERS pattern.
 * @param {string} rawPattern
 * @param {{ includeDescendants?: boolean }} [options]
 * @returns {(repoPath: string) => boolean}
 */
function createPatternMatcher (rawPattern, options = {}) {
  const includeDescendants = Boolean(options.includeDescendants)
  const directoryOnly = rawPattern.endsWith('/')
  const anchored = rawPattern.startsWith('/')
  const pattern = rawPattern.replace(/^\/+/, '').replace(/\/+$/, '')
  if (!pattern) {
    return () => false
  }

  const patternSource = globToRegexSource(pattern)
  const lastSegment = pattern.split('/').at(-1) || ''
  const lastSegmentHasWildcards = lastSegment.includes('*') || lastSegment.includes('?')
  const descendantSuffix = (directoryOnly || (includeDescendants && !lastSegmentHasWildcards)) ? '(?:/.*)?' : ''
  if (anchored) {
    const anchoredRegex = new RegExp(`^${patternSource}${descendantSuffix}$`)
    return (repoPath) => anchoredRegex.test(repoPath)
  }

  const unanchoredRegex = new RegExp(`(?:^|/)${patternSource}${descendantSuffix}$`)
  return (repoPath) => unanchoredRegex.test(repoPath)
}

/**
 * Parse a single CODEOWNERS rule line, ignoring blank lines, comments,
 * and unsupported negation patterns. Pattern-only rows are preserved so a
 * later rule can intentionally clear ownership for a path.
 * @param {string} line
 * @returns {{ pattern: string, owners: string[] }|null}
 */
function parseCodeownersRuleLine (line) {
  const withoutComment = stripInlineComment(line).trim()
  if (!withoutComment) return null

  const rawTokens = tokenizeCodeownersLine(withoutComment)
  if (rawTokens.length === 0) return null
  if (isGithubInvalidCodeownersPattern(rawTokens[0])) return null

  const tokens = rawTokens.map(unescapeToken)

  const pattern = tokens[0]
  if (pattern.startsWith('!')) return null // Negation is not supported in CODEOWNERS.
  const owners = tokens.slice(1).filter(Boolean)

  return { pattern, owners }
}

/**
 * Parse CODEOWNERS content into rule matchers.
 * @param {string} fileContent
 * @returns {{ pattern: string, owners: string[], matches: (repoPath: string) => boolean, effectiveOwners?: string[] }[]}
 */
function parseCodeowners (fileContent) {
  const lines = fileContent.split(/\r?\n/)
  const rules = []

  for (const line of lines) {
    const parsedRule = parseCodeownersRuleLine(line)
    if (!parsedRule) continue

    rules.push({
      pattern: parsedRule.pattern,
      owners: parsedRule.owners,
      matches: createPatternMatcher(parsedRule.pattern, { includeDescendants: true }),
    })
  }

  return rules
}

/**
 * Find the last matching owners in a ruleset.
 * @param {string} repoPath
 * @param {{ owners: string[], effectiveOwners?: string[], matches: (repoPath: string) => boolean }[]} rules
 * @returns {{ owners: string[], effectiveOwners?: string[], matches: (repoPath: string) => boolean }|undefined}
 */
function findMatchingRule (repoPath, rules) {
  /** @type {{ owners: string[], effectiveOwners?: string[], matches: (repoPath: string) => boolean }|undefined} */
  let rule
  for (const candidate of rules) {
    if (candidate.matches(repoPath)) {
      rule = candidate
    }
  }
  return rule
}

/**
 * Find the last matching owners in a ruleset.
 * @param {string} repoPath
 * @param {{ owners: string[], effectiveOwners?: string[], matches: (repoPath: string) => boolean }[]} rules
 * @returns {string[]|undefined}
 */
function findMatchingOwners (repoPath, rules) {
  const rule = findMatchingRule(repoPath, rules)
  if (!rule) return undefined
  return Array.isArray(rule.effectiveOwners) ? rule.effectiveOwners : rule.owners
}

export {
  parseCodeowners,
  parseCodeownersRuleLine,
  createPatternMatcher,
  findMatchingRule,
  findMatchingOwners,
}
