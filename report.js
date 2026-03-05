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
const ZENBIN_BASE_URL = 'https://zenbin.org'
const ZENBIN_MAX_UPLOAD_BYTES = 1024 * 1024
const GIT_COMMAND_MAX_BUFFER = 64 * 1024 * 1024
const TEAM_SUGGESTIONS_DEFAULT_WINDOW_DAYS = 365
const TEAM_SUGGESTIONS_DEFAULT_TOP = 3
const GITHUB_API_BASE_URL = 'https://api.github.com'
const FILE_ANALYSIS_PROGRESS_INTERVAL = 20000
const EXIT_CODE_UNCOVERED = 1
const EXIT_CODE_RUNTIME_ERROR = 2
const packageVersion = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version
const REPORT_TEMPLATE_PATH = new URL('./report.template.html', import.meta.url)
const REPORT_DATA_PLACEHOLDER = '__REPORT_DATA_JSON__'
const REPORT_LOGO_URL_PLACEHOLDER = '__REPORT_LOGO_URL__'
const REPORT_LOGO_URL = `https://raw.githubusercontent.com/watson/codeowners-audit/v${packageVersion}/assets/logo2-small.png`
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
        if (interactiveStdin) {
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
    const codeownersFilePaths = allRepoFiles.filter(isCodeownersFile)

    if (codeownersFilePaths.length === 0) {
      throw new Error('No CODEOWNERS files found in this repository.')
    }

    const codeownersDescriptors = codeownersFilePaths
      .map(codeownersPath => loadCodeownersDescriptor(repoRoot, codeownersPath))
      .sort(compareCodeownersDescriptor)

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
    const report = buildReport(repoRoot, filesToAnalyze, codeownersDescriptors, options, progress)
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

    outputUnownedReportResults(report, options)

    if (!options.noReport) {
      /** @type {string} */
      let reportLocation = outputAbsolutePath
      if (options.upload) {
        const uploadUrl = uploadReport(outputAbsolutePath)
        reportLocation = uploadUrl
        console.log('Uploaded report (%s): %s', UPLOAD_PROVIDER, uploadUrl)
      }

      console.log('Report ready at %s', reportLocation)

      if (options.open) {
        const shouldOpen = await promptForReportOpen(reportLocation)
        if (shouldOpen) {
          try {
            openReportInBrowser(reportLocation)
            console.log('Opened report in browser: %s', reportLocation)
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
 *   checkGlobs: string[],
 *   teamSuggestions: boolean,
 *   teamSuggestionsWindowDays: number,
 *   teamSuggestionsTop: number,
 *   teamSuggestionsIgnoreTeams: string[],
 *   githubOrg: string|null,
 *   githubToken?: string,
 *   githubApiBaseUrl: string,
 *   upload: boolean,
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
    checkGlobs,
    teamSuggestions,
    teamSuggestionsWindowDays,
    teamSuggestionsTop,
    teamSuggestionsIgnoreTeams,
    githubOrg,
    githubToken,
    githubApiBaseUrl,
    upload,
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
    const segments = parsed.pathname.replaceAll(/^\/+|\/+$/g, '').split('/')
    if (segments.length >= 2) {
      return `${segments[0]}/${segments[1].replace(/\.git$/i, '')}`
    }
  } catch {}

  return url
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
    ['-g, --glob <pattern>', 'Repeatable file filter for report/check scope (default: **)'],
    ['--suggest-teams', 'Suggest @org/team for uncovered directories'],
    ['--suggest-window-days <days>', `Git history lookback window for suggestions (default: ${TEAM_SUGGESTIONS_DEFAULT_WINDOW_DAYS})`],
    ['--suggest-top <n>', `Top team suggestions to keep per directory (default: ${TEAM_SUGGESTIONS_DEFAULT_TOP})`],
    ['--suggest-ignore-teams <list>', 'Comma-separated team slugs or @org/slug entries to exclude from suggestions'],
    ['--github-org <org>', 'Override GitHub org for team lookups'],
    ['--github-token <token>', 'GitHub token for team lookups (falls back to GITHUB_TOKEN, then GH_TOKEN)'],
    ['--github-api-base-url <url>', `GitHub API base URL (default: ${GITHUB_API_BASE_URL})`],
    ['--upload', `Upload to ${UPLOAD_PROVIDER} and print a public URL`],
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
 * Exit code 1 means uncovered files when fail-on-unowned is enabled.
 * @param {{
 *   totals: {
 *     files: number,
 *     unowned: number
 *   },
 *   unownedFiles: string[]
 * }} report
 * @param {{
 *   listUnowned: boolean,
 *   failOnUnowned: boolean,
 *   checkGlobs: string[],
 * }} options
 * @returns {void}
 */
function outputUnownedReportResults (report, options) {
  const globListLabel = options.checkGlobs.length === 1
    ? JSON.stringify(options.checkGlobs[0])
    : JSON.stringify(options.checkGlobs)

  if (options.listUnowned && report.unownedFiles.length > 0) {
    console.log('Unowned files:')
    for (const filePath of report.unownedFiles) {
      console.log(filePath)
    }
    console.log('')
  }

  console.log(
    'Coverage summary for globs %s: %d analyzed files, %d unowned.',
    globListLabel,
    report.totals.files,
    report.totals.unowned
  )

  if (options.failOnUnowned && report.unownedFiles.length > 0) {
    if (!options.listUnowned) {
      console.error('')
      for (const filePath of report.unownedFiles) {
        console.error('  - %s', filePath)
      }
    }
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
  return (filePath) => matchers.some(matches => matches(filePath, filePath))
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
      `Upload failed (${UPLOAD_PROVIDER}): report is too large for ZenBin (${formatBytes(payloadBytes)} payload; ` +
      `limit is about ${formatBytes(ZENBIN_MAX_UPLOAD_BYTES)}). ` +
      `Re-run without --upload and share the generated HTML file directly.`
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
      `${ZENBIN_BASE_URL}/v1/pages/${pageId}`,
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
      ? ` (ZenBin may reject payloads near 1 MiB; current payload is ${formatBytes(payloadBytes)})`
      : ''
    throw new Error(`Upload failed (${UPLOAD_PROVIDER}): ${stderr || String(error)}${likelyTooLargeHint}`)
  }

  /** @type {{ url?: string }} */
  let response
  try {
    response = JSON.parse(String(stdout))
  } catch {
    throw new Error(
      `Upload failed (${UPLOAD_PROVIDER}): invalid JSON response: ${JSON.stringify(String(stdout).trim())}`
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
    const anchoredRegex = new RegExp(`^${patternSource}${descendantSuffix}$`)
    return (scopePath) => anchoredRegex.test(scopePath)
  }

  const unanchoredRegex = new RegExp(`(?:^|/)${patternSource}${descendantSuffix}$`)
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
  return /[\\^$.*+?()[\]{}|]/.test(char) ? `\\${char}` : char
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
 *   githubToken?: string,
 *   teamSuggestionsWindowDays?: number
 * }} options
 * @param {(message: string, ...values: any[]) => void} progress
 * @returns {{
 *   repoName: string,
 *   generatedAt: string,
 *   options: { includeUntracked: boolean, teamSuggestionsEnabled: boolean },
 *   totals: { files: number, owned: number, unowned: number, coverage: number },
 *   codeownersFiles: { path: string, dir: string, rules: number }[],
 *   directories: { path: string, total: number, owned: number, unowned: number, coverage: number }[],
 *   unownedFiles: string[],
 *   teamOwnership: { team: string, total: number, files: string[] }[],
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
function buildReport (repoRoot, files, codeownersDescriptors, options, progress = () => {}) {
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
    const owners = resolveOwners(filePath, codeownersDescriptors)
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
    codeownersFiles: codeownersDescriptors.map((descriptor) => {
      return {
        path: descriptor.path,
        dir: descriptor.dir || '.',
        rules: descriptor.rules.length,
      }
    }),
    directories,
    unownedFiles,
    teamOwnership: teamOwnershipRows,
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
  return filePath === dirPath || filePath.startsWith(`${dirPath}/`)
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
 *   codeownersFiles: { path: string, dir: string, rules: number }[],
 *   directories: { path: string, total: number, owned: number, unowned: number, coverage: number }[],
 *   unownedFiles: string[],
 *   teamOwnership: { team: string, total: number, files: string[] }[],
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
  const serializedReport = JSON.stringify(report).replaceAll('<', String.raw`\u003c`)

  return REPORT_HTML_TEMPLATE
    .replace(REPORT_DATA_PLACEHOLDER, serializedReport)
    .replace(REPORT_LOGO_URL_PLACEHOLDER, REPORT_LOGO_URL)
}
