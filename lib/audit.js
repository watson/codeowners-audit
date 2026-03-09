import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  parseCodeowners,
  parseCodeownersRuleLine,
  createPatternMatcher,
} from './codeowners-parser.js'
import { runGitCommand, toPosixPath, formatCommandError } from './git.js'
import { buildReport } from './report-builder.js'
import { renderHtml } from './report-renderer.js'
import { resolveRepoWebUrl } from './repository.js'
import { collectDirectoryTeamSuggestions } from './team-suggestions.js'

const SUPPORTED_CODEOWNERS_PATHS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS']
const SUPPORTED_CODEOWNERS_PATHS_LABEL = SUPPORTED_CODEOWNERS_PATHS.join(', ')

/**
 * Run a complete CODEOWNERS audit on a repository.
 *
 * This is the core orchestration function that handles file discovery,
 * CODEOWNERS parsing, coverage analysis, optional team suggestions,
 * and HTML report rendering. It contains no CLI-specific logic
 * (no process.exit, console.log, or temp directory management).
 *
 * @param {string} repoRoot - Absolute path to the repository root.
 * @param {{
 *   includeUntracked: boolean,
 *   checkGlobs?: string[],
 *   outputRelativePath?: string,
 *   noReport?: boolean,
 *   teamSuggestions?: boolean,
 *   verbose?: boolean,
 *   githubOrg: string|null,
 *   githubToken?: string,
 *   githubApiBaseUrl: string,
 *   teamSuggestionsIgnoreTeams: string[],
 *   teamSuggestionsWindowDays: number,
 *   teamSuggestionsTop: number,
 *   progress?: (message: string, ...values: any[]) => void,
 *   ensureHistoryAvailability?: () => Promise<boolean>,
 * }} options
 * @returns {Promise<{ report: import('./types.js').ReportData, html: string|null }>}
 */
async function audit (repoRoot, options) {
  const progress = typeof options.progress === 'function' ? options.progress : () => {}

  const allRepoFiles = listRepoFiles(options.includeUntracked, repoRoot)
  const discoveredCodeownersPaths = listDiscoveredCodeownersPaths(allRepoFiles)
  const codeownersPath = resolveActiveCodeownersPath(discoveredCodeownersPaths)
  if (!codeownersPath) {
    throw new Error(buildMissingSupportedCodeownersError(discoveredCodeownersPaths))
  }

  const codeownersDescriptor = loadCodeownersDescriptor(repoRoot, codeownersPath)
  const discoveryWarnings = collectCodeownersDiscoveryWarnings(discoveredCodeownersPaths, codeownersPath)
  let missingPathWarnings = collectMissingCodeownersPathWarnings(codeownersDescriptor, allRepoFiles)
  if (!options.noReport && missingPathWarnings.length > 0) {
    let historyReady = false
    if (typeof options.ensureHistoryAvailability === 'function') {
      historyReady = await options.ensureHistoryAvailability()
    }
    if (historyReady) {
      const repoWebUrl = resolveRepoWebUrl(repoRoot)
      const missingPathHistoryByPattern = collectCodeownersPatternHistory(
        repoRoot,
        codeownersDescriptor,
        repoWebUrl
      )
      missingPathWarnings = collectMissingCodeownersPathWarnings(
        codeownersDescriptor,
        allRepoFiles,
        missingPathHistoryByPattern
      )
    }
  }

  const scopeFilteredFiles = filterFilesByGlobs(allRepoFiles, options.checkGlobs || ['**'])
  const filesToAnalyze = options.outputRelativePath
    ? scopeFilteredFiles.filter(filePath => filePath !== options.outputRelativePath)
    : scopeFilteredFiles

  progress('Scanning %d files against CODEOWNERS rules...', filesToAnalyze.length)
  const report = buildReport(repoRoot, filesToAnalyze, codeownersDescriptor, options, progress)
  report.codeownersValidationMeta = {
    discoveryWarnings,
    discoveryWarningCount: discoveryWarnings.length,
    missingPathWarnings,
    missingPathWarningCount: missingPathWarnings.length,
  }
  progress(
    'Coverage analysis complete: %d files, %d owned, %d unowned.',
    report.totals.files,
    report.totals.owned,
    report.totals.unowned
  )

  if (options.teamSuggestions && !options.noReport) {
    progress('Starting team suggestions for uncovered 0%-coverage directories...')
    const suggestionData = await collectDirectoryTeamSuggestions(repoRoot, report, options, {
      progress,
      runGitCommand,
      toPosixPath,
      formatCommandError,
    })
    report.directoryTeamSuggestions = suggestionData.suggestions
    report.directoryTeamSuggestionsMeta = suggestionData.meta
    progress(
      'Team suggestion phase complete: %d directory suggestions generated.',
      suggestionData.suggestions.length
    )
  }

  const html = !options.noReport ? renderHtml(report) : null

  return { report, html }
}

/**
 * Build a file matcher for glob patterns.
 * @param {string[]} patterns
 * @returns {(filePath: string) => boolean}
 */
function createGlobMatcher (patterns) {
  const matchers = patterns.map(pattern => createPatternMatcher(pattern))
  return (filePath) => matchers.some(matches => matches(filePath))
}

/**
 * Filter file paths by glob patterns.
 * @param {string[]} files
 * @param {string[]} patterns
 * @returns {string[]}
 */
function filterFilesByGlobs (files, patterns) {
  const matcher = createGlobMatcher(patterns)
  return files.filter(filePath => matcher(filePath))
}

/**
 * Detect whether the repository is shallow.
 * @param {string} repoRoot
 * @returns {boolean}
 */
function isShallowRepository (repoRoot) {
  try {
    return runGitCommand(['rev-parse', '--is-shallow-repository'], repoRoot).trim() === 'true'
  } catch {
    return false
  }
}

/**
 * List repository files as POSIX-style relative paths.
 * @param {boolean} includeUntracked
 * @param {string} repoRoot
 * @returns {string[]}
 */
function listRepoFiles (includeUntracked, repoRoot) {
  const args = includeUntracked
    ? ['ls-files', '-z', '--cached', '--others', '--exclude-standard']
    : ['ls-files', '-z']
  const stdout = runGitCommand(args, repoRoot)
  return stdout
    .split('\u0000')
    .map(filePath => filePath.trim())
    .filter(Boolean)
    .map(toPosixPath)
}

/**
 * Determine if a path points to any CODEOWNERS file.
 * @param {string} filePath
 * @returns {boolean}
 */
function isCodeownersFile (filePath) {
  return path.posix.basename(filePath) === 'CODEOWNERS'
}

/**
 * Determine if a path points to a supported GitHub CODEOWNERS location.
 * @param {string} filePath
 * @returns {boolean}
 */
function isSupportedCodeownersFile (filePath) {
  return SUPPORTED_CODEOWNERS_PATHS.includes(filePath)
}

/**
 * List all discovered CODEOWNERS file paths in the repository.
 * @param {string[]} repoFiles
 * @returns {string[]}
 */
function listDiscoveredCodeownersPaths (repoFiles) {
  return repoFiles.filter(isCodeownersFile)
}

/**
 * Resolve the active CODEOWNERS file using GitHub's precedence rules.
 * GitHub only considers top-level CODEOWNERS files in `.github/`, the
 * repository root, and `docs/`, using the first file it finds in that order.
 * @param {string[]} discoveredCodeownersPaths
 * @returns {string|undefined}
 */
function resolveActiveCodeownersPath (discoveredCodeownersPaths) {
  return SUPPORTED_CODEOWNERS_PATHS.find(codeownersPath => discoveredCodeownersPaths.includes(codeownersPath))
}

/**
 * Build a clear error when no supported CODEOWNERS file is available.
 * @param {string[]} discoveredCodeownersPaths
 * @returns {string}
 */
function buildMissingSupportedCodeownersError (discoveredCodeownersPaths) {
  if (discoveredCodeownersPaths.length === 0) {
    return 'No CODEOWNERS files found in this repository.'
  }

  const unsupportedPaths = discoveredCodeownersPaths.filter((filePath) => !isSupportedCodeownersFile(filePath))
  if (unsupportedPaths.length === discoveredCodeownersPaths.length) {
    return [
      'No supported CODEOWNERS files found in this repository.',
      `GitHub only supports ${SUPPORTED_CODEOWNERS_PATHS_LABEL}.`,
      `Unsupported CODEOWNERS files were found at: ${unsupportedPaths.join(', ')}.`,
    ].join(' ')
  }

  return 'No CODEOWNERS files found in this repository.'
}

/**
 * Load a CODEOWNERS descriptor with parsed rules.
 * @param {string} repoRoot
 * @param {string} codeownersPath
 * @returns {import('./types.js').CodeownersDescriptor}
 */
function loadCodeownersDescriptor (repoRoot, codeownersPath) {
  const fileContent = readFileSync(path.join(repoRoot, codeownersPath), 'utf8')
  const rules = parseCodeowners(fileContent)

  return {
    path: codeownersPath,
    rules,
  }
}

/**
 * Build missing-path warnings for CODEOWNERS rules that match no repository files.
 * @param {import('./types.js').CodeownersDescriptor} codeownersDescriptor
 * @param {string[]} repoFiles
 * @param {Map<string, import('./types.js').PatternHistoryInfo>} [historyByPattern]
 * @returns {import('./types.js').MissingPathWarning[]}
 */
function collectMissingCodeownersPathWarnings (codeownersDescriptor, repoFiles, historyByPattern = new Map()) {
  /** @type {import('./types.js').MissingPathWarning[]} */
  const warnings = []

  for (const rule of codeownersDescriptor.rules) {
    const hasMatch = repoFiles.some((filePath) => rule.matches(filePath))
    if (!hasMatch) {
      /** @type {import('./types.js').MissingPathWarning} */
      const warning = {
        codeownersPath: codeownersDescriptor.path,
        pattern: rule.pattern,
        owners: rule.owners,
      }
      const history = historyByPattern.get(rule.pattern)
      if (history) {
        warning.history = history
      }
      warnings.push(warning)
    }
  }

  warnings.sort((first, second) => {
    const byPath = first.codeownersPath.localeCompare(second.codeownersPath)
    if (byPath !== 0) return byPath
    return first.pattern.localeCompare(second.pattern)
  })
  return warnings
}

/**
 * Replay CODEOWNERS file history to determine when each current pattern first
 * appeared in its current continuous lifetime.
 * @param {string} repoRoot
 * @param {import('./types.js').CodeownersDescriptor} codeownersDescriptor
 * @param {string|null} repoWebUrl
 * @returns {Map<string, import('./types.js').PatternHistoryInfo>}
 */
function collectCodeownersPatternHistory (repoRoot, codeownersDescriptor, repoWebUrl) {
  const currentPatterns = new Set(codeownersDescriptor.rules.map(rule => rule.pattern))
  /** @type {Map<string, import('./types.js').PatternHistoryInfo>} */
  const activeHistory = new Map()

  if (currentPatterns.size === 0) {
    return activeHistory
  }

  /** @type {string} */
  let stdout
  try {
    stdout = runGitCommand(
      ['log', '--follow', '--format=%x1e%H%x00%ct', '-p', '--unified=0', '--no-ext-diff', '--', codeownersDescriptor.path],
      repoRoot
    )
  } catch {
    return activeHistory
  }

  const logEntries = stdout
    .split('\u001e')
    .filter(Boolean)
    .reverse()

  for (const entry of logEntries) {
    if (!entry) continue
    const normalizedEntry = entry.replace(/^\n+/, '')
    if (!normalizedEntry) continue

    const firstNewlineIndex = normalizedEntry.indexOf('\n')
    const metadataLine = firstNewlineIndex === -1
      ? normalizedEntry
      : normalizedEntry.slice(0, firstNewlineIndex)
    const patch = firstNewlineIndex === -1
      ? ''
      : normalizedEntry.slice(firstNewlineIndex + 1)
    const [commitSha, commitTimestamp] = metadataLine.split('\u0000')
    const commitSeconds = Number.parseInt(commitTimestamp, 10)
    if (!commitSha || !Number.isFinite(commitSeconds)) continue

    const commitInfo = {
      addedAt: new Date(commitSeconds * 1000).toISOString(),
      commitSha,
      ...(repoWebUrl ? { commitUrl: `${repoWebUrl}/commit/${encodeURIComponent(commitSha)}` } : {}),
    }
    const changeSet = collectCodeownersPatternDiffChangeSet(patch)

    for (const pattern of changeSet.deleted) {
      if (!changeSet.added.has(pattern)) {
        activeHistory.delete(pattern)
      }
    }
    for (const pattern of changeSet.added) {
      if (!activeHistory.has(pattern)) {
        activeHistory.set(pattern, commitInfo)
      }
    }
  }

  const historyByPattern = new Map()
  for (const pattern of currentPatterns) {
    const history = activeHistory.get(pattern)
    if (history) {
      historyByPattern.set(pattern, history)
    }
  }
  return historyByPattern
}

/**
 * Collect added and deleted CODEOWNERS patterns from a unified diff.
 * Pattern-level tracking preserves age across owner-only edits to the same path.
 * @param {string} patch
 * @returns {{ added: Set<string>, deleted: Set<string> }}
 */
function collectCodeownersPatternDiffChangeSet (patch) {
  /** @type {Set<string>} */
  const added = new Set()
  /** @type {Set<string>} */
  const deleted = new Set()

  for (const line of patch.split('\n')) {
    if (!line) continue
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line[0] !== '+' && line[0] !== '-') continue

    const parsedRule = parseCodeownersRuleLine(line.slice(1))
    if (!parsedRule) continue

    if (line[0] === '+') {
      added.add(parsedRule.pattern)
    } else {
      deleted.add(parsedRule.pattern)
    }
  }

  return { added, deleted }
}

/**
 * Build discovery warnings for extra or unsupported CODEOWNERS files.
 * @param {string[]} discoveredCodeownersPaths
 * @param {string} activeCodeownersPath
 * @returns {import('./types.js').DiscoveryWarning[]}
 */
function collectCodeownersDiscoveryWarnings (discoveredCodeownersPaths, activeCodeownersPath) {
  /** @type {import('./types.js').DiscoveryWarning[]} */
  const warnings = []

  for (const codeownersPath of discoveredCodeownersPaths) {
    if (codeownersPath === activeCodeownersPath) continue

    if (isSupportedCodeownersFile(codeownersPath)) {
      warnings.push({
        path: codeownersPath,
        type: 'unused-supported-location',
        referencePath: activeCodeownersPath,
        message: `${codeownersPath} is unused because GitHub selects ${activeCodeownersPath} first.`,
      })
      continue
    }

    warnings.push({
      path: codeownersPath,
      type: 'unsupported-location',
      message: `${codeownersPath} is in an unsupported location and is ignored by GitHub.`,
    })
  }

  warnings.sort((first, second) => first.path.localeCompare(second.path))
  return warnings
}

export {
  SUPPORTED_CODEOWNERS_PATHS,
  audit,
  buildMissingSupportedCodeownersError,
  collectCodeownersDiscoveryWarnings,
  collectCodeownersPatternDiffChangeSet,
  collectCodeownersPatternHistory,
  collectMissingCodeownersPathWarnings,
  createGlobMatcher,
  filterFilesByGlobs,
  isCodeownersFile,
  isShallowRepository,
  isSupportedCodeownersFile,
  listDiscoveredCodeownersPaths,
  listRepoFiles,
  loadCodeownersDescriptor,
  resolveActiveCodeownersPath,
}
