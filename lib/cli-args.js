import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseArgs as nodeParseArgs } from 'node:util'
import { normalizeTeamIgnoreToken } from './team-suggestions.js'

const DEFAULT_OUTPUT_FILE_NAME = 'codeowners-gaps-report.html'
const DEFAULT_OUTPUT_PATH = path.join(tmpdir(), 'codeowners-audit', DEFAULT_OUTPUT_FILE_NAME)
export const UPLOAD_PROVIDER = 'zenbin'
export const TEAM_SUGGESTIONS_DEFAULT_WINDOW_DAYS = 365
export const TEAM_SUGGESTIONS_DEFAULT_TOP = 3
export const GITHUB_API_BASE_URL = 'https://api.github.com'

/** @type {import('node:util').ParseArgsConfig['options']} */
const OPTIONS_CONFIG = {
  output: { type: 'string', short: 'o' },
  'output-dir': { type: 'string' },
  cwd: { type: 'string' },
  'include-untracked': { type: 'boolean', default: false },
  'no-report': { type: 'boolean', default: false },
  'list-unowned': { type: 'boolean', default: false },
  'fail-on-unowned': { type: 'boolean', default: false },
  'fail-on-oversized-codeowners': { type: 'boolean', default: false },
  'fail-on-missing-paths': { type: 'boolean', default: false },
  'validate-github-owners': { type: 'boolean', default: false },
  'fail-on-invalid-owners': { type: 'boolean', default: false },
  'fail-on-missing-directory-slashes': { type: 'boolean', default: false },
  'fail-on-location-warnings': { type: 'boolean', default: false },
  'fail-on-fragile-coverage': { type: 'boolean', default: false },
  glob: { type: 'string', short: 'g', multiple: true },
  'suggest-teams': { type: 'boolean', default: false },
  'suggest-window-days': { type: 'string' },
  'suggest-top': { type: 'string' },
  'suggest-ignore-teams': { type: 'string', multiple: true },
  'github-org': { type: 'string' },
  'github-token': { type: 'string' },
  'github-api-base-url': { type: 'string' },
  upload: { type: 'boolean', default: false },
  yes: { type: 'boolean', short: 'y', default: false },
  'no-open': { type: 'boolean', default: false },
  verbose: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
  version: { type: 'boolean', short: 'v', default: false },
}

/**
 * Parse command-line arguments.
 * @param {string[]} args
 * @returns {{
 *   repoOrPath?: string,
 *   outputPath: string,
 *   workingDir: string|null,
 *   includeUntracked: boolean,
 *   noReport: boolean,
 *   listUnowned: boolean,
 *   failOnUnowned: boolean,
 *   failOnOversizedCodeowners: boolean,
 *   failOnMissingPaths: boolean,
 *   validateGithubOwners: boolean,
 *   failOnInvalidOwners: boolean,
 *   failOnMissingDirectorySlashes: boolean,
 *   failOnLocationWarnings: boolean,
 *   failOnFragileCoverage: boolean,
 *   checkGlobs: string[],
 *   teamSuggestions: boolean,
 *   teamSuggestionsWindowDays: number,
 *   teamSuggestionsTop: number,
 *   teamSuggestionsIgnoreTeams: string[],
 *   githubOrg: string|null,
 *   githubToken?: string,
 *   githubApiBaseUrl: string,
 *   upload: boolean,
 *   yes: boolean,
 *   open: boolean,
 *   verbose: boolean,
 *   help: boolean,
 *   version: boolean
 * }}
 */
export function parseArgs (args) {
  /** @type {Record<string, any>} */
  let values
  /** @type {string[]} */
  let positionals

  try {
    ({ values, positionals } = nodeParseArgs({
      args,
      options: OPTIONS_CONFIG,
      allowPositionals: true,
      strict: true,
    }))
  } catch (err) {
    // When --help is present, tolerate unknown/malformed arguments
    if (args.includes('--help') || args.includes('-h')) {
      return helpResult(args)
    }
    const nodeErr = /** @type {NodeJS.ErrnoException} */ (err)
    if (nodeErr.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
      const optMatch = nodeErr.message.match(/^Unknown option '([^']+)'/)
      throw new Error(`Unknown argument: ${optMatch ? optMatch[1] : nodeErr.message}`)
    }
    if (nodeErr.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') {
      const match = nodeErr.message.match(/--[\w-]+/)
      throw new Error(match ? `Missing value for ${match[0]}.` : nodeErr.message)
    }
    throw err
  }

  const help = /** @type {boolean} */ (values.help)
  if (help) {
    return helpResult(args)
  }

  const outputPathSetExplicitly = 'output' in values
  const outputDirSetExplicitly = 'output-dir' in values
  const workingDirSetExplicitly = 'cwd' in values
  const githubTokenSetExplicitly = 'github-token' in values

  let outputPath = /** @type {string} */ (values.output ?? DEFAULT_OUTPUT_PATH)
  const outputDir = /** @type {string|undefined} */ (values['output-dir'])
  const workingDir = /** @type {string|null} */ (values.cwd ?? null)
  const githubToken = /** @type {string|undefined} */ (values['github-token'])
  const githubOrg = /** @type {string|null} */ (values['github-org'] ?? null)
  const githubApiBaseUrl = /** @type {string} */ (values['github-api-base-url'] ?? GITHUB_API_BASE_URL)

  const teamSuggestionsWindowDays = values['suggest-window-days'] !== undefined
    ? parseNumberOption(values['suggest-window-days'], '--suggest-window-days')
    : TEAM_SUGGESTIONS_DEFAULT_WINDOW_DAYS

  const teamSuggestionsTop = values['suggest-top'] !== undefined
    ? parseNumberOption(values['suggest-top'], '--suggest-top')
    : TEAM_SUGGESTIONS_DEFAULT_TOP

  const rawIgnoreTeams = /** @type {string[]|undefined} */ (values['suggest-ignore-teams'])
  let teamSuggestionsIgnoreTeams = rawIgnoreTeams
    ? rawIgnoreTeams.flatMap((v) => parseCsvListOption(v, '--suggest-ignore-teams'))
    : []

  const rawGlobs = /** @type {string[]|undefined} */ (values.glob)
  let checkGlobs = rawGlobs
    ? rawGlobs.map((v) => parseGlobOption(v, '--glob'))
    : []

  const repoOrPath = positionals[0]

  // --- validation ---

  if (!outputPath) {
    throw new Error('Missing value for --output.')
  }

  if (outputDirSetExplicitly) {
    if (!outputDir) {
      throw new Error('Missing value for --output-dir.')
    }
    outputPath = outputPathSetExplicitly
      ? (path.isAbsolute(outputPath) ? outputPath : path.join(outputDir, outputPath))
      : path.join(outputDir, DEFAULT_OUTPUT_FILE_NAME)
  }

  if (workingDirSetExplicitly && !workingDir) {
    throw new Error('Missing value for --cwd.')
  }

  if (repoOrPath !== undefined && workingDirSetExplicitly) {
    throw new Error('Cannot specify both a positional <repo-or-path> argument and --cwd.')
  }

  if (teamSuggestionsWindowDays < 1) {
    throw new Error('--suggest-window-days must be >= 1.')
  }

  if (teamSuggestionsTop < 1) {
    throw new Error('--suggest-top must be >= 1.')
  }

  if (githubOrg !== null && !githubOrg) {
    throw new Error('Missing value for --github-org.')
  }

  if (githubTokenSetExplicitly && !githubToken) {
    throw new Error('Missing value for --github-token.')
  }

  if (!githubApiBaseUrl) {
    throw new Error('Missing value for --github-api-base-url.')
  }

  if (!isValidHttpUrl(githubApiBaseUrl)) {
    throw new Error(`Invalid value for --github-api-base-url: ${JSON.stringify(githubApiBaseUrl)}`)
  }

  teamSuggestionsIgnoreTeams = dedupeStrings(
    teamSuggestionsIgnoreTeams
      .map(normalizeTeamIgnoreToken)
      .filter(Boolean)
  )
  checkGlobs = dedupeStrings(checkGlobs)
  if (checkGlobs.length === 0) {
    checkGlobs = ['**']
  }

  return {
    repoOrPath,
    outputPath,
    workingDir,
    includeUntracked: /** @type {boolean} */ (values['include-untracked']),
    noReport: /** @type {boolean} */ (values['no-report']),
    listUnowned: /** @type {boolean} */ (values['list-unowned']),
    failOnUnowned: /** @type {boolean} */ (values['fail-on-unowned']),
    failOnOversizedCodeowners: /** @type {boolean} */ (values['fail-on-oversized-codeowners']),
    failOnMissingPaths: /** @type {boolean} */ (values['fail-on-missing-paths']),
    validateGithubOwners: /** @type {boolean} */ (values['validate-github-owners']),
    failOnInvalidOwners: /** @type {boolean} */ (values['fail-on-invalid-owners']),
    failOnMissingDirectorySlashes: /** @type {boolean} */ (values['fail-on-missing-directory-slashes']),
    failOnLocationWarnings: /** @type {boolean} */ (values['fail-on-location-warnings']),
    failOnFragileCoverage: /** @type {boolean} */ (values['fail-on-fragile-coverage']),
    checkGlobs,
    teamSuggestions: /** @type {boolean} */ (values['suggest-teams']),
    teamSuggestionsWindowDays,
    teamSuggestionsTop,
    teamSuggestionsIgnoreTeams,
    githubOrg,
    githubToken,
    githubApiBaseUrl,
    upload: /** @type {boolean} */ (values.upload),
    yes: /** @type {boolean} */ (values.yes),
    open: !values['no-open'],
    verbose: /** @type {boolean} */ (values.verbose),
    help: false,
    version: /** @type {boolean} */ (values.version),
  }
}

/**
 * Build a minimal result when --help is present, skipping all validation.
 * @param {string[]} args
 */
function helpResult (args) {
  // Best-effort parse in non-strict mode to extract --version if present
  let version = false
  try {
    const { values: loose } = nodeParseArgs({
      args,
      options: OPTIONS_CONFIG,
      allowPositionals: true,
      strict: false,
    })
    version = /** @type {boolean} */ (loose.version ?? false)
  } catch {
    // ignore
  }

  return {
    repoOrPath: undefined,
    outputPath: DEFAULT_OUTPUT_PATH,
    workingDir: null,
    includeUntracked: false,
    noReport: false,
    listUnowned: false,
    failOnUnowned: false,
    failOnOversizedCodeowners: false,
    failOnMissingPaths: false,
    validateGithubOwners: false,
    failOnInvalidOwners: false,
    failOnMissingDirectorySlashes: false,
    failOnLocationWarnings: false,
    failOnFragileCoverage: false,
    checkGlobs: /** @type {string[]} */ (['**']),
    teamSuggestions: false,
    teamSuggestionsWindowDays: TEAM_SUGGESTIONS_DEFAULT_WINDOW_DAYS,
    teamSuggestionsTop: TEAM_SUGGESTIONS_DEFAULT_TOP,
    teamSuggestionsIgnoreTeams: /** @type {string[]} */ ([]),
    githubOrg: null,
    githubToken: undefined,
    githubApiBaseUrl: GITHUB_API_BASE_URL,
    upload: false,
    yes: false,
    open: true,
    verbose: false,
    help: true,
    version,
  }
}

/**
 * Print CLI usage text to stdout.
 */
export function printUsage () {
  /** @type {Array<[string, string]>} */
  const argumentRows = [
    ['[repo-or-path]', 'Repository URL, GitHub shorthand (owner/repo), or path to a local directory (default: cwd)'],
  ]

  /** @type {Array<{ heading: string, rows: Array<[string, string]> }>} */
  const optionGroups = [
    {
      heading: 'Input and scope:',
      rows: [
        ['--cwd <dir>', 'Run git commands from this directory'],
        ['--include-untracked', 'Include untracked files in the analysis'],
        ['-g, --glob <pattern>', 'Repeatable file filter for report and check scope (default: **)'],
      ],
    },
    {
      heading: 'Report output:',
      rows: [
        ['-o, --output <path>', 'Output HTML file path'],
        ['--output-dir <dir>', 'Output directory for the generated HTML report'],
        ['--no-report', 'Skip HTML report generation (implies --list-unowned)'],
        ['--upload', `Upload to ${UPLOAD_PROVIDER} and print a public URL`],
      ],
    },
    {
      heading: 'Interaction and diagnostics:',
      rows: [
        ['--no-open', 'Do not prompt to open the report in your browser'],
        ['-y, --yes', 'Automatically answer yes to interactive prompts'],
        ['--verbose', 'Enable verbose progress output'],
        ['-h, --help', 'Show this help'],
        ['-v, --version', 'Show version'],
      ],
    },
    {
      heading: 'Core coverage checks:',
      rows: [
        ['--list-unowned', 'Print unowned file paths to stdout'],
        ['--fail-on-unowned', 'Exit non-zero when one or more files are unowned'],
      ],
    },
    {
      heading: 'GitHub validation and policy checks:',
      rows: [
        ['--fail-on-oversized-codeowners', 'Exit non-zero when the active CODEOWNERS file exceeds GitHub\'s 3 MB limit'],
        ['--fail-on-missing-paths', 'Exit non-zero when CODEOWNERS paths match no files'],
        ['--validate-github-owners', 'Validate @username and @org/team owners against GitHub and use that for coverage'],
        ['--fail-on-invalid-owners', 'Exit non-zero when CODEOWNERS rules contain invalid GitHub owners'],
        ['--fail-on-missing-directory-slashes', 'Exit non-zero when directory CODEOWNERS paths omit a trailing slash'],
        ['--fail-on-location-warnings', 'Exit non-zero when extra or ignored CODEOWNERS files are found'],
        ['--fail-on-fragile-coverage', 'Exit non-zero when directories have fragile file-by-file coverage'],
      ],
    },
    {
      heading: 'Team suggestions:',
      rows: [
        ['--suggest-teams', 'Suggest @org/team for uncovered directories'],
        ['--suggest-window-days <days>', `Git history lookback window for suggestions (default: ${TEAM_SUGGESTIONS_DEFAULT_WINDOW_DAYS})`],
        ['--suggest-top <n>', `Top team suggestions to keep per directory (default: ${TEAM_SUGGESTIONS_DEFAULT_TOP})`],
        ['--suggest-ignore-teams <list>', 'Comma-separated team slugs or @org/slug entries to exclude from suggestions'],
        ['--github-org <org>', 'Override GitHub org for team lookups'],
        ['--github-token <token>', 'GitHub token for team lookups (falls back to GITHUB_TOKEN, then GH_TOKEN)'],
        ['--github-api-base-url <url>', `GitHub API base URL (default: ${GITHUB_API_BASE_URL})`],
      ],
    },
  ]

  console.log(
    [
      'Usage: codeowners-audit [repo-or-path] [options]',
      '',
      'Arguments:',
      ...formatUsageRows(argumentRows),
      '',
      'Options:',
      ...formatUsageGroups(optionGroups),
    ].join('\n')
  )
}

/**
 * Render grouped CLI options into aligned help text rows.
 * @param {Array<{ heading: string, rows: Array<[string, string]> }>} optionGroups
 * @returns {string[]}
 */
function formatUsageGroups (optionGroups) {
  const lines = []

  for (let index = 0; index < optionGroups.length; index++) {
    const group = optionGroups[index]
    if (index > 0) {
      lines.push('')
    }
    lines.push(`  ${group.heading}`)
    lines.push(...formatUsageRows(group.rows))
  }

  return lines
}

/**
 * Render CLI rows into aligned help text.
 * @param {Array<[string, string]>} rows
 * @returns {string[]}
 */
function formatUsageRows (rows) {
  const leftPadding = '  '
  const descriptionColumn = 35
  const descriptionPaddingWidth = descriptionColumn - 1
  const lines = []

  for (const [label, description] of rows) {
    const optionLine = leftPadding + label

    if (optionLine.length >= descriptionPaddingWidth) {
      lines.push(optionLine)
      lines.push(' '.repeat(descriptionPaddingWidth) + description)
      continue
    }

    lines.push(optionLine + ' '.repeat(descriptionPaddingWidth - optionLine.length) + description)
  }

  return lines
}

/**
 * Parse and validate an integer option.
 * @param {string|undefined} value
 * @param {string} optionName
 * @returns {number}
 */
function parseNumberOption (value, optionName) {
  if (!value) {
    throw new Error(`Missing value for ${optionName}.`)
  }
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric value for ${optionName}: ${JSON.stringify(value)}`)
  }
  return parsed
}

/**
 * Parse and validate a glob option.
 * @param {string|undefined} value
 * @param {string} optionName
 * @returns {string}
 */
function parseGlobOption (value, optionName) {
  if (!value) {
    throw new Error(`Missing value for ${optionName}.`)
  }
  const normalized = String(value).trim()
  if (!normalized) {
    throw new Error(`Missing value for ${optionName}.`)
  }
  return normalized
}

/**
 * Parse a comma-separated option into non-empty entries.
 * @param {string|undefined} value
 * @param {string} optionName
 * @returns {string[]}
 */
function parseCsvListOption (value, optionName) {
  if (!value) {
    throw new Error(`Missing value for ${optionName}.`)
  }
  const items = String(value)
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
  if (items.length === 0) {
    throw new Error(`Missing value for ${optionName}.`)
  }
  return items
}

/**
 * Return unique strings preserving insertion order.
 * @param {string[]} items
 * @returns {string[]}
 */
function dedupeStrings (items) {
  return Array.from(new Set(items))
}

/**
 * Check whether a value is a valid HTTP(S) URL.
 * @param {string} value
 * @returns {boolean}
 */
function isValidHttpUrl (value) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}
