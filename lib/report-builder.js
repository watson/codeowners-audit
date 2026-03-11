import { findMatchingOwners } from './codeowners-parser.js'
import { directoryAncestors } from './paths.js'
import { resolveRepoDisplayName } from './repository.js'
import { TEAM_SUGGESTIONS_DEFAULT_WINDOW_DAYS } from './cli-args.js'

export const FILE_ANALYSIS_PROGRESS_INTERVAL = 20000

/**
 * Build the report payload consumed by the HTML page.
 * @param {string} repoRoot
 * @param {string[]} files
 * @param {import('./types.js').CodeownersDescriptor} codeownersDescriptor
 * @param {{
 *   includeUntracked: boolean,
 *   teamSuggestions?: boolean,
 *   teamSuggestionsIgnoreTeams?: string[],
 *   githubToken?: string,
 *   teamSuggestionsWindowDays?: number
 * }} options
 * @param {(message: string, ...values: any[]) => void} progress
 * @returns {import('./types.js').ReportData}
 */
export function buildReport (repoRoot, files, codeownersDescriptor, options, progress = () => {}) {
  /** @type {Map<string, { total: number, owned: number, unowned: number }>} */
  const directoryStats = new Map()
  /** @type {string[]} */
  const unownedFiles = []
  /** @type {Map<string, { owner: string, files: string[] }>} */
  const ownerIndex = new Map()

  let owned = 0
  let unowned = 0

  for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
    const filePath = files[fileIndex]
    const owners = findMatchingOwners(filePath, codeownersDescriptor.rules)
    const isOwned = Array.isArray(owners) && owners.length > 0
    const fileOwners = collectOwners(owners)

    if (isOwned) {
      owned++
      for (const owner of fileOwners) {
        const ownerEntry = ownerIndex.get(owner.toLowerCase())
        if (ownerEntry) {
          ownerEntry.files.push(filePath)
        } else {
          ownerIndex.set(owner.toLowerCase(), { owner, files: [filePath] })
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
  const ownerIndexRows = Array.from(ownerIndex.values())
    .map((entry) => {
      entry.files.sort((first, second) => first.localeCompare(second))
      return {
        owner: entry.owner,
        total: entry.files.length,
        files: entry.files,
      }
    })
    .sort((first, second) => {
      if (first.total !== second.total) return second.total - first.total
      return first.owner.localeCompare(second.owner)
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
    ownerIndex: ownerIndexRows,
    codeownersValidationMeta: {
      discoveryWarnings: [],
      discoveryWarningCount: 0,
      oversizedCodeownersWarnings: [],
      oversizedCodeownersWarningCount: 0,
      missingPathWarnings: [],
      missingPathWarningCount: 0,
      invalidOwnerWarnings: [],
      invalidOwnerWarningCount: 0,
      ownerValidationWarnings: [],
      ownerValidationWarningCount: 0,
      missingDirectorySlashWarnings: [],
      missingDirectorySlashWarningCount: 0,
      unprotectedDirectoryWarnings: [],
      unprotectedDirectoryWarningCount: 0,
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
 * Collect unique CODEOWNERS owner entries for the report explorer/index.
 * This includes GitHub owners (`@org/team`, `@username`) and email owners.
 * @param {string[]|undefined} owners
 * @returns {string[]}
 */
function collectOwners (owners) {
  if (!Array.isArray(owners) || owners.length === 0) return []

  /** @type {Map<string, string>} */
  const unique = new Map()
  for (const owner of owners) {
    if (!looksLikeIndexedOwner(owner)) continue
    const normalized = owner.trim()
    unique.set(normalized.toLowerCase(), normalized)
  }
  return Array.from(unique.values())
}

/**
 * Determine whether a CODEOWNERS owner token should be surfaced in the report
 * explorer/index.
 * @param {unknown} owner
 * @returns {boolean}
 */
function looksLikeIndexedOwner (owner) {
  if (typeof owner !== 'string') return false
  const normalized = owner.trim()
  return /^@[^\s]+$/.test(normalized) || /^[^\s@]+@[^\s@]+$/.test(normalized)
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
 * @returns {import('./types.js').DirectoryRow[]}
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
