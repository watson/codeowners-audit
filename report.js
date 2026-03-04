#!/usr/bin/env node
'use strict'

/* eslint-disable no-console */

const { execFileSync } = require('node:child_process')
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { version: packageVersion } = require('./package.json')
const { createProgressLogger } = require('./lib/progress')
const {
  collectDirectoryTeamSuggestions,
  normalizeTeamIgnoreToken,
} = require('./lib/team-suggestions')

const DEFAULT_OUTPUT_FILE_NAME = 'codeowners-gaps-report.html'
const DEFAULT_OUTPUT_PATH = path.join(tmpdir(), 'codeowners-audit', DEFAULT_OUTPUT_FILE_NAME)
const UPLOAD_PROVIDER = 'zenbin'
const ZENBIN_BASE_URL = 'https://zenbin.org'
const ZENBIN_MAX_UPLOAD_BYTES = 1024 * 1024
const GIT_COMMAND_MAX_BUFFER = 64 * 1024 * 1024
const TEAM_SUGGESTIONS_DEFAULT_WINDOW_DAYS = 365
const TEAM_SUGGESTIONS_DEFAULT_TOP = 3
const TEAM_SUGGESTIONS_TOKEN_ENV_DEFAULT = 'GITHUB_TOKEN'
const GITHUB_API_BASE_URL = 'https://api.github.com'
const FILE_ANALYSIS_PROGRESS_INTERVAL = 20000
const EXIT_CODE_UNCOVERED = 1
const EXIT_CODE_RUNTIME_ERROR = 2

main()

/**
 * Run the report generation flow.
 * @returns {Promise<void>}
 */
async function main () {
  try {
    const options = parseArgs(process.argv.slice(2))

    if (options.version) {
      console.log(packageVersion)
      return
    }

    if (options.help) {
      printUsage()
      return
    }

    const commandWorkingDir = options.workingDir ? path.resolve(options.workingDir) : process.cwd()
    const repoRoot = runGitCommand(['rev-parse', '--show-toplevel'], commandWorkingDir).trim()

    const allRepoFiles = listRepoFiles(options.includeUntracked, repoRoot)
    const codeownersFilePaths = allRepoFiles.filter(isCodeownersFile)

    if (codeownersFilePaths.length === 0) {
      throw new Error('No CODEOWNERS files found in this repository.')
    }

    const codeownersDescriptors = codeownersFilePaths
      .map(codeownersPath => loadCodeownersDescriptor(repoRoot, codeownersPath))
      .sort(compareCodeownersDescriptor)

    if (options.checkOnly) {
      runOwnershipCheck(repoRoot, allRepoFiles, codeownersDescriptors, options)
      return
    }

    const outputAbsolutePath = path.resolve(repoRoot, options.outputPath)
    const outputRelativePath = toPosixPath(path.relative(repoRoot, outputAbsolutePath))
    const filesToAnalyze = allRepoFiles.filter(filePath => filePath !== outputRelativePath)
    const progress = createProgressLogger(options.teamSuggestions || filesToAnalyze.length >= FILE_ANALYSIS_PROGRESS_INTERVAL)
    progress('Scanning %d files against CODEOWNERS rules...', filesToAnalyze.length)
    const report = buildReport(repoRoot, filesToAnalyze, codeownersDescriptors, options, progress)
    progress(
      'Coverage analysis complete: %d files, %d owned, %d unowned.',
      report.totals.files,
      report.totals.owned,
      report.totals.unowned
    )
    if (options.teamSuggestions) {
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
    const html = renderHtml(report)

    mkdirSync(path.dirname(outputAbsolutePath), { recursive: true })
    writeFileSync(outputAbsolutePath, html, 'utf8')

    console.log(
      'Wrote CODEOWNERS gap report to %s (%d analyzed files, %d unowned).',
      outputAbsolutePath,
      report.totals.files,
      report.totals.unowned
    )

    /** @type {string} */
    let reportLocation = outputAbsolutePath
    if (options.upload) {
      const uploadUrl = uploadReport(outputAbsolutePath)
      reportLocation = uploadUrl
      console.log('Uploaded report (%s): %s', UPLOAD_PROVIDER, uploadUrl)
    }

    if (options.open) {
      try {
        openReportInBrowser(reportLocation)
        console.log('Opened report in browser: %s', reportLocation)
      } catch (error) {
        console.warn(
          'Could not open report in browser (%s). Re-run with --no-open to disable automatic opening.',
          formatCommandError(error)
        )
      }
    }
  } catch (error) {
    console.error('Failed to generate CODEOWNERS gap report:')
    console.error(String(error && error.stack ? error.stack : error))
    process.exit(EXIT_CODE_RUNTIME_ERROR)
  }
}

/**
 * Parse command-line arguments.
 * @param {string[]} args
 * @returns {{
 *   outputPath: string,
 *   workingDir: string|null,
 *   includeUntracked: boolean,
 *   checkOnly: boolean,
 *   checkGlob: string,
 *   teamSuggestions: boolean,
 *   teamSuggestionsWindowDays: number,
 *   teamSuggestionsTop: number,
 *   teamSuggestionsIgnoreTeams: string[],
 *   githubOrg: string|null,
 *   githubTokenEnv: string,
 *   githubApiBaseUrl: string,
 *   upload: boolean,
 *   open: boolean,
 *   help: boolean,
 *   version: boolean
 * }}
 */
function parseArgs (args) {
  let outputPath = DEFAULT_OUTPUT_PATH
  let outputPathSetExplicitly = false
  let outputDir = null
  let outputDirSetExplicitly = false
  let workingDir = null
  let workingDirSetExplicitly = false
  let includeUntracked = false
  let checkOnly = false
  let checkGlob = '**'
  let teamSuggestions = false
  let teamSuggestionsWindowDays = TEAM_SUGGESTIONS_DEFAULT_WINDOW_DAYS
  let teamSuggestionsTop = TEAM_SUGGESTIONS_DEFAULT_TOP
  /** @type {string[]} */
  let teamSuggestionsIgnoreTeams = []
  let githubOrg = null
  let githubTokenEnv = TEAM_SUGGESTIONS_TOKEN_ENV_DEFAULT
  let githubApiBaseUrl = GITHUB_API_BASE_URL
  let upload = false
  let open = true
  let help = false
  let version = false

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--output' || arg === '-o') {
      outputPath = args[index + 1]
      outputPathSetExplicitly = true
      index++
      continue
    }

    if (arg.startsWith('--output=')) {
      outputPath = arg.slice('--output='.length)
      outputPathSetExplicitly = true
      continue
    }

    if (arg === '--output-dir') {
      outputDir = args[index + 1]
      outputDirSetExplicitly = true
      index++
      continue
    }

    if (arg.startsWith('--output-dir=')) {
      outputDir = arg.slice('--output-dir='.length)
      outputDirSetExplicitly = true
      continue
    }

    if (arg === '--working-dir' || arg === '--cwd' || arg === '-C') {
      workingDir = args[index + 1]
      workingDirSetExplicitly = true
      index++
      continue
    }

    if (arg.startsWith('--working-dir=')) {
      workingDir = arg.slice('--working-dir='.length)
      workingDirSetExplicitly = true
      continue
    }

    if (arg.startsWith('--cwd=')) {
      workingDir = arg.slice('--cwd='.length)
      workingDirSetExplicitly = true
      continue
    }

    if (arg.startsWith('-C=')) {
      workingDir = arg.slice('-C='.length)
      workingDirSetExplicitly = true
      continue
    }

    if (arg === '--include-untracked') {
      includeUntracked = true
      continue
    }

    if (arg === '--team-suggestions') {
      teamSuggestions = true
      continue
    }

    if (arg === '--team-suggestions-window-days') {
      teamSuggestionsWindowDays = parseNumberOption(args[index + 1], '--team-suggestions-window-days')
      index++
      continue
    }

    if (arg.startsWith('--team-suggestions-window-days=')) {
      teamSuggestionsWindowDays = parseNumberOption(
        arg.slice('--team-suggestions-window-days='.length),
        '--team-suggestions-window-days'
      )
      continue
    }

    if (arg === '--team-suggestions-top') {
      teamSuggestionsTop = parseNumberOption(args[index + 1], '--team-suggestions-top')
      index++
      continue
    }

    if (arg.startsWith('--team-suggestions-top=')) {
      teamSuggestionsTop = parseNumberOption(arg.slice('--team-suggestions-top='.length), '--team-suggestions-top')
      continue
    }

    if (arg === '--team-suggestions-ignore-teams') {
      teamSuggestionsIgnoreTeams = teamSuggestionsIgnoreTeams.concat(
        parseCsvListOption(args[index + 1], '--team-suggestions-ignore-teams')
      )
      index++
      continue
    }

    if (arg.startsWith('--team-suggestions-ignore-teams=')) {
      teamSuggestionsIgnoreTeams = teamSuggestionsIgnoreTeams.concat(
        parseCsvListOption(
          arg.slice('--team-suggestions-ignore-teams='.length),
          '--team-suggestions-ignore-teams'
        )
      )
      continue
    }

    if (arg === '--github-org') {
      githubOrg = args[index + 1]
      index++
      continue
    }

    if (arg.startsWith('--github-org=')) {
      githubOrg = arg.slice('--github-org='.length)
      continue
    }

    if (arg === '--github-token-env') {
      githubTokenEnv = args[index + 1]
      index++
      continue
    }

    if (arg.startsWith('--github-token-env=')) {
      githubTokenEnv = arg.slice('--github-token-env='.length)
      continue
    }

    if (arg === '--github-api-base-url') {
      githubApiBaseUrl = args[index + 1]
      index++
      continue
    }

    if (arg.startsWith('--github-api-base-url=')) {
      githubApiBaseUrl = arg.slice('--github-api-base-url='.length)
      continue
    }

    if (arg === '--check') {
      checkOnly = true
      if (args[index + 1] && !args[index + 1].startsWith('-')) {
        checkGlob = args[index + 1]
        index++
      }
      continue
    }

    if (arg.startsWith('--check=')) {
      checkOnly = true
      checkGlob = arg.slice('--check='.length)
      continue
    }

    if (arg === '--upload') {
      upload = true
      continue
    }

    if (arg === '--no-open') {
      open = false
      continue
    }

    if (arg === '--help' || arg === '-h') {
      help = true
      continue
    }

    if (arg === '--version' || arg === '-v') {
      version = true
      continue
    }

    throw new Error('Unknown argument: ' + arg)
  }

  if (!help && !outputPath) {
    throw new Error('Missing value for --output.')
  }

  if (!help && outputDirSetExplicitly) {
    if (!outputDir) {
      throw new Error('Missing value for --output-dir.')
    }

    outputPath = outputPathSetExplicitly
      ? (path.isAbsolute(outputPath) ? outputPath : path.join(outputDir, outputPath))
      : path.join(outputDir, DEFAULT_OUTPUT_FILE_NAME)
  }

  if (!help && workingDirSetExplicitly && !workingDir) {
    throw new Error('Missing value for --working-dir.')
  }

  if (!help && checkOnly && !checkGlob) {
    throw new Error('Missing value for --check.')
  }

  if (!help && teamSuggestionsWindowDays < 1) {
    throw new Error('--team-suggestions-window-days must be >= 1.')
  }

  if (!help && teamSuggestionsTop < 1) {
    throw new Error('--team-suggestions-top must be >= 1.')
  }

  if (!help && githubOrg !== null && !githubOrg) {
    throw new Error('Missing value for --github-org.')
  }

  if (!help && !githubTokenEnv) {
    throw new Error('Missing value for --github-token-env.')
  }

  if (!help && !githubApiBaseUrl) {
    throw new Error('Missing value for --github-api-base-url.')
  }

  if (!help && !isValidHttpUrl(githubApiBaseUrl)) {
    throw new Error('Invalid value for --github-api-base-url: ' + JSON.stringify(githubApiBaseUrl))
  }

  teamSuggestionsIgnoreTeams = dedupeStrings(
    teamSuggestionsIgnoreTeams
      .map(normalizeTeamIgnoreToken)
      .filter(Boolean)
  )

  return {
    outputPath,
    workingDir,
    includeUntracked,
    checkOnly,
    checkGlob,
    teamSuggestions,
    teamSuggestionsWindowDays,
    teamSuggestionsTop,
    teamSuggestionsIgnoreTeams,
    githubOrg,
    githubTokenEnv,
    githubApiBaseUrl,
    upload,
    open,
    help,
    version,
  }
}

/**
 * Print command usage.
 * @returns {void}
 */
function printUsage () {
  console.log(
    [
      'Usage: codeowners-audit [options]',
      '',
      'Options:',
      '  -o, --output <path>     Output HTML file path (default: ' + DEFAULT_OUTPUT_PATH + ')',
      '      --output-dir <dir>  Output directory for the generated HTML report',
      '  -C, --working-dir <dir> Run git commands from this directory (alias: --cwd)',
      '      --include-untracked Include untracked files in the analysis',
      '      --check[=<glob>]    CLI-only ownership check (default glob: **)',
      '      --team-suggestions  Suggest @org/team for uncovered directories',
      '      --team-suggestions-window-days <days>  Git history lookback window for suggestions (default: ' + TEAM_SUGGESTIONS_DEFAULT_WINDOW_DAYS + ')',
      '      --team-suggestions-top <n>  Top team suggestions to keep per directory (default: ' + TEAM_SUGGESTIONS_DEFAULT_TOP + ')',
      '      --team-suggestions-ignore-teams <list>  Comma-separated team slugs or @org/slug entries to exclude from suggestions',
      '      --github-org <org>  Override GitHub org for team lookups',
      '      --github-token-env <name>  Env var containing GitHub token (default: ' + TEAM_SUGGESTIONS_TOKEN_ENV_DEFAULT + '; falls back to GH_TOKEN)',
      '      --github-api-base-url <url>  GitHub API base URL (default: ' + GITHUB_API_BASE_URL + ')',
      '      --upload            Upload to ' + UPLOAD_PROVIDER + ' and print a public URL',
      '      --no-open           Do not open the report in your browser',
      '  -h, --help              Show this help',
      '  -v, --version           Show version',
    ].join('\n')
  )
}

/**
 * Parse and validate an integer option.
 * @param {string|undefined} value
 * @param {string} optionName
 * @returns {number}
 */
function parseNumberOption (value, optionName) {
  if (!value) {
    throw new Error('Missing value for ' + optionName + '.')
  }
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) {
    throw new Error('Invalid numeric value for ' + optionName + ': ' + JSON.stringify(value))
  }
  return parsed
}

/**
 * Parse a comma-separated option into non-empty entries.
 * @param {string|undefined} value
 * @param {string} optionName
 * @returns {string[]}
 */
function parseCsvListOption (value, optionName) {
  if (!value) {
    throw new Error('Missing value for ' + optionName + '.')
  }
  const items = String(value)
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
  if (items.length === 0) {
    throw new Error('Missing value for ' + optionName + '.')
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

/**
 * Open a report target in the system browser.
 * @param {string} target
 * @returns {void}
 */
function openReportInBrowser (target) {
  if (process.platform === 'darwin') {
    execFileSync('open', [target], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    return
  }

  if (process.platform === 'win32') {
    execFileSync('cmd', ['/c', 'start', '', target], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    return
  }

  execFileSync('xdg-open', [target], {
    stdio: ['ignore', 'ignore', 'pipe'],
  })
}

/**
 * Run CLI-only CODEOWNERS ownership check.
 * Exit code 1 means uncovered files; runtime/setup errors use exit code 2.
 * @param {string} repoRoot
 * @param {string[]} files
 * @param {{
 *   path: string,
 *   dir: string,
 *   rules: {
 *     pattern: string,
 *     owners: string[],
 *     matches: (scopePath: string, repoPath: string) => boolean
 *   }[]
 * }[]} codeownersDescriptors
 * @param {{
 *   includeUntracked: boolean,
 *   checkGlob: string
 * }} options
 * @returns {void}
 */
function runOwnershipCheck (repoRoot, files, codeownersDescriptors, options) {
  const checkGlobMatcher = createCliGlobMatcher(options.checkGlob)
  const filesToAnalyze = files.filter(filePath => checkGlobMatcher(filePath))
  const progress = createProgressLogger(filesToAnalyze.length >= FILE_ANALYSIS_PROGRESS_INTERVAL)
  progress('Running --check on %d files...', filesToAnalyze.length)
  const report = buildReport(repoRoot, filesToAnalyze, codeownersDescriptors, options, progress)

  if (report.unownedFiles.length > 0) {
    console.error(
      'CODEOWNERS check failed for glob %s (%d analyzed files, %d unowned):',
      JSON.stringify(options.checkGlob),
      report.totals.files,
      report.totals.unowned
    )
    for (const filePath of report.unownedFiles) {
      console.error('  - %s', filePath)
    }
    process.exitCode = EXIT_CODE_UNCOVERED
    return
  }

  console.log(
    'CODEOWNERS check passed for glob %s (%d analyzed files, %d unowned).',
    JSON.stringify(options.checkGlob),
    report.totals.files,
    report.totals.unowned
  )
}

/**
 * Get a readable message from a child-process error.
 * @param {unknown} error
 * @returns {string}
 */
function formatCommandError (error) {
  if (error && typeof error === 'object' && 'stderr' in error) {
    const stderr = String(error.stderr || '').trim()
    if (stderr) return stderr
  }

  if (error && typeof error === 'object' && 'message' in error) {
    return String(error.message)
  }

  return String(error)
}

/**
 * Build a file matcher for CLI check globs.
 * @param {string} pattern
 * @returns {(filePath: string) => boolean}
 */
function createCliGlobMatcher (pattern) {
  const matches = createPatternMatcher(pattern)
  return (filePath) => matches(filePath, filePath)
}

/**
 * Upload the generated HTML report.
 * @param {string} reportPath
 * @returns {string}
 */
function uploadReport (reportPath) {
  return uploadToZenbin(reportPath)
}

/**
 * Upload a file to ZenBin and return the public URL.
 * @param {string} filePath
 * @returns {string}
 */
function uploadToZenbin (filePath) {
  const fileBaseName = path.basename(filePath, path.extname(filePath))
  const pageId = createZenbinPageId(fileBaseName)
  const payload = JSON.stringify({ html: readFileSync(filePath, 'utf8') })
  const payloadBytes = Buffer.byteLength(payload, 'utf8')

  if (payloadBytes >= ZENBIN_MAX_UPLOAD_BYTES) {
    throw new Error(
      'Upload failed (' + UPLOAD_PROVIDER + '): report is too large for ZenBin (' +
      formatBytes(payloadBytes) + ' payload; limit is about ' + formatBytes(ZENBIN_MAX_UPLOAD_BYTES) + '). ' +
      'Re-run without --upload and share the generated HTML file directly.'
    )
  }

  let stdout
  try {
    stdout = execFileSync('curl', [
      '--silent',
      '--show-error',
      '--fail',
      '-X',
      'POST',
      '-H',
      'Content-Type: application/json',
      '--data-binary',
      '@-',
      ZENBIN_BASE_URL + '/v1/pages/' + pageId,
    ], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      input: payload,
    })
  } catch (error) {
    const stderr = error && typeof error === 'object' && 'stderr' in error
      ? String(error.stderr || '').trim()
      : ''
    const likelyTooLargeHint = /returned error:\s*400\b/i.test(stderr)
      ? ' (ZenBin may reject payloads near 1 MiB; current payload is ' + formatBytes(payloadBytes) + ')'
      : ''
    throw new Error('Upload failed (' + UPLOAD_PROVIDER + '): ' + (stderr || String(error)) + likelyTooLargeHint)
  }

  /** @type {{ url?: string }} */
  let response
  try {
    response = JSON.parse(String(stdout))
  } catch {
    throw new Error(
      'Upload failed (' + UPLOAD_PROVIDER + '): invalid JSON response: ' + JSON.stringify(String(stdout).trim())
    )
  }

  const maybeUrl = response && typeof response.url === 'string' ? response.url.trim() : ''
  if (!/^https?:\/\//.test(maybeUrl)) {
    throw new Error('Upload failed (' + UPLOAD_PROVIDER + '): missing URL in response: ' + JSON.stringify(response))
  }

  return maybeUrl
}

/**
 * Format bytes as an integer KiB value.
 * @param {number} byteCount
 * @returns {string}
 */
function formatBytes (byteCount) {
  return Math.ceil(byteCount / 1024) + ' KiB'
}

/**
 * Build a stable-ish unique page id for ZenBin uploads.
 * @param {string} fileBaseName
 * @returns {string}
 */
function createZenbinPageId (fileBaseName) {
  const normalizedBase = fileBaseName
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, 40)

  const base = normalizedBase || 'report'
  const timestamp = Date.now().toString(36)
  const randomPart = Math.random().toString(36).slice(2, 8)
  return base + '-' + timestamp + '-' + randomPart
}

/**
 * Execute a git command and return stdout.
 * @param {string[]} args
 * @param {string} [cwd]
 * @returns {string}
 */
function runGitCommand (args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: GIT_COMMAND_MAX_BUFFER,
  })
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
 * Determine if a path points to a CODEOWNERS file.
 * @param {string} filePath
 * @returns {boolean}
 */
function isCodeownersFile (filePath) {
  return path.posix.basename(filePath) === 'CODEOWNERS'
}

/**
 * Resolve the scope base for a CODEOWNERS file.
 * GitHub treats top-level CODEOWNERS files in root, .github/, and docs/
 * as repository-wide files.
 * @param {string} codeownersPath
 * @returns {string}
 */
function resolveCodeownersScopeBase (codeownersPath) {
  if (
    codeownersPath === 'CODEOWNERS' ||
    codeownersPath === '.github/CODEOWNERS' ||
    codeownersPath === 'docs/CODEOWNERS'
  ) {
    return ''
  }

  const codeownersDir = path.posix.dirname(codeownersPath)
  return codeownersDir === '.' ? '' : codeownersDir
}

/**
 * Normalize a path to POSIX separators.
 * @param {string} value
 * @returns {string}
 */
function toPosixPath (value) {
  return value.split(path.sep).join('/')
}

/**
 * Load a CODEOWNERS descriptor with parsed rules.
 * @param {string} repoRoot
 * @param {string} codeownersPath
 * @returns {{
 *   path: string,
 *   dir: string,
 *   rules: {
 *     pattern: string,
 *     owners: string[],
 *     matches: (scopePath: string, repoPath: string) => boolean
 *   }[]
 * }}
 */
function loadCodeownersDescriptor (repoRoot, codeownersPath) {
  const descriptorDir = resolveCodeownersScopeBase(codeownersPath)
  const fileContent = readFileSync(path.join(repoRoot, codeownersPath), 'utf8')
  const rules = parseCodeowners(fileContent)

  return {
    path: codeownersPath,
    dir: descriptorDir,
    rules,
  }
}

/**
 * Parse CODEOWNERS content into rule matchers.
 * @param {string} fileContent
 * @returns {{ pattern: string, owners: string[], matches: (scopePath: string, repoPath: string) => boolean }[]}
 */
function parseCodeowners (fileContent) {
  const lines = fileContent.split(/\r?\n/)
  const rules = []

  for (const line of lines) {
    const withoutComment = stripInlineComment(line).trim()
    if (!withoutComment) continue

    const tokens = tokenizeCodeownersLine(withoutComment).map(unescapeToken)
    if (tokens.length < 2) continue

    const pattern = tokens[0]
    const owners = tokens.slice(1).filter(Boolean)
    if (!owners.length) continue
    if (pattern.startsWith('!')) continue // Negation is not supported in CODEOWNERS.

    rules.push({
      pattern,
      owners,
      matches: createPatternMatcher(pattern, { includeDescendants: true }),
    })
  }

  return rules
}

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
 * Build a matcher for a CODEOWNERS pattern.
 * @param {string} rawPattern
 * @returns {(scopePath: string, repoPath: string) => boolean}
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
    const anchoredRegex = new RegExp('^' + patternSource + descendantSuffix + '$')
    return (scopePath) => anchoredRegex.test(scopePath)
  }

  const unanchoredRegex = new RegExp('(?:^|/)' + patternSource + descendantSuffix + '$')
  return (scopePath, repoPath) => unanchoredRegex.test(scopePath) || unanchoredRegex.test(repoPath)
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
 * Escape regex-special characters.
 * @param {string} char
 * @returns {string}
 */
function escapeRegexChar (char) {
  return /[\\^$.*+?()[\]{}|]/.test(char) ? '\\' + char : char
}

/**
 * Sort CODEOWNERS files from broadest to narrowest scope.
 * @param {{ dir: string, path: string }} first
 * @param {{ dir: string, path: string }} second
 * @returns {number}
 */
function compareCodeownersDescriptor (first, second) {
  const firstDepth = first.dir ? first.dir.split('/').length : 0
  const secondDepth = second.dir ? second.dir.split('/').length : 0
  if (firstDepth !== secondDepth) return firstDepth - secondDepth
  return first.path.localeCompare(second.path)
}

/**
 * Build the report payload consumed by the HTML page.
 * @param {string} repoRoot
 * @param {string[]} files
 * @param {{
 *   path: string,
 *   dir: string,
 *   rules: {
 *     pattern: string,
 *     owners: string[],
 *     matches: (scopePath: string, repoPath: string) => boolean
 *   }[]
 * }[]} codeownersDescriptors
 * @param {{
 *   includeUntracked: boolean,
 *   teamSuggestions?: boolean,
 *   teamSuggestionsIgnoreTeams?: string[],
 *   githubTokenEnv?: string,
 *   teamSuggestionsWindowDays?: number
 * }} options
 * @param {(message: string, ...values: any[]) => void} progress
 * @returns {{
 *   repoName: string,
 *   generatedAt: string,
 *   options: { includeUntracked: boolean, teamSuggestionsEnabled: boolean },
 *   totals: { files: number, owned: number, unowned: number, coverage: number },
 *   codeownersFiles: { path: string, dir: string, rules: number }[],
 *   topLevel: { path: string, total: number, owned: number, unowned: number, coverage: number }[],
 *   directories: { path: string, total: number, owned: number, unowned: number, coverage: number }[],
 *   unownedFiles: string[],
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
 *     tokenEnv: string,
 *     windowDays: number,
 *     warnings: string[]
 *   }
 * }}
 */
function buildReport (repoRoot, files, codeownersDescriptors, options, progress = () => {}) {
  /** @type {Map<string, { total: number, owned: number, unowned: number }>} */
  const topLevelStats = new Map()
  /** @type {Map<string, { total: number, owned: number, unowned: number }>} */
  const directoryStats = new Map()
  /** @type {string[]} */
  const unownedFiles = []

  let owned = 0
  let unowned = 0

  for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
    const filePath = files[fileIndex]
    const owners = resolveOwners(filePath, codeownersDescriptors)
    const isOwned = Array.isArray(owners) && owners.length > 0

    if (isOwned) {
      owned++
    } else {
      unowned++
      unownedFiles.push(filePath)
    }

    updateStats(topLevelStats, topLevelPath(filePath), isOwned)
    updateStats(directoryStats, '', isOwned)

    const segments = filePath.split('/')
    let currentPath = ''
    for (let index = 0; index < segments.length - 1; index++) {
      currentPath = currentPath ? currentPath + '/' + segments[index] : segments[index]
      updateStats(directoryStats, currentPath, isOwned)
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

  const topLevel = mapToRows(topLevelStats).sort(compareRows)
  const directories = mapToRows(directoryStats).sort(compareRows)
  unownedFiles.sort((first, second) => first.localeCompare(second))

  return {
    repoName: path.basename(repoRoot),
    generatedAt: new Date().toISOString(),
    options: {
      includeUntracked: options.includeUntracked,
      teamSuggestionsEnabled: Boolean(options.teamSuggestions),
    },
    totals,
    codeownersFiles: codeownersDescriptors.map((descriptor) => {
      return {
        path: descriptor.path,
        dir: descriptor.dir || '.',
        rules: descriptor.rules.length,
      }
    }),
    topLevel,
    directories,
    unownedFiles,
    directoryTeamSuggestions: [],
    directoryTeamSuggestionsMeta: {
      enabled: Boolean(options.teamSuggestions),
      org: null,
      source: 'none',
      ignoredTeams: options.teamSuggestionsIgnoreTeams || [],
      tokenEnv: options.githubTokenEnv || TEAM_SUGGESTIONS_TOKEN_ENV_DEFAULT,
      windowDays: options.teamSuggestionsWindowDays || TEAM_SUGGESTIONS_DEFAULT_WINDOW_DAYS,
      warnings: [],
    },
  }
}

/**
 * Resolve matching owners for a file by applying CODEOWNERS files from broad to narrow.
 * @param {string} filePath
 * @param {{
 *   dir: string,
 *   rules: {
 *     owners: string[],
 *     matches: (scopePath: string, repoPath: string) => boolean
 *   }[]
 * }[]} codeownersDescriptors
 * @returns {string[]|undefined}
 */
function resolveOwners (filePath, codeownersDescriptors) {
  /** @type {string[]|undefined} */
  let owners

  for (const descriptor of codeownersDescriptors) {
    if (descriptor.dir && !pathIsInside(filePath, descriptor.dir)) continue

    const scopePath = descriptor.dir ? filePath.slice(descriptor.dir.length + 1) : filePath
    const matchedOwners = findMatchingOwners(scopePath, filePath, descriptor.rules)
    if (matchedOwners) {
      owners = matchedOwners
    }
  }

  return owners
}

/**
 * Check whether filePath is inside dirPath (POSIX relative paths).
 * @param {string} filePath
 * @param {string} dirPath
 * @returns {boolean}
 */
function pathIsInside (filePath, dirPath) {
  return filePath === dirPath || filePath.startsWith(dirPath + '/')
}

/**
 * Find the last matching owners in a ruleset.
 * @param {string} scopePath
 * @param {string} repoPath
 * @param {{ owners: string[], matches: (scopePath: string, repoPath: string) => boolean }[]} rules
 * @returns {string[]|undefined}
 */
function findMatchingOwners (scopePath, repoPath, rules) {
  /** @type {string[]|undefined} */
  let owners
  for (const rule of rules) {
    if (rule.matches(scopePath, repoPath)) {
      owners = rule.owners
    }
  }
  return owners
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
 * Convert top-level map entries to sorted rows.
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
 * Extract a file's top-level directory key.
 * @param {string} filePath
 * @returns {string}
 */
function topLevelPath (filePath) {
  const slashIndex = filePath.indexOf('/')
  return slashIndex === -1 ? '(root)' : filePath.slice(0, slashIndex)
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

/**
 * Render a complete self-contained HTML page for the report.
 * @param {{
 *   repoName: string,
 *   generatedAt: string,
 *   options: { includeUntracked: boolean, teamSuggestionsEnabled: boolean },
 *   totals: { files: number, owned: number, unowned: number, coverage: number },
 *   codeownersFiles: { path: string, dir: string, rules: number }[],
 *   topLevel: { path: string, total: number, owned: number, unowned: number, coverage: number }[],
 *   directories: { path: string, total: number, owned: number, unowned: number, coverage: number }[],
 *   unownedFiles: string[],
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
 *     tokenEnv: string,
 *     windowDays: number,
 *     warnings: string[]
 *   }
 * }} report
 * @returns {string}
 */
function renderHtml (report) {
  const serializedReport = JSON.stringify(report).replaceAll('<', String.raw`\u003c`)

  return String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CODEOWNERS Gap Report</title>
  <style>
    :root {
      --bg: #0b1020;
      --panel: #141b34;
      --panel-2: #1b2448;
      --text: #e4e7f2;
      --muted: #96a0c6;
      --good: #2dd4bf;
      --bad: #fb7185;
      --accent: #8b5cf6;
      --border: #2a3568;
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 28px;
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
      background: radial-gradient(circle at top right, #1a2142 0%, var(--bg) 55%);
      color: var(--text);
      min-height: 100vh;
    }

    h1, h2, h3 { margin: 0; }
    p { margin: 0; color: var(--muted); }

    .container {
      max-width: 1400px;
      margin: 0 auto;
      display: grid;
      gap: 18px;
    }

    .panel {
      background: linear-gradient(180deg, var(--panel) 0%, var(--panel-2) 100%);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 16px;
      box-shadow: 0 14px 30px rgba(0, 0, 0, 0.35);
    }

    .header {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 16px;
      flex-wrap: wrap;
    }

    .summary-grid {
      display: grid;
      gap: 12px;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      margin-top: 12px;
    }

    .metric {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.07);
      border-radius: 12px;
      padding: 12px;
    }

    .metric .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; }
    .metric .value { font-size: 28px; font-weight: 700; margin-top: 3px; }
    .metric .value.bad { color: var(--bad); }
    .metric .value.good { color: var(--good); }

    .coverage-track {
      margin-top: 12px;
      width: 100%;
      height: 14px;
      background: #0b1127;
      border-radius: 999px;
      overflow: hidden;
      border: 1px solid rgba(255, 255, 255, 0.1);
      display: flex;
    }

    .coverage-owned { background: linear-gradient(90deg, #14b8a6, #2dd4bf); height: 100%; }
    .coverage-unowned { background: linear-gradient(90deg, #f43f5e, #fb7185); height: 100%; }

    .row-list { display: grid; gap: 10px; margin-top: 12px; }
    .row {
      padding: 10px 12px;
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.08);
    }
    .row.selected {
      border-color: rgba(139, 92, 246, 0.85);
      box-shadow: 0 0 0 1px rgba(139, 92, 246, 0.35) inset;
    }
    .row-header {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: center;
      margin-bottom: 8px;
      font-size: 14px;
    }
    .path { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
    .path-button {
      background: transparent;
      border: 0;
      color: var(--text);
      font: inherit;
      padding: 0;
      text-align: left;
      cursor: pointer;
      text-decoration: underline;
      text-decoration-color: rgba(139, 92, 246, 0.55);
      text-decoration-thickness: 1px;
      text-underline-offset: 2px;
    }
    .path-button:hover { color: #c4b5fd; }
    .path-button[disabled] {
      cursor: default;
      opacity: 0.75;
      color: var(--muted);
      text-decoration: none;
    }
    .path-button[disabled]:hover {
      color: var(--muted);
    }
    .path-button[disabled]::after {
      content: ' (leaf)';
      font-size: 11px;
      opacity: 0.9;
    }
    .pill {
      font-size: 12px;
      padding: 2px 8px;
      border-radius: 999px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      color: var(--muted);
    }
    .breadcrumbs {
      display: flex;
      gap: 6px;
      align-items: center;
      color: var(--muted);
      font-size: 13px;
      min-height: 28px;
      flex-wrap: wrap;
    }
    .breadcrumbs .sep { opacity: 0.6; }
    .ghost-button {
      background: #0e1530;
      border: 1px solid var(--border);
      color: var(--text);
      border-radius: 8px;
      padding: 6px 10px;
      cursor: pointer;
      font-size: 13px;
    }
    .ghost-button[disabled] {
      opacity: 0.5;
      cursor: default;
    }

    .controls {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      align-items: center;
      margin-bottom: 12px;
    }
    .controls input[type="text"] {
      min-width: 280px;
      flex: 1;
      background: #0e1530;
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 8px 10px;
      outline: none;
    }
    .controls label { color: var(--muted); display: flex; gap: 8px; align-items: center; font-size: 14px; }
    .suggestion-muted { color: var(--muted); }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    thead th {
      text-align: left;
      color: var(--muted);
      border-bottom: 1px solid var(--border);
      padding: 8px;
      white-space: nowrap;
      cursor: pointer;
      user-select: none;
    }
    tbody td {
      padding: 8px;
      border-bottom: 1px dashed rgba(255, 255, 255, 0.08);
      vertical-align: top;
    }
    .dir-bar {
      width: 100%;
      min-width: 180px;
      height: 10px;
      border-radius: 999px;
      overflow: hidden;
      background: #0b1127;
      border: 1px solid rgba(255, 255, 255, 0.08);
      display: flex;
    }
    .dir-bar .owned { background: rgba(45, 212, 191, 0.85); }
    .dir-bar .unowned { background: rgba(251, 113, 133, 0.9); }

    .muted { color: var(--muted); }
    .file-list {
      max-height: 380px;
      overflow: auto;
      border: 1px solid var(--border);
      border-radius: 10px;
      background: rgba(0, 0, 0, 0.2);
      padding: 10px;
      line-height: 1.5;
      font-size: 12px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      white-space: pre;
    }

    @media (max-width: 900px) {
      body { padding: 14px; }
      .header { align-items: flex-start; }
      .controls input[type="text"] { min-width: 100%; }
    }
  </style>
</head>
<body>
  <div class="container">
    <section class="panel">
      <div class="header">
        <div>
          <h1>CODEOWNERS Gap Report</h1>
          <p id="subtitle"></p>
        </div>
        <div class="pill" id="generatedAt"></div>
      </div>
      <div class="summary-grid">
        <div class="metric"><div class="label">Files Scanned</div><div class="value" id="metric-files">0</div></div>
        <div class="metric"><div class="label">Owned</div><div class="value good" id="metric-owned">0</div></div>
        <div class="metric"><div class="label">Unowned</div><div class="value bad" id="metric-unowned">0</div></div>
        <div class="metric"><div class="label">Coverage</div><div class="value" id="metric-coverage">0%</div></div>
      </div>
      <div class="coverage-track" aria-label="Coverage">
        <div class="coverage-owned" id="coverage-owned"></div>
        <div class="coverage-unowned" id="coverage-unowned"></div>
      </div>
    </section>

    <section class="panel">
      <div class="header">
        <h2>Top-Level Hotspots</h2>
        <p class="muted" id="top-level-subtitle">Scope: (root) — direct subdirectories with missing coverage</p>
      </div>
      <div class="row-list" id="top-level-list"></div>
    </section>

    <section class="panel">
      <div class="header">
        <h2>Directory Explorer</h2>
        <p class="muted">Filter and sort to find ownership gaps quickly</p>
      </div>
      <div class="controls">
        <div class="breadcrumbs" id="dir-breadcrumbs"></div>
        <button class="ghost-button" id="dir-up" type="button">Up</button>
        <button class="ghost-button" id="dir-reset" type="button">Root</button>
      </div>
      <div class="controls">
        <input id="dir-filter" type="text" placeholder="Filter directories (e.g. packages/dd-trace)" />
        <label><input id="dir-only-gaps" type="checkbox" checked /> only show directories with unowned files</label>
      </div>
      <table>
        <thead>
          <tr>
            <th data-sort="path">Directory</th>
            <th data-sort="unowned">Unowned</th>
            <th data-sort="total">Total</th>
            <th data-sort="coverage">Coverage</th>
            <th>Suggested Team</th>
            <th>Owned vs Unowned</th>
          </tr>
        </thead>
        <tbody id="directory-table-body"></tbody>
      </table>
      <p class="muted" id="directory-count"></p>
    </section>

    <section class="panel">
      <div class="header">
        <h2>Unowned Files</h2>
        <p class="muted">Files with no matching owner rule</p>
      </div>
      <div class="controls">
        <input id="file-filter" type="text" placeholder="Filter unowned files..." />
      </div>
      <div class="file-list" id="unowned-file-list"></div>
      <p class="muted" id="file-count"></p>
    </section>

    <section class="panel">
      <div class="header">
        <h2>Detected CODEOWNERS Files</h2>
      </div>
      <table>
        <thead>
          <tr>
            <th>Path</th>
            <th>Scope Base</th>
            <th>Rules</th>
          </tr>
        </thead>
        <tbody id="codeowners-table-body"></tbody>
      </table>
    </section>
  </div>

  <script type="application/json" id="report-data">${serializedReport}</script>
  <script>
    (function () {
      const report = JSON.parse(document.getElementById('report-data').textContent)

      const fmt = new Intl.NumberFormat('en-US')
      const percent = value => Number(value).toFixed(1) + '%'
      const clamp = value => Math.max(0, Math.min(100, value))
      const scopeQueryParam = 'scope'
      const directoryRows = report.directories.filter(row => row.path !== '(root)')
      const suggestionRows = Array.isArray(report.directoryTeamSuggestions) ? report.directoryTeamSuggestions : []
      const suggestionMeta = report.directoryTeamSuggestionsMeta || { enabled: false, warnings: [] }
      const suggestionByPath = new Map(suggestionRows.map((row) => [row.path, row]))
      const directoryRowByPath = new Map()
      const childrenByParent = new Map()
      const knownScopes = new Set()
      for (const row of directoryRows) {
        directoryRowByPath.set(row.path, row)
        knownScopes.add(row.path)
        const parent = parentPath(row.path)
        if (!childrenByParent.has(parent)) {
          childrenByParent.set(parent, [])
        }
        childrenByParent.get(parent).push(row)
      }
      directoryRowByPath.set('(root)', report.directories.find(row => row.path === '(root)'))
      let selectedPath = readScopeFromLocation()
      let directoryController
      let unownedController

      function setScope (nextPath, options) {
        const historyMode = options && options.historyMode ? options.historyMode : 'push'
        const normalizedScope = normalizeScope(nextPath)
        const didChange = selectedPath !== normalizedScope
        selectedPath = normalizedScope

        const scrollAnchor = document.getElementById('dir-filter')
        const anchorTopBefore = scrollAnchor ? scrollAnchor.getBoundingClientRect().top : null
        renderTopLevel()
        if (directoryController) directoryController.render()
        if (unownedController) unownedController.render()
        if (scrollAnchor && anchorTopBefore !== null) {
          const anchorTopAfter = scrollAnchor.getBoundingClientRect().top
          const delta = anchorTopAfter - anchorTopBefore
          if (delta !== 0) {
            globalThis.scrollBy(0, delta)
          }
        }

        if (historyMode !== 'none') {
          if (historyMode === 'replace') {
            syncScopeToLocation(selectedPath, true)
          } else if (didChange) {
            syncScopeToLocation(selectedPath, false)
          }
        }
      }

      document.getElementById('subtitle').textContent =
        report.repoName + (report.options.includeUntracked ? ' (tracked + untracked files)' : ' (tracked files)')
      document.getElementById('generatedAt').textContent = 'Generated ' + new Date(report.generatedAt).toLocaleString()
      document.getElementById('metric-files').textContent = fmt.format(report.totals.files)
      document.getElementById('metric-owned').textContent = fmt.format(report.totals.owned)
      document.getElementById('metric-unowned').textContent = fmt.format(report.totals.unowned)
      document.getElementById('metric-coverage').textContent = percent(report.totals.coverage)
      document.getElementById('coverage-owned').style.width = clamp(report.totals.coverage) + '%'
      document.getElementById('coverage-unowned').style.width = clamp(100 - report.totals.coverage) + '%'

      renderTopLevel()
      renderCodeownersFiles(report.codeownersFiles)
      directoryController = setupDirectoryTable(report.directories, suggestionByPath, suggestionMeta, () => selectedPath, setScope)
      unownedController = setupUnownedFiles(report.unownedFiles, () => selectedPath)
      syncScopeToLocation(selectedPath, true)

      globalThis.addEventListener('popstate', () => {
        setScope(readScopeFromLocation(), { historyMode: 'none' })
      })

      function renderTopLevel () {
        const scope = selectedPath
        const scopeKey = scope || '(root)'
        const subtitle = document.getElementById('top-level-subtitle')
        const container = document.getElementById('top-level-list')
        const scopeRow = getDirectScopeStats(scope)
        let rows = directoryRows.filter(row => isDirectChild(row.path, scope) && row.unowned > 0)
        if (scopeRow && scopeRow.unowned > 0) {
          rows.push(scopeRow)
        }
        rows = rows.sort((a, b) => {
          if (a.unowned !== b.unowned) return b.unowned - a.unowned
          if (a.total !== b.total) return b.total - a.total
          return a.path.localeCompare(b.path)
        })

        subtitle.textContent = 'Scope: ' + scopeKey + ' — direct files in current directory plus direct subdirectories with missing coverage'
        container.innerHTML = ''

        if (!rows.length) {
          const empty = document.createElement('div')
          empty.className = 'row'
          empty.textContent = 'No child directories with missing coverage in this scope.'
          container.appendChild(empty)
          return
        }

        for (const row of rows.slice(0, 20)) {
          const wrapper = document.createElement('div')
          wrapper.className = 'row' + (row.path === scopeKey ? ' selected' : '')

          const header = document.createElement('div')
          header.className = 'row-header'

          const isCurrentScopeRow = row.path === scopeKey
          const title = isCurrentScopeRow
            ? document.createElement('span')
            : document.createElement('button')
          title.className = isCurrentScopeRow ? 'path' : 'path path-button'
          title.textContent = isCurrentScopeRow
            ? (scope ? 'Current directory' : 'Root')
            : relativeLabel(row.path, scope)
          if (!isCurrentScopeRow) {
            title.type = 'button'
            title.title = 'Drill into ' + row.path
            title.addEventListener('click', () => setScope(row.path))
          }

          const meta = document.createElement('div')
          meta.className = 'pill'
          meta.textContent = fmt.format(row.unowned) + ' unowned / ' + fmt.format(row.total) +
            (isCurrentScopeRow ? ' direct files' : ' total')

          header.appendChild(title)
          header.appendChild(meta)

          const bar = document.createElement('div')
          bar.className = 'dir-bar'

          const ownedPart = document.createElement('div')
          ownedPart.className = 'owned'
          ownedPart.style.width = clamp(row.coverage) + '%'

          const unownedPart = document.createElement('div')
          unownedPart.className = 'unowned'
          unownedPart.style.width = clamp(100 - row.coverage) + '%'

          bar.appendChild(ownedPart)
          bar.appendChild(unownedPart)

          wrapper.appendChild(header)
          wrapper.appendChild(bar)
          container.appendChild(wrapper)
        }
      }

      function renderCodeownersFiles (rows) {
        const body = document.getElementById('codeowners-table-body')
        body.innerHTML = ''
        for (const row of rows) {
          const tr = document.createElement('tr')
          tr.innerHTML = [
            '<td class="path"></td>',
            '<td class="path"></td>',
            '<td></td>'
          ].join('')
          tr.children[0].textContent = row.path
          tr.children[1].textContent = row.dir
          tr.children[2].textContent = fmt.format(row.rules)
          body.appendChild(tr)
        }
      }

      function setupDirectoryTable (allRows, suggestionLookup, suggestionContext, getScope, onScopeChange) {
        const body = document.getElementById('directory-table-body')
        const count = document.getElementById('directory-count')
        const filterInput = document.getElementById('dir-filter')
        const onlyGaps = document.getElementById('dir-only-gaps')
        const breadcrumbs = document.getElementById('dir-breadcrumbs')
        const upButton = document.getElementById('dir-up')
        const resetButton = document.getElementById('dir-reset')
        const headerCells = Array.from(document.querySelectorAll('th[data-sort]'))
        let sortKey = 'unowned'
        let sortDirection = 'desc'

        for (const headerCell of headerCells) {
          headerCell.addEventListener('click', () => {
            const clickedKey = headerCell.getAttribute('data-sort')
            if (sortKey === clickedKey) {
              sortDirection = sortDirection === 'desc' ? 'asc' : 'desc'
            } else {
              sortKey = clickedKey
              sortDirection = clickedKey === 'path' ? 'asc' : 'desc'
            }
            render()
          })
        }

        filterInput.addEventListener('input', render)
        onlyGaps.addEventListener('change', render)
        upButton.addEventListener('click', () => onScopeChange(parentPath(getScope())))
        resetButton.addEventListener('click', () => onScopeChange(''))

        render()

        function render () {
          const scope = getScope()
          const query = filterInput.value.trim().toLowerCase()
          let rows = allRows.filter(row => {
            if (row.path === '(root)') return false
            if (!isDirectChild(row.path, scope)) return false
            return !onlyGaps.checked || row.unowned > 0
          })
          if (query) {
            rows = rows.filter(row => row.path.toLowerCase().includes(query))
          }

          rows = rows.sort((a, b) => {
            const mult = sortDirection === 'asc' ? 1 : -1
            if (sortKey === 'path') return a.path.localeCompare(b.path) * mult
            return (a[sortKey] - b[sortKey]) * mult || a.path.localeCompare(b.path)
          })

          body.innerHTML = ''
          for (const row of rows.slice(0, 2500)) {
            const tr = document.createElement('tr')
            const bar = '<div class="dir-bar">' +
              '<div class="owned" style="width:' + clamp(row.coverage) + '%"></div>' +
              '<div class="unowned" style="width:' + clamp(100 - row.coverage) + '%"></div>' +
              '</div>'
            tr.innerHTML = [
              '<td class="path"></td>',
              '<td></td>',
              '<td></td>',
              '<td></td>',
              '<td class="path"></td>',
              '<td>' + bar + '</td>'
            ].join('')
            const pathButton = document.createElement('button')
            pathButton.className = 'path path-button'
            pathButton.type = 'button'
            pathButton.textContent = relativeLabel(row.path, scope)
            pathButton.title = 'Drill into ' + row.path
            pathButton.addEventListener('click', () => onScopeChange(row.path))
            tr.children[0].appendChild(pathButton)
            tr.children[1].textContent = fmt.format(row.unowned)
            tr.children[2].textContent = fmt.format(row.total)
            tr.children[3].textContent = percent(row.coverage)
            const suggestion = suggestionLookup.get(row.path)
            const renderedSuggestion = formatSuggestionCell(suggestion, suggestionContext)
            tr.children[4].textContent = renderedSuggestion.label
            tr.children[4].title = renderedSuggestion.title
            if (renderedSuggestion.muted) {
              tr.children[4].classList.add('suggestion-muted')
            } else {
              tr.children[4].classList.remove('suggestion-muted')
            }
            body.appendChild(tr)
          }

          upButton.disabled = !scope
          resetButton.disabled = !scope
          renderBreadcrumbs(scope, breadcrumbs, onScopeChange)
          count.textContent = 'Scope: ' + (scope || '(root)') + ' — showing ' +
            fmt.format(Math.min(rows.length, 2500)) + ' of ' + fmt.format(rows.length) + ' directories.'
        }

        return { render }
      }

      function formatSuggestionCell (suggestion, suggestionContext) {
        if (!suggestionContext || !suggestionContext.enabled) {
          return {
            label: '(disabled)',
            title: 'Enable --team-suggestions to compute team recommendations for uncovered directories.',
            muted: true,
          }
        }
        if (!suggestion) {
          return { label: '-', title: 'No suggestion data for this directory.', muted: true }
        }

        if (suggestion.status === 'ok' && suggestion.candidates.length > 0) {
          const top = suggestion.candidates[0]
          const extraCount = suggestion.candidates.length - 1
          const suffix = extraCount > 0 ? ' +' + extraCount : ''
          const coverageRatio = Number(suggestion.coverageRatio || 0) * 100
          const candidateLines = suggestion.candidates.map((candidate, index) => {
            const sharePercent = Number(candidate.share || 0) * 100
            return (index + 1) + '. ' + candidate.team +
              ' (score ' + fmt.format(candidate.score) + ', ' + sharePercent.toFixed(1) + '%)'
          })
          return {
            label: top.team + suffix,
            title: [
              'Suggestions:',
              ...candidateLines,
              'Mapped edits: ' + suggestion.mappedEdits + '/' + suggestion.totalEdits + ' (' + coverageRatio.toFixed(1) + '%)',
            ].join('\n'),
            muted: false,
          }
        }

        const statusLabels = {
          'no-history': 'No history',
          'no-auth': 'Auth required',
          'insufficient-mapping': 'Unknown authors',
          'no-team-match': 'No team match',
          error: 'Error',
        }
        const label = statusLabels[suggestion.status] || 'Unavailable'
        const titleParts = ['Status: ' + label]
        if (typeof suggestion.totalEdits === 'number') {
          titleParts.push('Observed edits: ' + suggestion.totalEdits)
        }
        if (suggestion.reason) {
          titleParts.push('Reason: ' + suggestion.reason)
        } else if (Array.isArray(suggestionContext.warnings) && suggestionContext.warnings.length > 0) {
          titleParts.push('Warning: ' + suggestionContext.warnings[0])
        }
        return {
          label,
          title: titleParts.join('\n'),
          muted: true,
        }
      }

      function getDirectScopeStats (scope) {
        const scopeKey = scope || '(root)'
        const aggregateRow = directoryRowByPath.get(scopeKey)
        if (!aggregateRow) return null

        let total = aggregateRow.total
        let owned = aggregateRow.owned
        let unowned = aggregateRow.unowned
        const childRows = childrenByParent.get(scope) || []
        for (const child of childRows) {
          total -= child.total
          owned -= child.owned
          unowned -= child.unowned
        }

        const safeTotal = Math.max(0, total)
        const safeOwned = Math.max(0, owned)
        const safeUnowned = Math.max(0, unowned)
        return {
          path: scopeKey,
          total: safeTotal,
          owned: safeOwned,
          unowned: safeUnowned,
          coverage: safeTotal ? Math.round((safeOwned / safeTotal) * 1000) / 10 : 100,
        }
      }

      function setupUnownedFiles (files, getScope) {
        const filterInput = document.getElementById('file-filter')
        const list = document.getElementById('unowned-file-list')
        const count = document.getElementById('file-count')

        filterInput.addEventListener('input', render)
        render()

        function render () {
          const scope = getScope()
          const query = filterInput.value.trim().toLowerCase()
          const scoped = scope ? files.filter(file => file === scope || file.startsWith(scope + '/')) : files
          const filtered = query ? scoped.filter(file => file.toLowerCase().includes(query)) : scoped
          const shown = filtered.slice(0, 6000)
          list.textContent = shown.join('\n') || '(none)'
          count.textContent = 'Scope: ' + (scope || '(root)') + ' — showing ' +
            fmt.format(shown.length) + ' of ' + fmt.format(filtered.length) + ' unowned files.'
        }

        return { render }
      }

      function parentPath (value) {
        if (!value) return ''
        const index = value.lastIndexOf('/')
        return index === -1 ? '' : value.slice(0, index)
      }

      function isDirectChild (childPath, parent) {
        if (!parent) {
          return !childPath.includes('/')
        }
        if (!childPath.startsWith(parent + '/')) return false
        const remainder = childPath.slice(parent.length + 1)
        return remainder.length > 0 && !remainder.includes('/')
      }

      function relativeLabel (value, scope) {
        if (!scope) return value
        return value.slice(scope.length + 1)
      }

      function renderBreadcrumbs (scope, target, onScopeChange) {
        target.innerHTML = ''

        const rootButton = document.createElement('button')
        rootButton.className = 'path-button'
        rootButton.type = 'button'
        rootButton.textContent = report.repoName
        rootButton.addEventListener('click', () => onScopeChange(''))
        target.appendChild(rootButton)

        if (!scope) return

        const parts = scope.split('/')
        let built = ''
        for (const part of parts) {
          const sep = document.createElement('span')
          sep.className = 'sep'
          sep.textContent = '/'
          target.appendChild(sep)

          built = built ? built + '/' + part : part
          const partButton = document.createElement('button')
          partButton.className = 'path-button'
          partButton.type = 'button'
          partButton.textContent = part
          const nextScope = built
          partButton.addEventListener('click', () => onScopeChange(nextScope))
          target.appendChild(partButton)
        }
      }

      function normalizeScope (scope) {
        if (!scope || scope === '(root)') return ''
        const normalized = String(scope).replaceAll(/^\/+|\/+$/g, '')
        if (!normalized) return ''
        return knownScopes.has(normalized) ? normalized : ''
      }

      function readScopeFromLocation () {
        const params = new URLSearchParams(globalThis.location.search)
        return normalizeScope(params.get(scopeQueryParam))
      }

      function syncScopeToLocation (scope, replace) {
        const nextUrl = new URL(globalThis.location.href)
        if (scope) {
          nextUrl.searchParams.set(scopeQueryParam, scope)
        } else {
          nextUrl.searchParams.delete(scopeQueryParam)
        }

        const nextState = { scope }
        if (replace) {
          globalThis.history.replaceState(nextState, '', nextUrl)
        } else {
          globalThis.history.pushState(nextState, '', nextUrl)
        }
      }
    })()
  </script>
</body>
</html>
`
}
