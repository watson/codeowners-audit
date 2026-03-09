/**
 * Shared JSDoc type definitions for codeowners-audit.
 *
 * Import types in other modules via:
 *   @type {import('./types.js').CodeownersRule}
 *
 * @module
 */

/**
 * A parsed CODEOWNERS rule with a compiled matcher function.
 * @typedef {{
 *   pattern: string,
 *   owners: string[],
 *   matches: (repoPath: string) => boolean
 * }} CodeownersRule
 */

/**
 * A CODEOWNERS file descriptor with its path and parsed rules.
 * @typedef {{
 *   path: string,
 *   rules: CodeownersRule[]
 * }} CodeownersDescriptor
 */

/**
 * Metadata about when a CODEOWNERS pattern was first added.
 * @typedef {{
 *   addedAt: string,
 *   commitSha: string,
 *   commitUrl?: string
 * }} PatternHistoryInfo
 */

/**
 * Warning about a CODEOWNERS rule whose pattern matches no repository files.
 * @typedef {{
 *   codeownersPath: string,
 *   pattern: string,
 *   owners: string[],
 *   history?: PatternHistoryInfo
 * }} MissingPathWarning
 */

/**
 * Warning about a CODEOWNERS file in an unexpected or unsupported location.
 * @typedef {{
 *   path: string,
 *   type: 'unused-supported-location'|'unsupported-location',
 *   referencePath?: string,
 *   message: string
 * }} DiscoveryWarning
 */

/**
 * Validation metadata collected during CODEOWNERS analysis.
 * @typedef {{
 *   discoveryWarnings: DiscoveryWarning[],
 *   discoveryWarningCount: number,
 *   missingPathWarnings: MissingPathWarning[],
 *   missingPathWarningCount: number
 * }} CodeownersValidationMeta
 */

/**
 * Aggregate coverage totals for the repository.
 * @typedef {{
 *   files: number,
 *   owned: number,
 *   unowned: number,
 *   coverage: number
 * }} ReportTotals
 */

/**
 * Coverage statistics for a single directory.
 * @typedef {{
 *   path: string,
 *   total: number,
 *   owned: number,
 *   unowned: number,
 *   coverage: number
 * }} DirectoryRow
 */

/**
 * Ownership summary for a single team.
 * @typedef {{
 *   team: string,
 *   total: number,
 *   files: string[]
 * }} TeamOwnershipRow
 */

/**
 * A candidate team for a directory ownership suggestion.
 * @typedef {{
 *   team: string,
 *   slug: string,
 *   name: string,
 *   score: number,
 *   share: number
 * }} TeamCandidate
 */

/**
 * Team suggestion result for a single directory.
 * @typedef {{
 *   path: string,
 *   status: 'ok'|'no-history'|'no-auth'|'insufficient-mapping'|'no-team-match'|'error',
 *   totalEdits: number,
 *   resolvedLoginEdits: number,
 *   mappedEdits: number,
 *   coverageRatio: number,
 *   candidates: TeamCandidate[],
 *   reason?: string
 * }} TeamSuggestionRow
 */

/**
 * Metadata about the team suggestion process.
 * @typedef {{
 *   enabled: boolean,
 *   org: string|null,
 *   source: 'repo-teams'|'org-teams'|'none',
 *   ignoredTeams: string[],
 *   tokenSource: string,
 *   windowDays: number,
 *   warnings: string[]
 * }} TeamSuggestionsMeta
 */

/**
 * The complete report payload consumed by the HTML template.
 * @typedef {{
 *   repoName: string,
 *   generatedAt: string,
 *   options: { includeUntracked: boolean, teamSuggestionsEnabled: boolean },
 *   totals: ReportTotals,
 *   codeownersFiles: { path: string, rules: number }[],
 *   directories: DirectoryRow[],
 *   unownedFiles: string[],
 *   teamOwnership: TeamOwnershipRow[],
 *   codeownersValidationMeta: CodeownersValidationMeta,
 *   directoryTeamSuggestions: TeamSuggestionRow[],
 *   directoryTeamSuggestionsMeta: TeamSuggestionsMeta
 * }} ReportData
 */

export {}
