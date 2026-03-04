'use strict'

const { execFileSync } = require('node:child_process')
const path = require('node:path')
const { fetchGithubApiJson, fetchGithubApiPaginatedArray } = require('./github-api')

const GIT_COMMAND_MAX_BUFFER = 64 * 1024 * 1024
const GIT_LOG_COMMIT_MARKER = '__CODEOWNERS_AUDIT_COMMIT__'
const TEAM_LOOKUP_PROGRESS_INTERVAL = 25

/**
 * Collect and rank team suggestions for uncovered directories with 0% coverage.
 * @param {string} repoRoot
 * @param {{
 *   directories: { path: string, unowned: number, coverage: number }[],
 *   unownedFiles: string[]
 * }} report
 * @param {{
 *   teamSuggestionsWindowDays: number,
 *   teamSuggestionsTop: number,
 *   teamSuggestionsIgnoreTeams: string[],
 *   githubOrg: string|null,
 *   githubTokenEnv: string,
 *   githubApiBaseUrl: string
 * }} options
 * @param {{
 *   progress?: (message: string, ...values: any[]) => void,
 *   runGitCommand?: (args: string[], cwd?: string) => string,
 *   toPosixPath?: (value: string) => string,
 *   formatCommandError?: (error: unknown) => string
 * }} [context]
 * @returns {Promise<{
 *   suggestions: {
 *     path: string,
 *     status: 'ok'|'no-history'|'no-auth'|'insufficient-mapping'|'no-team-match'|'error',
 *     totalEdits: number,
 *     resolvedLoginEdits: number,
 *     mappedEdits: number,
 *     coverageRatio: number,
 *     candidates: { team: string, slug: string, name: string, score: number, share: number }[],
 *     reason?: string
 *   }[],
 *   meta: {
 *     enabled: boolean,
 *     org: string|null,
 *     source: 'repo-teams'|'org-teams'|'none',
 *     ignoredTeams: string[],
 *     tokenEnv: string,
 *     windowDays: number,
 *     warnings: string[]
 *   }
 * }>}
 */
async function collectDirectoryTeamSuggestions (repoRoot, report, options, context = {}) {
  const progress = typeof context.progress === 'function' ? context.progress : () => {}
  const runGitCommand = typeof context.runGitCommand === 'function' ? context.runGitCommand : defaultRunGitCommand
  const toPosixPath = typeof context.toPosixPath === 'function' ? context.toPosixPath : defaultToPosixPath
  const formatCommandError = typeof context.formatCommandError === 'function'
    ? context.formatCommandError
    : defaultFormatCommandError

  const candidateDirectories = report.directories
    .filter(row => row.path !== '(root)' && row.unowned > 0 && row.coverage === 0)
    .map(row => row.path)
    .sort((first, second) => first.localeCompare(second))
  progress(
    'Team suggestions: %d uncovered directories at 0% coverage.',
    candidateDirectories.length
  )

  /** @type {{
   *   enabled: boolean,
   *   org: string|null,
   *   source: 'repo-teams'|'org-teams'|'none',
   *   ignoredTeams: string[],
   *   tokenEnv: string,
   *   windowDays: number,
   *   warnings: string[]
   * }}
   */
  const meta = {
    enabled: true,
    org: options.githubOrg || null,
    source: 'none',
    ignoredTeams: (options.teamSuggestionsIgnoreTeams || []).slice(),
    tokenEnv: options.githubTokenEnv,
    windowDays: options.teamSuggestionsWindowDays,
    warnings: [],
  }
  if (meta.ignoredTeams.length > 0) {
    progress(
      'Ignoring %d team pattern(s) from suggestions.',
      meta.ignoredTeams.length
    )
  }

  if (candidateDirectories.length === 0) {
    meta.warnings.push('No uncovered directories with 0% coverage were found.')
    return { suggestions: [], meta }
  }

  const candidateDirectorySet = new Set(candidateDirectories)
  const targetFiles = new Set()
  for (const filePath of report.unownedFiles) {
    for (const directoryPath of directoryAncestors(filePath)) {
      if (candidateDirectorySet.has(directoryPath)) {
        targetFiles.add(filePath)
      }
    }
  }
  progress(
    'Collecting contributor history over %d days for %d unowned files...',
    options.teamSuggestionsWindowDays,
    targetFiles.size
  )

  const directoryContributorStats = collectDirectoryContributorStats(
    repoRoot,
    candidateDirectorySet,
    targetFiles,
    options.teamSuggestionsWindowDays,
    {
      runGitCommand,
      toPosixPath,
    }
  )
  const contributorLoginMap = await resolveContributorLogins(
    repoRoot,
    directoryContributorStats,
    options,
    meta,
    {
      progress,
      runGitCommand,
      formatCommandError,
    }
  )
  const totalContributors = countUniqueContributors(directoryContributorStats)
  progress(
    'Contributor identity resolution complete: %d/%d contributors mapped to GitHub logins.',
    contributorLoginMap.size,
    totalContributors
  )
  const token = resolveGithubToken(options.githubTokenEnv)

  if (!token) {
    meta.warnings.push(
      'Missing token in env var ' + JSON.stringify(options.githubTokenEnv) +
      ' (or GH_TOKEN fallback); team suggestions require GitHub API access.'
    )
    return {
      suggestions: buildNoAuthSuggestions(candidateDirectories, directoryContributorStats, contributorLoginMap),
      meta,
    }
  }

  const repoIdentity = resolveGithubRepoIdentity(repoRoot, runGitCommand)
  if (!repoIdentity) {
    meta.warnings.push('Could not infer repository owner/name from git remote.origin.url.')
    return {
      suggestions: buildErrorSuggestions(
        candidateDirectories,
        directoryContributorStats,
        contributorLoginMap,
        'Could not infer repository owner/name from git remote.origin.url.'
      ),
      meta,
    }
  }

  if (!meta.org) {
    meta.org = repoIdentity.owner
  }

  if (!meta.org) {
    meta.warnings.push('Could not determine org for team lookup.')
    return {
      suggestions: buildErrorSuggestions(
        candidateDirectories,
        directoryContributorStats,
        contributorLoginMap,
        'Could not determine org for team lookup.'
      ),
      meta,
    }
  }

  const relevantLogins = new Set()
  for (const login of contributorLoginMap.values()) {
    relevantLogins.add(login)
  }

  let userTeams
  try {
    progress('Fetching GitHub team memberships for org %s...', meta.org)
    const teamIndex = await fetchTeamMembershipIndex(
      {
        token,
        baseUrl: options.githubApiBaseUrl,
      },
      {
        owner: repoIdentity.owner,
        repo: repoIdentity.repo,
        org: meta.org,
      },
      relevantLogins,
      options.teamSuggestionsIgnoreTeams,
      {
        progress,
        formatCommandError,
      }
    )
    userTeams = teamIndex.userTeams
    meta.source = teamIndex.source
    for (const warning of teamIndex.warnings) {
      meta.warnings.push(warning)
    }
  } catch (error) {
    const message = formatCommandError(error)
    meta.warnings.push(message)
    if (error && typeof error === 'object' && 'status' in error) {
      const status = Number(error.status)
      if (status === 401 || status === 403) {
        return {
          suggestions: buildNoAuthSuggestions(candidateDirectories, directoryContributorStats, contributorLoginMap, message),
          meta,
        }
      }
    }
    return {
      suggestions: buildErrorSuggestions(candidateDirectories, directoryContributorStats, contributorLoginMap, message),
      meta,
    }
  }

  const suggestions = rankDirectoryTeamSuggestions(
    candidateDirectories,
    directoryContributorStats,
    contributorLoginMap,
    userTeams,
    options.teamSuggestionsTop
  )
  const successfulSuggestions = suggestions.filter(row => row.status === 'ok').length
  progress(
    'Ranked candidate teams for %d/%d directories.',
    successfulSuggestions,
    suggestions.length
  )

  return { suggestions, meta }
}

/**
 * Build team suggestion rows for no-auth situations.
 * @param {string[]} directories
 * @param {Map<string, { totalEdits: number, contributors: Map<string, { edits: number }> }>} directoryContributorStats
 * @param {Map<string, string>} contributorLoginMap
 * @param {string} [reason]
 * @returns {{
 *   path: string,
 *   status: 'no-auth',
 *   totalEdits: number,
 *   resolvedLoginEdits: number,
 *   mappedEdits: number,
 *   coverageRatio: number,
 *   candidates: never[],
 *   reason?: string
 * }[]}
 */
function buildNoAuthSuggestions (directories, directoryContributorStats, contributorLoginMap, reason) {
  return directories.map((directoryPath) => {
    const stats = directoryContributorStats.get(directoryPath) || { totalEdits: 0, contributors: new Map() }
    const resolvedLoginEdits = countResolvedLoginEdits(stats, contributorLoginMap)
    return {
      path: directoryPath,
      status: 'no-auth',
      totalEdits: stats.totalEdits,
      resolvedLoginEdits,
      mappedEdits: 0,
      coverageRatio: 0,
      candidates: [],
      ...(reason ? { reason } : {}),
    }
  })
}

/**
 * Build team suggestion rows for hard errors.
 * @param {string[]} directories
 * @param {Map<string, { totalEdits: number, contributors: Map<string, { edits: number }> }>} directoryContributorStats
 * @param {Map<string, string>} contributorLoginMap
 * @param {string} reason
 * @returns {{
 *   path: string,
 *   status: 'error',
 *   totalEdits: number,
 *   resolvedLoginEdits: number,
 *   mappedEdits: number,
 *   coverageRatio: number,
 *   candidates: never[],
 *   reason: string
 * }[]}
 */
function buildErrorSuggestions (directories, directoryContributorStats, contributorLoginMap, reason) {
  return directories.map((directoryPath) => {
    const stats = directoryContributorStats.get(directoryPath) || { totalEdits: 0, contributors: new Map() }
    const resolvedLoginEdits = countResolvedLoginEdits(stats, contributorLoginMap)
    return {
      path: directoryPath,
      status: 'error',
      totalEdits: stats.totalEdits,
      resolvedLoginEdits,
      mappedEdits: 0,
      coverageRatio: 0,
      candidates: [],
      reason,
    }
  })
}

/**
 * Count edits made by contributors whose GitHub login is known.
 * @param {{ contributors: Map<string, { edits: number }> }} stats
 * @param {Map<string, string>} contributorLoginMap
 * @returns {number}
 */
function countResolvedLoginEdits (stats, contributorLoginMap) {
  let resolvedLoginEdits = 0
  for (const [contributorKey, contributor] of stats.contributors.entries()) {
    if (contributorLoginMap.has(contributorKey)) {
      resolvedLoginEdits += contributor.edits
    }
  }
  return resolvedLoginEdits
}

/**
 * Count unique contributors across all directory stats.
 * @param {Map<string, { contributors: Map<string, unknown> }>} directoryContributorStats
 * @returns {number}
 */
function countUniqueContributors (directoryContributorStats) {
  const contributorKeys = new Set()
  for (const stats of directoryContributorStats.values()) {
    for (const contributorKey of stats.contributors.keys()) {
      contributorKeys.add(contributorKey)
    }
  }
  return contributorKeys.size
}

/**
 * Rank candidate teams for each directory.
 * @param {string[]} directories
 * @param {Map<string, {
 *   totalEdits: number,
 *   contributors: Map<string, { edits: number }>
 * }>} directoryContributorStats
 * @param {Map<string, string>} contributorLoginMap
 * @param {Map<string, { team: string, slug: string, name: string }[]>} userTeams
 * @param {number} topN
 * @returns {{
 *   path: string,
 *   status: 'ok'|'no-history'|'insufficient-mapping'|'no-team-match',
 *   totalEdits: number,
 *   resolvedLoginEdits: number,
 *   mappedEdits: number,
 *   coverageRatio: number,
 *   candidates: { team: string, slug: string, name: string, score: number, share: number }[]
 * }[]}
 */
function rankDirectoryTeamSuggestions (directories, directoryContributorStats, contributorLoginMap, userTeams, topN) {
  /** @type {{
   *   path: string,
   *   status: 'ok'|'no-history'|'insufficient-mapping'|'no-team-match',
   *   totalEdits: number,
   *   resolvedLoginEdits: number,
   *   mappedEdits: number,
   *   coverageRatio: number,
   *   candidates: { team: string, slug: string, name: string, score: number, share: number }[]
   * }[]}
   */
  const rows = []
  for (const directoryPath of directories) {
    const stats = directoryContributorStats.get(directoryPath) || { totalEdits: 0, contributors: new Map() }
    if (!stats.totalEdits) {
      rows.push({
        path: directoryPath,
        status: 'no-history',
        totalEdits: 0,
        resolvedLoginEdits: 0,
        mappedEdits: 0,
        coverageRatio: 0,
        candidates: [],
      })
      continue
    }

    const teamScores = new Map()
    let resolvedLoginEdits = 0
    let mappedEdits = 0

    for (const [contributorKey, contributor] of stats.contributors.entries()) {
      const login = contributorLoginMap.get(contributorKey)
      if (!login) continue
      resolvedLoginEdits += contributor.edits
      const teams = userTeams.get(login) || []
      if (teams.length === 0) continue
      mappedEdits += contributor.edits
      for (const team of teams) {
        const existing = teamScores.get(team.team) || {
          team: team.team,
          slug: team.slug,
          name: team.name,
          score: 0,
        }
        existing.score += contributor.edits
        teamScores.set(team.team, existing)
      }
    }

    const candidates = Array.from(teamScores.values())
      .sort((first, second) => {
        if (first.score !== second.score) return second.score - first.score
        return first.team.localeCompare(second.team)
      })
      .slice(0, topN)
      .map((entry) => {
        const share = mappedEdits ? entry.score / mappedEdits : 0
        return {
          team: entry.team,
          slug: entry.slug,
          name: entry.name,
          score: entry.score,
          share: Math.round(share * 1000) / 1000,
        }
      })

    /** @type {'ok'|'insufficient-mapping'|'no-team-match'} */
    const status = candidates.length > 0
      ? 'ok'
      : resolvedLoginEdits === 0
          ? 'insufficient-mapping'
          : 'no-team-match'

    rows.push({
      path: directoryPath,
      status,
      totalEdits: stats.totalEdits,
      resolvedLoginEdits,
      mappedEdits,
      coverageRatio: stats.totalEdits ? Math.round((mappedEdits / stats.totalEdits) * 1000) / 1000 : 0,
      candidates,
    })
  }
  return rows
}

/**
 * Collect contributor activity per directory from recent git history.
 * @param {string} repoRoot
 * @param {Set<string>} directorySet
 * @param {Set<string>} targetFiles
 * @param {number} windowDays
 * @param {{
 *   runGitCommand: (args: string[], cwd?: string) => string,
 *   toPosixPath: (value: string) => string
 * }} context
 * @returns {Map<string, {
 *   totalEdits: number,
 *   contributors: Map<string, { key: string, name: string, email: string, edits: number, sampleShas: string[] }>
 * }>}
 */
function collectDirectoryContributorStats (repoRoot, directorySet, targetFiles, windowDays, context) {
  const directoryContributorStats = new Map()
  for (const directoryPath of directorySet) {
    directoryContributorStats.set(directoryPath, {
      totalEdits: 0,
      contributors: new Map(),
    })
  }

  if (directorySet.size === 0 || targetFiles.size === 0) {
    return directoryContributorStats
  }

  const sinceArg = '--since=' + windowDays + '.days'
  const stdout = context.runGitCommand(
    ['log', sinceArg, '--name-only', '--pretty=format:' + GIT_LOG_COMMIT_MARKER + '%x00%H%x00%an%x00%ae%x00', '-z', '--'],
    repoRoot
  )
  const tokens = stdout.split('\u0000')
  /** @type {{ sha: string, name: string, email: string, seenFiles: Set<string> }|null} */
  let currentCommit = null

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    if (!token) continue

    if (token === GIT_LOG_COMMIT_MARKER) {
      const sha = String(tokens[index + 1] || '').trim()
      const name = String(tokens[index + 2] || '').trim()
      const email = String(tokens[index + 3] || '').trim()
      index += 3
      currentCommit = {
        sha,
        name,
        email,
        seenFiles: new Set(),
      }
      continue
    }

    if (!currentCommit) continue

    const filePath = context.toPosixPath(String(token).trim())
    if (!filePath) continue
    if (!targetFiles.has(filePath)) continue
    if (currentCommit.seenFiles.has(filePath)) continue
    currentCommit.seenFiles.add(filePath)

    const contributorKey = makeContributorKey(currentCommit.name, currentCommit.email)
    for (const directoryPath of directoryAncestors(filePath)) {
      const stats = directoryContributorStats.get(directoryPath)
      if (!stats) continue
      stats.totalEdits++
      const existing = stats.contributors.get(contributorKey) || {
        key: contributorKey,
        name: currentCommit.name,
        email: currentCommit.email,
        edits: 0,
        sampleShas: [],
      }
      existing.edits++
      if (currentCommit.sha && existing.sampleShas.length < 5 && !existing.sampleShas.includes(currentCommit.sha)) {
        existing.sampleShas.push(currentCommit.sha)
      }
      stats.contributors.set(contributorKey, existing)
    }
  }

  return directoryContributorStats
}

/**
 * Resolve contributor keys to GitHub logins.
 * @param {string} repoRoot
 * @param {Map<string, {
 *   totalEdits: number,
 *   contributors: Map<string, { key: string, name: string, email: string, edits: number, sampleShas: string[] }>
 * }>} directoryContributorStats
 * @param {{
 *   githubApiBaseUrl: string,
 *   githubTokenEnv: string
 * }} options
 * @param {{ warnings: string[] }} meta
 * @param {{
 *   progress: (message: string, ...values: any[]) => void,
 *   runGitCommand: (args: string[], cwd?: string) => string,
 *   formatCommandError: (error: unknown) => string
 * }} context
 * @returns {Promise<Map<string, string>>}
 */
async function resolveContributorLogins (repoRoot, directoryContributorStats, options, meta, context) {
  const contributorByKey = new Map()
  for (const stats of directoryContributorStats.values()) {
    for (const [contributorKey, contributor] of stats.contributors.entries()) {
      if (!contributorByKey.has(contributorKey)) {
        contributorByKey.set(contributorKey, contributor)
      }
    }
  }

  const contributorLogins = new Map()
  for (const [contributorKey, contributor] of contributorByKey.entries()) {
    const loginFromEmail = extractGithubLoginFromEmail(contributor.email)
    if (loginFromEmail) {
      contributorLogins.set(contributorKey, loginFromEmail)
    }
  }

  const token = resolveGithubToken(options.githubTokenEnv)
  if (!token) {
    return contributorLogins
  }

  const repoIdentity = resolveGithubRepoIdentity(repoRoot, context.runGitCommand)
  if (!repoIdentity) {
    meta.warnings.push('Could not infer repository owner/name for commit-author login resolution.')
    return contributorLogins
  }

  const unresolvedContributors = Array.from(contributorByKey.values())
    .filter(contributor => !contributorLogins.has(contributor.key))
  context.progress(
    'Attempting commit-author API lookups for %d unresolved contributors.',
    unresolvedContributors.length
  )
  const loginBySha = new Map()

  for (let contributorIndex = 0; contributorIndex < unresolvedContributors.length; contributorIndex++) {
    const contributor = unresolvedContributors[contributorIndex]
    for (const sha of contributor.sampleShas) {
      const cached = loginBySha.get(sha)
      if (cached !== undefined) {
        if (cached) contributorLogins.set(contributor.key, cached)
        break
      }
      try {
        const commitData = await fetchGithubApiJson(
          {
            token,
            baseUrl: options.githubApiBaseUrl,
          },
          '/repos/' + encodeURIComponent(repoIdentity.owner) + '/' + encodeURIComponent(repoIdentity.repo) + '/commits/' + encodeURIComponent(sha)
        )
        const maybeLogin = normalizeGithubLogin(
          commitData && commitData.author && typeof commitData.author.login === 'string'
            ? commitData.author.login
            : ''
        )
        loginBySha.set(sha, maybeLogin || '')
        if (maybeLogin) {
          contributorLogins.set(contributor.key, maybeLogin)
          break
        }
      } catch (error) {
        loginBySha.set(sha, '')
        meta.warnings.push('Commit-author lookup failed for ' + sha + ': ' + context.formatCommandError(error))
      }
    }
    if (
      unresolvedContributors.length >= TEAM_LOOKUP_PROGRESS_INTERVAL &&
      (
        (contributorIndex + 1) % TEAM_LOOKUP_PROGRESS_INTERVAL === 0 ||
        contributorIndex + 1 === unresolvedContributors.length
      )
    ) {
      context.progress(
        'Commit-author lookup progress: %d/%d unresolved contributors checked.',
        contributorIndex + 1,
        unresolvedContributors.length
      )
    }
  }

  return contributorLogins
}

/**
 * Resolve token from the configured env var, with GH_TOKEN fallback.
 * @param {string} tokenEnvName
 * @returns {string}
 */
function resolveGithubToken (tokenEnvName) {
  const fromPrimary = process.env[tokenEnvName] || ''
  if (fromPrimary) return String(fromPrimary)
  if (tokenEnvName !== 'GH_TOKEN' && process.env.GH_TOKEN) {
    return String(process.env.GH_TOKEN)
  }
  return ''
}

/**
 * Resolve repository owner/repo from origin remote URL.
 * @param {string} repoRoot
 * @param {(args: string[], cwd?: string) => string} runGitCommand
 * @returns {{ owner: string, repo: string }|null}
 */
function resolveGithubRepoIdentity (repoRoot, runGitCommand) {
  /** @type {string} */
  let remoteUrl
  try {
    remoteUrl = runGitCommand(['remote', 'get-url', 'origin'], repoRoot).trim()
  } catch {
    return null
  }
  return parseRemoteUrlToOwnerRepo(remoteUrl)
}

/**
 * Parse owner/repo from common GitHub remote URL formats.
 * @param {string} remoteUrl
 * @returns {{ owner: string, repo: string }|null}
 */
function parseRemoteUrlToOwnerRepo (remoteUrl) {
  const sshMatch = remoteUrl.match(/^git@[^:]+:([^/]+)\/(.+?)(?:\.git)?$/)
  if (sshMatch) {
    return {
      owner: sshMatch[1],
      repo: sshMatch[2],
    }
  }

  try {
    const parsed = new URL(remoteUrl)
    const parts = parsed.pathname.replaceAll(/^\/+|\/+$/g, '').split('/')
    if (parts.length >= 2) {
      return {
        owner: parts[0],
        repo: parts[1].replace(/\.git$/i, ''),
      }
    }
  } catch {}

  return null
}

/**
 * Build a stable contributor key from commit author fields.
 * @param {string} name
 * @param {string} email
 * @returns {string}
 */
function makeContributorKey (name, email) {
  return String(name || '').trim().toLowerCase() + '\u0001' + String(email || '').trim().toLowerCase()
}

/**
 * Extract parent directories from a repo-relative file path.
 * @param {string} filePath
 * @returns {string[]}
 */
function directoryAncestors (filePath) {
  const segments = filePath.split('/')
  const ancestors = []
  let current = ''
  for (let index = 0; index < segments.length - 1; index++) {
    current = current ? current + '/' + segments[index] : segments[index]
    ancestors.push(current)
  }
  return ancestors
}

/**
 * Try to resolve a GitHub login from a noreply email pattern.
 * @param {string} email
 * @returns {string}
 */
function extractGithubLoginFromEmail (email) {
  const normalizedEmail = String(email || '').trim().toLowerCase()
  const match = normalizedEmail.match(/^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/)
  if (!match) return ''
  return normalizeGithubLogin(match[1])
}

/**
 * Normalize and validate a GitHub login.
 * @param {string} login
 * @returns {string}
 */
function normalizeGithubLogin (login) {
  const trimmed = String(login || '').trim()
  if (!trimmed) return ''
  if (!/^[a-z\d](?:[a-z\d-]{0,38})$/i.test(trimmed)) {
    return ''
  }
  return trimmed.toLowerCase()
}

/**
 * Fetch and invert team membership for relevant users.
 * @param {{ token: string, baseUrl: string }} apiContext
 * @param {{ owner: string, repo: string, org: string }} repoContext
 * @param {Set<string>} relevantLogins
 * @param {string[]} ignoredTeams
 * @param {{
 *   progress: (message: string, ...values: any[]) => void,
 *   formatCommandError: (error: unknown) => string
 * }} context
 * @returns {Promise<{
 *   source: 'repo-teams'|'org-teams',
 *   warnings: string[],
 *   userTeams: Map<string, { team: string, slug: string, name: string }[]>
 * }>}
 */
async function fetchTeamMembershipIndex (apiContext, repoContext, relevantLogins, ignoredTeams, context) {
  const warnings = []
  /** @type {'repo-teams'|'org-teams'} */
  let source = 'repo-teams'

  /** @type {{ slug: string, name: string }[]} */
  let teams
  try {
    context.progress('Listing teams with repository access...')
    const repoTeamsRaw = /** @type {{ slug?: string, name?: string }[]} */ (await fetchGithubApiPaginatedArray(
      apiContext,
      '/repos/' + encodeURIComponent(repoContext.owner) + '/' + encodeURIComponent(repoContext.repo) + '/teams'
    ))
    teams = repoTeamsRaw.map((team) => {
      return {
        slug: String(team.slug || ''),
        name: String(team.name || team.slug || ''),
      }
    }).filter((team) => team.slug)
  } catch (error) {
    source = 'org-teams'
    context.progress('Falling back to listing all organization teams...')
    warnings.push(
      'Could not list repository teams; falling back to org teams: ' + context.formatCommandError(error)
    )
    const orgTeamsRaw = /** @type {{ slug?: string, name?: string }[]} */ (await fetchGithubApiPaginatedArray(
      apiContext,
      '/orgs/' + encodeURIComponent(repoContext.org) + '/teams'
    ))
    teams = orgTeamsRaw.map((team) => {
      return {
        slug: String(team.slug || ''),
        name: String(team.name || team.slug || ''),
      }
    }).filter((team) => team.slug)
  }

  const shouldIgnoreTeam = createTeamIgnoreMatcher(repoContext.org, ignoredTeams)
  const filteredTeams = teams.filter((team) => !shouldIgnoreTeam(team.slug))
  const ignoredCount = teams.length - filteredTeams.length
  if (ignoredCount > 0) {
    context.progress('Filtered out %d ignored team(s) before membership lookup.', ignoredCount)
  }
  teams = filteredTeams
  context.progress('Fetched %d teams. Collecting team memberships...', teams.length)

  /** @type {Map<string, { team: string, slug: string, name: string }[]>} */
  const userTeams = new Map()
  for (let teamIndex = 0; teamIndex < teams.length; teamIndex++) {
    const team = teams[teamIndex]
    /** @type {{ login?: string }[]} */
    let members
    try {
      members = /** @type {{ login?: string }[]} */ (await fetchGithubApiPaginatedArray(
        apiContext,
        '/orgs/' + encodeURIComponent(repoContext.org) + '/teams/' + encodeURIComponent(team.slug) + '/members'
      ))
    } catch (error) {
      warnings.push('Could not list members for team ' + team.slug + ': ' + context.formatCommandError(error))
      continue
    }

    for (const member of members) {
      const login = normalizeGithubLogin(typeof member.login === 'string' ? member.login : '')
      if (!login) continue
      if (relevantLogins.size > 0 && !relevantLogins.has(login)) continue
      const teamEntry = {
        team: '@' + repoContext.org + '/' + team.slug,
        slug: team.slug,
        name: team.name,
      }
      const existing = userTeams.get(login) || []
      existing.push(teamEntry)
      userTeams.set(login, existing)
    }
    if (
      teams.length >= TEAM_LOOKUP_PROGRESS_INTERVAL &&
      (
        (teamIndex + 1) % TEAM_LOOKUP_PROGRESS_INTERVAL === 0 ||
        teamIndex + 1 === teams.length
      )
    ) {
      context.progress(
        'Team membership lookup progress: %d/%d teams processed.',
        teamIndex + 1,
        teams.length
      )
    }
  }

  return {
    source,
    warnings,
    userTeams,
  }
}

/**
 * Normalize a user-provided team ignore token.
 * Accepts "slug", "org/slug", or "@org/slug".
 * @param {string} value
 * @returns {string}
 */
function normalizeTeamIgnoreToken (value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/^\/+|\/+$/g, '')
}

/**
 * Create a matcher for ignored team slugs/handles.
 * Tokens can be "slug", "org/slug", or "@org/slug".
 * @param {string} org
 * @param {string[]} ignoredTeams
 * @returns {(teamSlug: string) => boolean}
 */
function createTeamIgnoreMatcher (org, ignoredTeams) {
  const orgLower = String(org || '').trim().toLowerCase()
  const ignoredSlugs = new Set()
  const ignoredHandles = new Set()

  for (const rawToken of ignoredTeams || []) {
    const token = normalizeTeamIgnoreToken(rawToken)
    if (!token) continue

    const separatorIndex = token.lastIndexOf('/')
    if (separatorIndex === -1) {
      ignoredSlugs.add(token)
      continue
    }

    const tokenOrg = token.slice(0, separatorIndex)
    const slug = token.slice(separatorIndex + 1)
    if (!slug) continue

    ignoredHandles.add(tokenOrg + '/' + slug)
    if (!orgLower || tokenOrg === orgLower) {
      ignoredSlugs.add(slug)
    }
  }

  return (teamSlug) => {
    const slug = normalizeTeamIgnoreToken(teamSlug)
    if (!slug) return false
    if (ignoredSlugs.has(slug)) return true
    if (orgLower && ignoredHandles.has(orgLower + '/' + slug)) return true
    return false
  }
}

/**
 * Execute a git command and return stdout.
 * @param {string[]} args
 * @param {string} [cwd]
 * @returns {string}
 */
function defaultRunGitCommand (args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: GIT_COMMAND_MAX_BUFFER,
  })
}

/**
 * Normalize a path to POSIX separators.
 * @param {string} value
 * @returns {string}
 */
function defaultToPosixPath (value) {
  return value.split(path.sep).join('/')
}

/**
 * Get a readable message from an error.
 * @param {unknown} error
 * @returns {string}
 */
function defaultFormatCommandError (error) {
  if (error && typeof error === 'object' && 'stderr' in error) {
    const stderr = String(error.stderr || '').trim()
    if (stderr) return stderr
  }

  if (error && typeof error === 'object' && 'message' in error) {
    return String(error.message)
  }

  return String(error)
}

module.exports = {
  collectDirectoryTeamSuggestions,
  normalizeTeamIgnoreToken,
}
