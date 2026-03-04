#!/usr/bin/env node
/* eslint-disable no-console */

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createProgressLogger } from './lib/progress.js'
import {
  collectDirectoryTeamSuggestions,
  normalizeTeamIgnoreToken,
} from './lib/team-suggestions.js'

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
const packageVersion = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version
const REPORT_TEMPLATE_PATH = new URL('./report.template.html', import.meta.url)
const REPORT_DATA_PLACEHOLDER = '__REPORT_DATA_JSON__'
const REPORT_HTML_TEMPLATE = readFileSync(REPORT_TEMPLATE_PATH, 'utf8')

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

  return REPORT_HTML_TEMPLATE.replace(REPORT_DATA_PLACEHOLDER, serializedReport)
}
