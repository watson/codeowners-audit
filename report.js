#!/usr/bin/env node
/* eslint-disable no-console */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { createProgressLogger } from './lib/progress.js'
import {
  collectDirectoryTeamSuggestions,
  normalizeTeamIgnoreToken,
} from './lib/team-suggestions.js'

const DEFAULT_OUTPUT_FILE_NAME = 'codeowners-gaps-report.html'
const DEFAULT_OUTPUT_PATH = path.join(tmpdir(), 'codeowners-audit', DEFAULT_OUTPUT_FILE_NAME)
const UPLOAD_PROVIDER = 'zenbin'
const ZENBIN_BASE_URL = process.env.CODEOWNERS_AUDIT_ZENBIN_BASE_URL || 'https://zenbin.org'
const ZENBIN_MAX_UPLOAD_BYTES = 1024 * 1024
const GIT_COMMAND_MAX_BUFFER = 64 * 1024 * 1024
const TEAM_SUGGESTIONS_DEFAULT_WINDOW_DAYS = 365
const TEAM_SUGGESTIONS_DEFAULT_TOP = 3
const GITHUB_API_BASE_URL = 'https://api.github.com'
const FILE_ANALYSIS_PROGRESS_INTERVAL = 20000
const SUPPORTED_CODEOWNERS_PATHS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS']
const SUPPORTED_CODEOWNERS_PATHS_LABEL = SUPPORTED_CODEOWNERS_PATHS.join(', ')
const EXIT_CODE_UNCOVERED = 1
const EXIT_CODE_RUNTIME_ERROR = 2
const ANSI_RESET = '\u001b[0m'
const ANSI_BOLD = '\u001b[1m'
const ANSI_DIM = '\u001b[2m'
const ANSI_RED = '\u001b[31m'
const ANSI_GREEN = '\u001b[32m'
const ANSI_YELLOW = '\u001b[33m'
const ANSI_CYAN = '\u001b[36m'
const packageVersion = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version
const REPORT_TEMPLATE_PATH = new URL('./report.template.html', import.meta.url)
const REPORT_DATA_PLACEHOLDER = '__REPORT_DATA_JSON__'
const REPORT_LOGO_URL_PLACEHOLDER = '__REPORT_LOGO_URL__'
const REPORT_LOGO_URL = `https://raw.githubusercontent.com/watson/codeowners-audit/v${packageVersion}/assets/logo2-small.png`
const REPORT_VERSION_PLACEHOLDER = '__REPORT_VERSION__'
const REPORT_REPO_URL_PLACEHOLDER = '__REPORT_REPO_URL__'
const REPORT_REPO_URL = 'https://github.com/watson/codeowners-audit'
const REPORT_HTML_TEMPLATE = readFileSync(REPORT_TEMPLATE_PATH, 'utf8')

main()

/**
 * Run the report generation flow.
 * @returns {Promise<void>}
 */
async function main () {
  let clonedTempDir = null
  try {
    const options = parseArgs(process.argv.slice(2))
    const interactiveStdin = isInteractiveStdin()

    if (options.version) {
      console.log(packageVersion)
      return
    }

    if (options.help) {
      printUsage()
      return
    }

    if (!interactiveStdin) {
      options.open = false
      options.listUnowned = true
      options.failOnUnowned = true
      console.log('Standard input is non-interactive; defaulting to --no-open --list-unowned --fail-on-unowned.')
    }
    if (options.noReport && options.upload) {
      throw new Error('--no-report cannot be combined with --upload because no HTML report is generated.')
    }
    if (options.noReport) {
      options.open = false
      options.listUnowned = true
    }

    const remoteRepoUrl = options.repoOrPath !== undefined && isRepoUrl(options.repoOrPath)
      ? options.repoOrPath
      : undefined

    if (remoteRepoUrl !== undefined) {
      const cloneUrl = normalizeRepoUrl(remoteRepoUrl)
      const shallow = !options.teamSuggestions

      if (!shallow) {
        console.log('Full repository clone required for --suggest-teams (this may take longer for large repositories).')
        if (interactiveStdin && !options.yes) {
          const confirmed = await promptForFullClone(cloneUrl)
          if (!confirmed) {
            console.log('Clone aborted.')
            return
          }
        }
      }

      clonedTempDir = mkdtempSync(path.join(tmpdir(), 'codeowners-audit-'))
      console.log('Cloning %s...', cloneUrl)
      try {
        const cloneArgs = shallow
          ? ['clone', ...(options.verbose ? [] : ['--quiet']), '--depth', '1', cloneUrl, clonedTempDir]
          : ['clone', ...(options.verbose ? [] : ['--quiet']), cloneUrl, clonedTempDir]
        execFileSync('git', cloneArgs, {
          stdio: ['ignore', 'ignore', options.verbose ? 'inherit' : 'pipe'],
        })
      } catch (cloneError) {
        rmSync(clonedTempDir, { recursive: true, force: true })
        clonedTempDir = null
        throw new Error(`Failed to clone repository: ${cloneUrl}\n${formatCommandError(cloneError)}`)
      }
    }

    let commandWorkingDir
    if (clonedTempDir) {
      commandWorkingDir = clonedTempDir
    } else if (options.repoOrPath !== undefined) {
      commandWorkingDir = path.resolve(options.repoOrPath)
    } else {
      commandWorkingDir = options.workingDir ? path.resolve(options.workingDir) : process.cwd()
    }

    const repoRoot = runGitCommand(['rev-parse', '--show-toplevel'], commandWorkingDir).trim()

    const allRepoFiles = listRepoFiles(options.includeUntracked, repoRoot)
    const discoveredCodeownersPaths = listDiscoveredCodeownersPaths(allRepoFiles)
    const codeownersPath = resolveActiveCodeownersPath(discoveredCodeownersPaths)
    if (!codeownersPath) {
      throw new Error(buildMissingSupportedCodeownersError(discoveredCodeownersPaths))
    }

    const codeownersDescriptor = loadCodeownersDescriptor(repoRoot, codeownersPath)
    const discoveryWarnings = collectCodeownersDiscoveryWarnings(discoveredCodeownersPaths, codeownersPath)
    const repoWebUrl = resolveRepoWebUrl(repoRoot)
    const missingPathHistoryByPattern = collectCodeownersPatternHistory(
      repoRoot,
      codeownersDescriptor,
      repoWebUrl
    )
    const missingPathWarnings = collectMissingCodeownersPathWarnings(
      codeownersDescriptor,
      allRepoFiles,
      missingPathHistoryByPattern
    )

    const scopeFilteredFiles = filterFilesByCliGlobs(allRepoFiles, options.checkGlobs)

    const outputAbsolutePath = clonedTempDir
      ? path.resolve(process.cwd(), options.outputPath)
      : path.resolve(repoRoot, options.outputPath)
    const outputRelativePath = toPosixPath(path.relative(repoRoot, outputAbsolutePath))
    const filesToAnalyze = scopeFilteredFiles.filter(filePath => filePath !== outputRelativePath)
    const progress = createProgressLogger(
      options.verbose && (options.teamSuggestions || filesToAnalyze.length >= FILE_ANALYSIS_PROGRESS_INTERVAL)
    )
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
    if (!options.noReport) {
      const html = renderHtml(report)

      mkdirSync(path.dirname(outputAbsolutePath), { recursive: true })
      writeFileSync(outputAbsolutePath, html, 'utf8')
    }

    outputUnownedReportResults(report, {
      ...options,
      showCoverageSummary: options.noReport || !interactiveStdin,
    })

    if (!options.noReport) {
      /** @type {string} */
      let reportLocation = outputAbsolutePath
      if (options.upload) {
        const uploadUrl = await uploadReport(outputAbsolutePath)
        reportLocation = uploadUrl
        console.log('Uploaded report (%s): %s', UPLOAD_PROVIDER, uploadUrl)
      }

      console.log('Report ready at %s', reportLocation)

      if (options.open) {
        const shouldOpen = options.yes ? true : await promptForReportOpen(reportLocation)
        if (shouldOpen) {
          try {
            openReportInBrowser(reportLocation)
            console.log('Opened report in browser.')
          } catch (error) {
            console.warn(
              'Could not open report in browser (%s). Re-run with --no-open to disable the open prompt.',
              formatCommandError(error)
            )
          }
        }
      }
    }
    if (clonedTempDir) {
      rmSync(clonedTempDir, { recursive: true, force: true })
      clonedTempDir = null
    }
  } catch (error) {
    if (clonedTempDir) {
      rmSync(clonedTempDir, { recursive: true, force: true })
      clonedTempDir = null
    }
    console.error('Failed to generate CODEOWNERS gap report:')
    console.error(String(error && error.stack ? error.stack : error))
    process.exit(EXIT_CODE_RUNTIME_ERROR)
  }
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
 *   failOnMissingPaths: boolean,
 *   failOnLocationWarnings: boolean,
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
function parseArgs (args) {
  /** @type {string|undefined} */
  let repoOrPath
  let outputPath = DEFAULT_OUTPUT_PATH
  let outputPathSetExplicitly = false
  let outputDir = null
  let outputDirSetExplicitly = false
  let workingDir = null
  let workingDirSetExplicitly = false
  let includeUntracked = false
  let noReport = false
  let listUnowned = false
  let failOnUnowned = false
  let failOnMissingPaths = false
  let failOnLocationWarnings = false
  /** @type {string[]} */
  let checkGlobs = []
  let teamSuggestions = false
  let teamSuggestionsWindowDays = TEAM_SUGGESTIONS_DEFAULT_WINDOW_DAYS
  let teamSuggestionsTop = TEAM_SUGGESTIONS_DEFAULT_TOP
  /** @type {string[]} */
  let teamSuggestionsIgnoreTeams = []
  let githubOrg = null
  let githubToken = undefined
  let githubTokenSetExplicitly = false
  let githubApiBaseUrl = GITHUB_API_BASE_URL
  let upload = false
  let yes = false
  let open = true
  let verbose = false
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

    if (arg === '--cwd') {
      workingDir = args[index + 1]
      workingDirSetExplicitly = true
      index++
      continue
    }

    if (arg.startsWith('--cwd=')) {
      workingDir = arg.slice('--cwd='.length)
      workingDirSetExplicitly = true
      continue
    }

    if (arg === '--include-untracked') {
      includeUntracked = true
      continue
    }

    if (arg === '--suggest-teams') {
      teamSuggestions = true
      continue
    }

    if (arg === '--suggest-window-days') {
      teamSuggestionsWindowDays = parseNumberOption(args[index + 1], '--suggest-window-days')
      index++
      continue
    }

    if (arg.startsWith('--suggest-window-days=')) {
      teamSuggestionsWindowDays = parseNumberOption(
        arg.slice('--suggest-window-days='.length),
        '--suggest-window-days'
      )
      continue
    }

    if (arg === '--suggest-top') {
      teamSuggestionsTop = parseNumberOption(args[index + 1], '--suggest-top')
      index++
      continue
    }

    if (arg.startsWith('--suggest-top=')) {
      teamSuggestionsTop = parseNumberOption(arg.slice('--suggest-top='.length), '--suggest-top')
      continue
    }

    if (arg === '--suggest-ignore-teams') {
      teamSuggestionsIgnoreTeams = teamSuggestionsIgnoreTeams.concat(
        parseCsvListOption(args[index + 1], '--suggest-ignore-teams')
      )
      index++
      continue
    }

    if (arg.startsWith('--suggest-ignore-teams=')) {
      teamSuggestionsIgnoreTeams = teamSuggestionsIgnoreTeams.concat(
        parseCsvListOption(
          arg.slice('--suggest-ignore-teams='.length),
          '--suggest-ignore-teams'
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

    if (arg === '--github-token') {
      githubToken = args[index + 1]
      githubTokenSetExplicitly = true
      index++
      continue
    }

    if (arg.startsWith('--github-token=')) {
      githubToken = arg.slice('--github-token='.length)
      githubTokenSetExplicitly = true
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

    if (arg === '--no-report') {
      noReport = true
      continue
    }

    if (arg === '--list-unowned') {
      listUnowned = true
      continue
    }

    if (arg === '--fail-on-unowned') {
      failOnUnowned = true
      continue
    }

    if (arg === '--fail-on-missing-paths') {
      failOnMissingPaths = true
      continue
    }

    if (arg === '--fail-on-location-warnings') {
      failOnLocationWarnings = true
      continue
    }

    if (arg === '--glob' || arg === '-g') {
      checkGlobs.push(parseGlobOption(args[index + 1], '--glob'))
      index++
      continue
    }

    if (arg.startsWith('--glob=')) {
      checkGlobs.push(parseGlobOption(arg.slice('--glob='.length), '--glob'))
      continue
    }

    if (arg === '--upload') {
      upload = true
      continue
    }

    if (arg === '--yes' || arg === '-y') {
      yes = true
      continue
    }

    if (arg === '--no-open') {
      open = false
      continue
    }

    if (arg === '--verbose') {
      verbose = true
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

    if (!arg.startsWith('-') && repoOrPath === undefined) {
      repoOrPath = arg
      continue
    }

    throw new Error(`Unknown argument: ${arg}`)
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
    throw new Error('Missing value for --cwd.')
  }

  if (!help && repoOrPath !== undefined && workingDirSetExplicitly) {
    throw new Error('Cannot specify both a positional <repo-or-path> argument and --cwd.')
  }

  if (!help && teamSuggestionsWindowDays < 1) {
    throw new Error('--suggest-window-days must be >= 1.')
  }

  if (!help && teamSuggestionsTop < 1) {
    throw new Error('--suggest-top must be >= 1.')
  }

  if (!help && githubOrg !== null && !githubOrg) {
    throw new Error('Missing value for --github-org.')
  }

  if (!help && githubTokenSetExplicitly && !githubToken) {
    throw new Error('Missing value for --github-token.')
  }

  if (!help && !githubApiBaseUrl) {
    throw new Error('Missing value for --github-api-base-url.')
  }

  if (!help && !isValidHttpUrl(githubApiBaseUrl)) {
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
    includeUntracked,
    noReport,
    listUnowned,
    failOnUnowned,
    failOnMissingPaths,
    failOnLocationWarnings,
    checkGlobs,
    teamSuggestions,
    teamSuggestionsWindowDays,
    teamSuggestionsTop,
    teamSuggestionsIgnoreTeams,
    githubOrg,
    githubToken,
    githubApiBaseUrl,
    upload,
    yes,
    open,
    verbose,
    help,
    version,
  }
}

/**
 * Determine whether stdin is interactive.
 * The env override exists to keep automated tests deterministic.
 * @returns {boolean}
 */
function isInteractiveStdin () {
  if (process.env.CODEOWNERS_AUDIT_ASSUME_TTY === '1') return true
  if (process.env.CODEOWNERS_AUDIT_ASSUME_TTY === '0') return false
  return Boolean(process.stdin.isTTY)
}

/**
 * Prompt for permission before opening the report in a browser.
 * @param {string} target
 * @returns {Promise<boolean>}
 */
async function promptForReportOpen (target) {
  if (!isInteractiveStdin()) return false

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  return await new Promise((resolve) => {
    let settled = false
    const settle = (value) => {
      if (settled) return
      settled = true
      rl.close()
      resolve(value)
    }

    rl.on('SIGINT', () => {
      process.stdout.write('\n')
      console.log('Skipped opening report in browser.')
      settle(false)
    })

    rl.question(
      'Press Enter to open it in your browser (Ctrl+C to cancel): ',
      (answer) => {
        if (answer.trim() === '') {
          settle(true)
          return
        }

        console.log('Skipped opening report in browser.')
        settle(false)
      }
    )
  })
}

/**
 * Prompt for confirmation before a full repository clone.
 * @param {string} url
 * @returns {Promise<boolean>}
 */
async function promptForFullClone (url) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  return await new Promise((resolve) => {
    let settled = false
    const settle = (value) => {
      if (settled) return
      settled = true
      rl.close()
      resolve(value)
    }

    rl.on('SIGINT', () => {
      process.stdout.write('\n')
      settle(false)
    })

    rl.question(
      `Proceed with full clone of ${url}? [y/N] `,
      (answer) => {
        settle(answer.trim().toLowerCase() === 'y')
      }
    )
  })
}

/**
 * Determine whether a value looks like a remote repository URL or shorthand
 * rather than a local file path.
 * @param {string} value
 * @returns {boolean}
 */
function isRepoUrl (value) {
  if (value.includes('://')) return true
  if (value.startsWith('git@')) return true
  if (/^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9._-]+$/.test(value)) return true
  return false
}

/**
 * Normalize a repo identifier to a URL suitable for `git clone`.
 * Full URLs and SSH addresses are returned as-is.
 * GitHub-style shorthand (owner/repo) is expanded to an HTTPS URL.
 * @param {string} value
 * @returns {string}
 */
function normalizeRepoUrl (value) {
  if (value.includes('://') || value.startsWith('git@')) return value
  return `https://github.com/${value}.git`
}

/**
 * Resolve a human-friendly display name for a repository.
 * Tries `git remote get-url origin` first and extracts "owner/repo" from it.
 * Falls back to the directory basename when no origin remote is available.
 * @param {string} repoRoot
 * @returns {string}
 */
function resolveRepoDisplayName (repoRoot) {
  try {
    const remoteUrl = runGitCommand(['remote', 'get-url', 'origin'], repoRoot).trim()
    if (remoteUrl) {
      return deriveDisplayNameFromUrl(remoteUrl)
    }
  } catch {}
  return path.basename(repoRoot)
}

/**
 * Resolve a browsable repository URL from the origin remote when possible.
 * Returns null for repositories without an origin remote or file-based remotes.
 * @param {string} repoRoot
 * @returns {string|null}
 */
function resolveRepoWebUrl (repoRoot) {
  try {
    const remoteUrl = runGitCommand(['remote', 'get-url', 'origin'], repoRoot).trim()
    if (remoteUrl) {
      return deriveRepoWebUrlFromRemoteUrl(remoteUrl)
    }
  } catch {}
  return null
}

/**
 * Derive a human-friendly repository name from a remote URL.
 * For GitHub/GitLab-style URLs, returns "owner/repo".
 * Falls back to the URL itself for unrecognised formats.
 * @param {string} url
 * @returns {string}
 */
function deriveDisplayNameFromUrl (url) {
  const sshMatch = url.match(/^git@[^:]+:([^/]+)\/(.+?)(?:\.git)?$/)
  if (sshMatch) {
    return `${sshMatch[1]}/${sshMatch[2]}`
  }

  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'file:') {
      const base = path.posix.basename(parsed.pathname).replace(/\.git$/i, '')
      return base || url
    }
    const segments = parsed.pathname.replaceAll(/^\/+|\/+$/g, '').split('/')
    if (segments.length >= 2) {
      return `${segments[0]}/${segments[1].replace(/\.git$/i, '')}`
    }
  } catch {}

  return url
}

/**
 * Derive a browsable repository URL from a common git remote URL.
 * Supports git@host:owner/repo.git and http(s)://host/owner/repo(.git) forms.
 * @param {string} remoteUrl
 * @returns {string|null}
 */
function deriveRepoWebUrlFromRemoteUrl (remoteUrl) {
  const sshMatch = remoteUrl.match(/^git@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/)
  if (sshMatch) {
    return `https://${sshMatch[1]}/${sshMatch[2]}/${sshMatch[3]}`
  }

  try {
    const parsed = new URL(remoteUrl)
    if (parsed.protocol === 'file:') return null
    const segments = parsed.pathname.replaceAll(/^\/+|\/+$/g, '').split('/')
    if (segments.length >= 2) {
      return `${parsed.protocol}//${parsed.host}/${segments[0]}/${segments[1].replace(/\.git$/i, '')}`
    }
  } catch {}

  return null
}

/**
 * Print command usage.
 * @returns {void}
 */
function printUsage () {
  /** @type {Array<[string, string]>} */
  const optionRows = [
    ['-o, --output <path>', 'Output HTML file path'],
    ['--output-dir <dir>', 'Output directory for the generated HTML report'],
    ['--cwd <dir>', 'Run git commands from this directory'],
    ['--include-untracked', 'Include untracked files in the analysis'],
    ['--no-report', 'Skip HTML report generation (implies --list-unowned)'],
    ['--list-unowned', 'Print unowned file paths to stdout'],
    ['--fail-on-unowned', 'Exit non-zero when one or more files are unowned'],
    ['--fail-on-missing-paths', 'Exit non-zero when CODEOWNERS paths match no files'],
    ['--fail-on-location-warnings', 'Exit non-zero when extra or ignored CODEOWNERS files are found'],
    ['-g, --glob <pattern>', 'Repeatable file filter for report/check scope (default: **)'],
    ['--suggest-teams', 'Suggest @org/team for uncovered directories'],
    ['--suggest-window-days <days>', `Git history lookback window for suggestions (default: ${TEAM_SUGGESTIONS_DEFAULT_WINDOW_DAYS})`],
    ['--suggest-top <n>', `Top team suggestions to keep per directory (default: ${TEAM_SUGGESTIONS_DEFAULT_TOP})`],
    ['--suggest-ignore-teams <list>', 'Comma-separated team slugs or @org/slug entries to exclude from suggestions'],
    ['--github-org <org>', 'Override GitHub org for team lookups'],
    ['--github-token <token>', 'GitHub token for team lookups (falls back to GITHUB_TOKEN, then GH_TOKEN)'],
    ['--github-api-base-url <url>', `GitHub API base URL (default: ${GITHUB_API_BASE_URL})`],
    ['--upload', `Upload to ${UPLOAD_PROVIDER} and print a public URL`],
    ['-y, --yes', 'Automatically answer yes to interactive prompts'],
    ['--no-open', 'Do not prompt to open the report in your browser'],
    ['--verbose', 'Enable verbose progress output'],
    ['-h, --help', 'Show this help'],
    ['-v, --version', 'Show version'],
  ]

  console.log(
    [
      'Usage: codeowners-audit [repo-or-path] [options]',
      '',
      'Arguments:',
      '  [repo-or-path]           Repository URL, GitHub shorthand (owner/repo), or path to a local directory (default: cwd)',
      '',
      'Options:',
      ...formatUsageOptions(optionRows),
    ].join('\n')
  )
}

/**
 * Render CLI options into aligned help text rows.
 * @param {Array<[string, string]>} optionRows
 * @returns {string[]}
 */
function formatUsageOptions (optionRows) {
  const leftPadding = '  '
  const descriptionColumn = 28
  const descriptionPaddingWidth = descriptionColumn - 1
  const lines = []

  for (const [option, description] of optionRows) {
    const optionLine = leftPadding + option

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
 * Determine whether ANSI color output should be enabled for a stream.
 * @param {{ isTTY?: boolean }} stream
 * @returns {boolean}
 */
function shouldUseColorOutput (stream) {
  if (process.env.NO_COLOR !== undefined) return false
  if (process.env.FORCE_COLOR === '0') return false
  if (process.env.FORCE_COLOR !== undefined) return true
  return Boolean(stream && stream.isTTY)
}

/**
 * Wrap text with ANSI color/style codes when enabled.
 * @param {string} text
 * @param {string[]} styles
 * @param {boolean} enabled
 * @returns {string}
 */
function colorizeCliText (text, styles, enabled) {
  if (!enabled || styles.length === 0) return text
  return `${styles.join('')}${text}${ANSI_RESET}`
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
 * Emit CLI results for unowned file reporting and failure gating.
 * Coverage summary is always printed.
 * Exit code 1 means policy violations when fail flags are enabled.
 * @param {{
 *   totals: {
 *     files: number,
 *     unowned: number
 *   },
 *   codeownersFiles?: {
 *     path: string,
 *     rules: number
 *   }[],
 *   unownedFiles: string[],
 *   codeownersValidationMeta?: {
 *     discoveryWarnings?: {
 *       path: string,
 *       type: 'unused-supported-location'|'unsupported-location',
 *       referencePath?: string,
 *       message: string
 *     }[],
 *     missingPathWarnings?: {
 *       codeownersPath: string,
 *       pattern: string,
 *       owners: string[],
 *       history?: {
 *         addedAt: string,
 *         commitSha: string,
 *         commitUrl?: string
 *       }
 *     }[]
 *   }
 * }} report
 * @param {{
 *   noReport: boolean,
 *   listUnowned: boolean,
 *   failOnUnowned: boolean,
 *   failOnMissingPaths: boolean,
 *   failOnLocationWarnings: boolean,
 *   checkGlobs: string[],
 *   showCoverageSummary?: boolean,
 * }} options
 * @returns {void}
 */
function outputUnownedReportResults (report, options) {
  const globListLabel = options.checkGlobs.length === 1
    ? JSON.stringify(options.checkGlobs[0])
    : JSON.stringify(options.checkGlobs)
  const activeCodeownersPath = Array.isArray(report.codeownersFiles) && report.codeownersFiles[0]
    ? report.codeownersFiles[0].path
    : null
  const discoveryWarnings = Array.isArray(report.codeownersValidationMeta?.discoveryWarnings)
    ? report.codeownersValidationMeta.discoveryWarnings
    : []
  const locationWarningCount = discoveryWarnings.length
  const missingPathWarnings = Array.isArray(report.codeownersValidationMeta?.missingPathWarnings)
    ? report.codeownersValidationMeta.missingPathWarnings
    : []
  const missingPathWarningCount = missingPathWarnings.length
  const unknownFileCount = report.unownedFiles.length
  const colorStdout = shouldUseColorOutput(process.stdout)
  const colorStderr = shouldUseColorOutput(process.stderr)

  if (options.listUnowned && unknownFileCount > 0) {
    console.log(
      colorizeCliText(`Unknown files (${unknownFileCount}):`, [ANSI_BOLD, ANSI_RED], colorStdout)
    )
    for (const filePath of report.unownedFiles) {
      console.log(`- ${filePath}`)
    }
    console.log('')
  }

  if (options.noReport && missingPathWarningCount > 0) {
    console.error(
      colorizeCliText(
        `Missing CODEOWNERS paths (${missingPathWarningCount}):`,
        [ANSI_BOLD, ANSI_YELLOW],
        colorStderr
      )
    )
    for (const warning of missingPathWarnings) {
      console.error('%s', formatMissingPathWarningForCli(warning, colorStderr))
    }
    console.error('')
  }

  if (options.noReport && locationWarningCount > 0) {
    console.error(
      colorizeCliText(
        `CODEOWNERS location warnings (${locationWarningCount}):`,
        [ANSI_BOLD, ANSI_YELLOW],
        colorStderr
      )
    )
    for (const warning of discoveryWarnings) {
      console.error('%s', formatCodeownersDiscoveryWarningForCli(warning, colorStderr))
    }
    console.error('')
  }

  if (options.showCoverageSummary !== false) {
    console.log(
      [
        colorizeCliText('Coverage summary:', [ANSI_BOLD, ANSI_CYAN], colorStdout),
        `${colorizeCliText('globs:', [ANSI_DIM], colorStdout)} ${globListLabel}`,
        ...(activeCodeownersPath
          ? [`${colorizeCliText('codeowners file:', [ANSI_DIM], colorStdout)} ${colorizeCliText(activeCodeownersPath, [ANSI_BOLD], colorStdout)}`]
          : []),
        `${colorizeCliText('analyzed files:', [ANSI_DIM], colorStdout)} ${colorizeCliText(String(report.totals.files), [ANSI_BOLD], colorStdout)}`,
        `${colorizeCliText('unknown files:', [ANSI_DIM], colorStdout)} ${colorizeCliText(String(report.totals.unowned), report.totals.unowned > 0 ? [ANSI_BOLD, ANSI_RED] : [ANSI_BOLD, ANSI_GREEN], colorStdout)}`,
        `${colorizeCliText('missing path warnings:', [ANSI_DIM], colorStdout)} ${colorizeCliText(String(missingPathWarningCount), missingPathWarningCount > 0 ? [ANSI_BOLD, ANSI_YELLOW] : [ANSI_BOLD, ANSI_GREEN], colorStdout)}`,
        `${colorizeCliText('location warnings:', [ANSI_DIM], colorStdout)} ${colorizeCliText(String(locationWarningCount), locationWarningCount > 0 ? [ANSI_BOLD, ANSI_YELLOW] : [ANSI_BOLD, ANSI_GREEN], colorStdout)}`,
      ].join('\n')
    )
  }

  if (options.failOnUnowned && report.unownedFiles.length > 0) {
    if (!options.listUnowned) {
      console.error('')
      for (const filePath of report.unownedFiles) {
        console.error('  - %s', filePath)
      }
    }
    process.exitCode = EXIT_CODE_UNCOVERED
  }

  if (options.failOnMissingPaths && missingPathWarningCount > 0) {
    process.exitCode = EXIT_CODE_UNCOVERED
  }

  if (options.failOnLocationWarnings && locationWarningCount > 0) {
    process.exitCode = EXIT_CODE_UNCOVERED
  }
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
 * @param {string[]} patterns
 * @returns {(filePath: string) => boolean}
 */
function createCliGlobMatcher (patterns) {
  const matchers = patterns.map(pattern => createPatternMatcher(pattern))
  return (filePath) => matchers.some(matches => matches(filePath))
}

/**
 * Filter file paths by the configured CLI glob set.
 * @param {string[]} files
 * @param {string[]} patterns
 * @returns {string[]}
 */
function filterFilesByCliGlobs (files, patterns) {
  const matcher = createCliGlobMatcher(patterns)
  return files.filter(filePath => matcher(filePath))
}

/**
 * Upload the generated HTML report.
 * @param {string} reportPath
 * @returns {Promise<string>}
 */
async function uploadReport (reportPath) {
  return uploadToZenbin(reportPath)
}

/**
 * Upload a file to ZenBin and return the public URL.
 * @param {string} filePath
 * @returns {Promise<string>}
 */
async function uploadToZenbin (filePath) {
  const fileBaseName = path.basename(filePath, path.extname(filePath))
  const pageId = createZenbinPageId(fileBaseName)
  const payload = JSON.stringify({ html: readFileSync(filePath, 'utf8') })
  const payloadBytes = Buffer.byteLength(payload, 'utf8')

  if (payloadBytes >= ZENBIN_MAX_UPLOAD_BYTES) {
    throw new Error(
      `Upload failed (${UPLOAD_PROVIDER}): report is too large for ZenBin (${formatBytes(payloadBytes)} payload; ` +
      `limit is about ${formatBytes(ZENBIN_MAX_UPLOAD_BYTES)}). ` +
      `Re-run without --upload and share the generated HTML file directly.`
    )
  }

  const url = `${ZENBIN_BASE_URL}/v1/pages/${pageId}`

  /** @type {globalThis.Response} */
  let httpResponse
  try {
    httpResponse = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    })
  } catch (error) {
    throw new Error(`Upload failed (${UPLOAD_PROVIDER}): ${error instanceof Error ? error.message : String(error)}`)
  }

  const responseText = await httpResponse.text()

  if (!httpResponse.ok) {
    const likelyTooLargeHint = httpResponse.status === 400
      ? ` (ZenBin may reject payloads near 1 MiB; current payload is ${formatBytes(payloadBytes)})`
      : ''
    throw new Error(
      `Upload failed (${UPLOAD_PROVIDER}): HTTP ${httpResponse.status}${likelyTooLargeHint}`
    )
  }

  /** @type {{ url?: string }} */
  let response
  try {
    response = JSON.parse(responseText)
  } catch {
    throw new Error(
      `Upload failed (${UPLOAD_PROVIDER}): invalid JSON response: ${JSON.stringify(responseText.trim())}`
    )
  }

  const maybeUrl = response && typeof response.url === 'string' ? response.url.trim() : ''
  if (!/^https?:\/\//.test(maybeUrl)) {
    throw new Error(`Upload failed (${UPLOAD_PROVIDER}): missing URL in response: ${JSON.stringify(response)}`)
  }

  return maybeUrl
}

/**
 * Format bytes as an integer KiB value.
 * @param {number} byteCount
 * @returns {string}
 */
function formatBytes (byteCount) {
  return `${Math.ceil(byteCount / 1024)} KiB`
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
  return `${base}-${timestamp}-${randomPart}`
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
 * Format a CODEOWNERS discovery warning for CLI output.
 * @param {{
 *   path: string,
 *   type: 'unused-supported-location'|'unsupported-location',
 *   referencePath?: string,
 *   message: string
 * }} warning
 * @param {boolean} useColor
 * @returns {string}
 */
function formatCodeownersDiscoveryWarningForCli (warning, useColor) {
  const bullet = colorizeCliText('- ', [ANSI_DIM], useColor)
  const warningPath = colorizeCliText(warning.path, [ANSI_YELLOW], useColor)
  const warningText = colorizeCliText(
    warning.type === 'unused-supported-location'
      ? ' is unused because GitHub selects '
      : ' is in an unsupported location and is ignored by GitHub.',
    [ANSI_DIM],
    useColor
  )

  if (warning.type === 'unused-supported-location' && warning.referencePath) {
    const referencePath = colorizeCliText(warning.referencePath, [ANSI_CYAN], useColor)
    const trailingText = colorizeCliText(' first.', [ANSI_DIM], useColor)
    return bullet + warningPath + warningText + referencePath + trailingText
  }

  return bullet + warningPath + warningText
}

/**
 * Format a missing CODEOWNERS path warning for CLI output.
 * @param {{
 *   codeownersPath: string,
 *   pattern: string,
 *   owners: string[],
 *   history?: {
 *     addedAt: string,
 *     commitSha: string,
 *     commitUrl?: string
 *   }
 * }} warning
 * @param {boolean} useColor
 * @returns {string}
 */
function formatMissingPathWarningForCli (warning, useColor) {
  const bullet = colorizeCliText('- ', [ANSI_DIM], useColor)
  const warningPath = colorizeCliText(warning.pattern, [ANSI_YELLOW], useColor)
  const ownerLabel = colorizeCliText(' owners: ', [ANSI_DIM], useColor)
  const ownerList = formatCodeownersOwnersList(warning.owners)
  const ownerText = colorizeCliText(ownerList, [ANSI_CYAN], useColor)
  return bullet + warningPath + ownerLabel + ownerText
}

/**
 * Format a CODEOWNERS owner list for human-readable output.
 * @param {string[]|undefined} owners
 * @returns {string}
 */
function formatCodeownersOwnersList (owners) {
  if (!Array.isArray(owners) || owners.length === 0) return '(none)'
  return owners.join(', ')
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
 *   rules: {
 *     pattern: string,
 *     owners: string[],
 *     matches: (repoPath: string) => boolean
 *   }[]
 * }}
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
 * Parse CODEOWNERS content into rule matchers.
 * @param {string} fileContent
 * @returns {{ pattern: string, owners: string[], matches: (repoPath: string) => boolean }[]}
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
 * Parse a single CODEOWNERS rule line, ignoring blank lines, comments,
 * malformed rows, and unsupported negation patterns.
 * @param {string} line
 * @returns {{ pattern: string, owners: string[] }|null}
 */
function parseCodeownersRuleLine (line) {
  const withoutComment = stripInlineComment(line).trim()
  if (!withoutComment) return null

  const tokens = tokenizeCodeownersLine(withoutComment).map(unescapeToken)
  if (tokens.length < 2) return null

  const pattern = tokens[0]
  const owners = tokens.slice(1).filter(Boolean)
  if (!owners.length) return null
  if (pattern.startsWith('!')) return null // Negation is not supported in CODEOWNERS.

  return { pattern, owners }
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
  return /[\\^$.*+?()[\]{}|]/.test(char) ? `\\${char}` : char
}

/**
 * Build missing-path warnings for CODEOWNERS rules that match no repository files.
 * @param {{
 *   path: string,
 *   rules: {
 *     pattern: string,
 *     owners: string[],
 *     matches: (repoPath: string) => boolean
 *   }[]
 * }} codeownersDescriptor
 * @param {string[]} repoFiles
 * @param {Map<string, {
 *   addedAt: string,
 *   commitSha: string,
 *   commitUrl?: string
 * }>} [historyByPattern]
 * @returns {{
 *   codeownersPath: string,
 *   pattern: string,
 *   owners: string[],
 *   history?: {
 *     addedAt: string,
 *     commitSha: string,
 *     commitUrl?: string
 *   }
 * }[]}
 */
function collectMissingCodeownersPathWarnings (codeownersDescriptor, repoFiles, historyByPattern = new Map()) {
  /** @type {{
   *   codeownersPath: string,
   *   pattern: string,
   *   owners: string[],
   *   history?: {
   *     addedAt: string,
   *     commitSha: string,
   *     commitUrl?: string
   *   }
   * }[]} */
  const warnings = []

  for (const rule of codeownersDescriptor.rules) {
    const hasMatch = repoFiles.some((filePath) => rule.matches(filePath))
    if (!hasMatch) {
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
 * @param {{
 *   path: string,
 *   rules: {
 *     pattern: string,
 *     owners: string[],
 *     matches: (repoPath: string) => boolean
 *   }[]
 * }} codeownersDescriptor
 * @param {string|null} repoWebUrl
 * @returns {Map<string, {
 *   addedAt: string,
 *   commitSha: string,
 *   commitUrl?: string
 * }>}
 */
function collectCodeownersPatternHistory (repoRoot, codeownersDescriptor, repoWebUrl) {
  const currentPatterns = new Set(codeownersDescriptor.rules.map(rule => rule.pattern))
  /** @type {Map<string, {
   *   addedAt: string,
   *   commitSha: string,
   *   commitUrl?: string
   * }>} */
  const activeHistory = new Map()

  if (currentPatterns.size === 0) {
    return activeHistory
  }

  /** @type {string} */
  let stdout
  try {
    stdout = runGitCommand(
      ['log', '--reverse', '--format=%x1e%H%x00%ct', '-p', '--unified=0', '--no-ext-diff', '--', codeownersDescriptor.path],
      repoRoot
    )
  } catch {
    return activeHistory
  }

  for (const entry of stdout.split('\u001e')) {
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
 * @returns {{
 *   path: string,
 *   type: 'unused-supported-location'|'unsupported-location',
 *   referencePath?: string,
 *   message: string
 * }[]}
 */
function collectCodeownersDiscoveryWarnings (discoveredCodeownersPaths, activeCodeownersPath) {
  /** @type {{
   *   path: string,
   *   type: 'unused-supported-location'|'unsupported-location',
   *   referencePath?: string,
   *   message: string
   * }[]} */
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
function buildReport (repoRoot, files, codeownersDescriptor, options, progress = () => {}) {
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
    const owners = resolveOwners(filePath, codeownersDescriptor.rules)
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

    const segments = filePath.split('/')
    let currentPath = ''
    for (let index = 0; index < segments.length - 1; index++) {
      currentPath = currentPath ? `${currentPath}/${segments[index]}` : segments[index]
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
 * Resolve matching owners for a file using the active CODEOWNERS rules.
 * @param {string} filePath
 * @param {{
 *   owners: string[],
 *   matches: (repoPath: string) => boolean
 * }[]} codeownersRules
 * @returns {string[]|undefined}
 */
function resolveOwners (filePath, codeownersRules) {
  return findMatchingOwners(filePath, codeownersRules)
}

/**
 * Find the last matching owners in a ruleset.
 * @param {string} repoPath
 * @param {{ owners: string[], matches: (repoPath: string) => boolean }[]} rules
 * @returns {string[]|undefined}
 */
function findMatchingOwners (repoPath, rules) {
  /** @type {string[]|undefined} */
  let owners
  for (const rule of rules) {
    if (rule.matches(repoPath)) {
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

/**
 * Render a complete self-contained HTML page for the report.
 * @param {{
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
 * }} report
 * @returns {string}
 */
function renderHtml (report) {
  const serializedReport = JSON.stringify(report, null, 2).replaceAll('<', String.raw`\u003c`)

  return REPORT_HTML_TEMPLATE
    .replace(REPORT_DATA_PLACEHOLDER, serializedReport)
    .replace(REPORT_LOGO_URL_PLACEHOLDER, REPORT_LOGO_URL)
    .replace(REPORT_VERSION_PLACEHOLDER, packageVersion)
    .replace(REPORT_REPO_URL_PLACEHOLDER, REPORT_REPO_URL)
}
