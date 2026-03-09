import { findMatchingOwners } from './codeowners-parser.js'
import { directoryAncestors } from './paths.js'
import { resolveRepoDisplayName } from './repository.js'
import { TEAM_SUGGESTIONS_DEFAULT_WINDOW_DAYS } from './cli-args.js'

export const FILE_ANALYSIS_PROGRESS_INTERVAL = 20000

/**
 * Build the report payload consumed by the HTML page.
 * @param {string} repoRoot
 * @param {string[]} files
 * @param {{
 *   path: string,
 *   rules: {
 *     pattern: string,
 *     owners: string[],
 *     matches: (repoPath: string) => boolean
 *   }[]
 * }} codeownersDescriptor
 * @param {{
 *   includeUntracked: boolean,
 *   teamSuggestions?: boolean,
 *   teamSuggestionsIgnoreTeams?: string[],
 *   githubToken?: string,
 *   teamSuggestionsWindowDays?: number
 * }} options
 * @param {(message: string, ...values: any[]) => void} progress
 * @returns {{
 *   repoName: string,
 *   generatedAt: string,
 *   options: { includeUntracked: boolean, teamSuggestionsEnabled: boolean },
 *   totals: { files: number, owned: number, unowned: number, coverage: number },
 *   codeownersFiles: { path: string, rules: number }[],
 *   directories: { path: string, total: number, owned: number, unowned: number, coverage: number }[],
 *   unownedFiles: string[],
 *   teamOwnership: { team: string, total: number, files: string[] }[],
 *   codeownersValidationMeta: {
 *     discoveryWarnings: {
 *       path: string,
 *       type: 'unused-supported-location'|'unsupported-location',
 *       referencePath?: string,
 *       message: string
 *     }[],
 *     discoveryWarningCount: number,
 *     missingPathWarnings: {
 *       codeownersPath: string,
 *       pattern: string,
 *       owners: string[],
 *       history?: {
 *         addedAt: string,
 *         commitSha: string,
 *         commitUrl?: string
 *       }
 *     }[],
 *     missingPathWarningCount: number
 *   },
 *   directoryTeamSuggestions: {
 *     path: string,
 *     status: string,
 *     totalEdits: number,
 *     resolvedLoginEdits: number,
 *     mappedEdits: number,
 *     coverageRatio: number,
 *     candidates: { team: string, slug: string, name: string, score: number, share: number }[],
 *     reason?: string
 *   }[],
 *   directoryTeamSuggestionsMeta: {
 *     enabled: boolean,
 *     org: string|null,
 *     source: 'repo-teams'|'org-teams'|'none',
 *     ignoredTeams: string[],
 *     tokenSource: string,
 *     windowDays: number,
 *     warnings: string[]
 *   }
 * }}
 */
export function buildReport (repoRoot, files, codeownersDescriptor, options, progress = () => {}) {
  /** @type {Map<string, { total: number, owned: number, unowned: number }>} */
  const directoryStats = new Map()
  /** @type {string[]} */
  const unownedFiles = []
  /** @type {Map<string, { team: string, files: string[] }>} */
  const teamOwnership = new Map()

  let owned = 0
  let unowned = 0

  for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
    const filePath = files[fileIndex]
    const owners = findMatchingOwners(filePath, codeownersDescriptor.rules)
    const isOwned = Array.isArray(owners) && owners.length > 0
    const teamOwners = collectTeamOwners(owners)

    if (isOwned) {
      owned++
      for (const team of teamOwners) {
        const teamEntry = teamOwnership.get(team.toLowerCase())
        if (teamEntry) {
          teamEntry.files.push(filePath)
        } else {
          teamOwnership.set(team.toLowerCase(), { team, files: [filePath] })
        }
      }
    } else {
      unowned++
      unownedFiles.push(filePath)
    }

    updateStats(directoryStats, '', isOwned)

    for (const dirPath of directoryAncestors(filePath)) {
      updateStats(directoryStats, dirPath, isOwned)
    }

    if (
      files.length >= FILE_ANALYSIS_PROGRESS_INTERVAL &&
      (
        (fileIndex + 1) % FILE_ANALYSIS_PROGRESS_INTERVAL === 0 ||
        fileIndex + 1 === files.length
      )
    ) {
      progress(
        'Coverage scan progress: %d/%d files processed.',
        fileIndex + 1,
        files.length
      )
    }
  }

  const totals = {
    files: files.length,
    owned,
    unowned,
    coverage: toPercent(owned, files.length),
  }

  const directories = mapToRows(directoryStats).sort(compareRows)
  unownedFiles.sort((first, second) => first.localeCompare(second))
  const teamOwnershipRows = Array.from(teamOwnership.values())
    .map((entry) => {
      entry.files.sort((first, second) => first.localeCompare(second))
      return {
        team: entry.team,
        total: entry.files.length,
        files: entry.files,
      }
    })
    .sort((first, second) => {
      if (first.total !== second.total) return second.total - first.total
      return first.team.localeCompare(second.team)
    })

  return {
    repoName: resolveRepoDisplayName(repoRoot),
    generatedAt: new Date().toISOString(),
    options: {
      includeUntracked: options.includeUntracked,
      teamSuggestionsEnabled: Boolean(options.teamSuggestions),
    },
    totals,
    codeownersFiles: [{
      path: codeownersDescriptor.path,
      rules: codeownersDescriptor.rules.length,
    }],
    directories,
    unownedFiles,
    teamOwnership: teamOwnershipRows,
    codeownersValidationMeta: {
      discoveryWarnings: [],
      discoveryWarningCount: 0,
      missingPathWarnings: [],
      missingPathWarningCount: 0,
    },
    directoryTeamSuggestions: [],
    directoryTeamSuggestionsMeta: {
      enabled: Boolean(options.teamSuggestions),
      org: null,
      source: 'none',
      ignoredTeams: options.teamSuggestionsIgnoreTeams || [],
      tokenSource: options.githubToken ? 'cli' : 'unresolved',
      windowDays: options.teamSuggestionsWindowDays || TEAM_SUGGESTIONS_DEFAULT_WINDOW_DAYS,
      warnings: [],
    },
  }
}

/**
 * Collect unique CODEOWNERS entries that look like GitHub teams.
 * Team owners are expected in the form "@org/slug".
 * @param {string[]|undefined} owners
 * @returns {string[]}
 */
function collectTeamOwners (owners) {
  if (!Array.isArray(owners) || owners.length === 0) return []

  /** @type {Map<string, string>} */
  const unique = new Map()
  for (const owner of owners) {
    if (!looksLikeTeamOwner(owner)) continue
    const normalized = owner.trim()
    unique.set(normalized.toLowerCase(), normalized)
  }
  return Array.from(unique.values())
}

/**
 * Determine whether a CODEOWNERS owner token is a team.
 * @param {unknown} owner
 * @returns {boolean}
 */
function looksLikeTeamOwner (owner) {
  if (typeof owner !== 'string') return false
  return /^@[^/\s]+\/[^/\s]+$/.test(owner.trim())
}

/**
 * Update aggregate stats for a key.
 * @param {Map<string, { total: number, owned: number, unowned: number }>} statsMap
 * @param {string} key
 * @param {boolean} isOwned
 * @returns {void}
 */
function updateStats (statsMap, key, isOwned) {
  const existing = statsMap.get(key) || { total: 0, owned: 0, unowned: 0 }
  existing.total++
  if (isOwned) {
    existing.owned++
  } else {
    existing.unowned++
  }
  statsMap.set(key, existing)
}

/**
 * Convert aggregate map entries to sorted rows.
 * @param {Map<string, { total: number, owned: number, unowned: number }>} statsMap
 * @returns {{ path: string, total: number, owned: number, unowned: number, coverage: number }[]}
 */
function mapToRows (statsMap) {
  const rows = []
  for (const [entryPath, stats] of statsMap.entries()) {
    rows.push({
      path: entryPath || '(root)',
      total: stats.total,
      owned: stats.owned,
      unowned: stats.unowned,
      coverage: toPercent(stats.owned, stats.total),
    })
  }
  return rows
}

/**
 * Compare rows by unowned count, then total count, then path.
 * @param {{ unowned: number, total: number, path: string }} first
 * @param {{ unowned: number, total: number, path: string }} second
 * @returns {number}
 */
function compareRows (first, second) {
  if (first.unowned !== second.unowned) return second.unowned - first.unowned
  if (first.total !== second.total) return second.total - first.total
  return first.path.localeCompare(second.path)
}

/**
 * Convert a ratio to a rounded percent.
 * @param {number} value
 * @param {number} total
 * @returns {number}
 */
function toPercent (value, total) {
  if (!total) return 100
  return Math.round((value / total) * 1000) / 10
}
