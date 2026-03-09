#!/usr/bin/env node
/* eslint-disable no-console */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import {
  parseArgs,
  printUsage,
  UPLOAD_PROVIDER,
} from './lib/cli-args.js'
import {
  parseCodeowners,
  parseCodeownersRuleLine,
  createPatternMatcher,
} from './lib/codeowners-parser.js'
import { runGitCommand, toPosixPath, formatCommandError } from './lib/git.js'
import { createProgressLogger } from './lib/progress.js'
import { buildReport, FILE_ANALYSIS_PROGRESS_INTERVAL } from './lib/report-builder.js'
import { renderHtml, packageVersion } from './lib/report-renderer.js'
import {
  isRepoUrl,
  normalizeRepoUrl,
  resolveRepoWebUrl,
} from './lib/repository.js'
import { collectDirectoryTeamSuggestions } from './lib/team-suggestions.js'
import { uploadReport } from './lib/upload.js'
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

    let cloneUrl = null
    const remoteRepoUrl = options.repoOrPath !== undefined && isRepoUrl(options.repoOrPath)
      ? options.repoOrPath
      : undefined

    if (remoteRepoUrl !== undefined) {
      cloneUrl = normalizeRepoUrl(remoteRepoUrl)
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

    const historyProgress = createProgressLogger(options.verbose)
    const codeownersDescriptor = loadCodeownersDescriptor(repoRoot, codeownersPath)
    const discoveryWarnings = collectCodeownersDiscoveryWarnings(discoveredCodeownersPaths, codeownersPath)
    let missingPathWarnings = collectMissingCodeownersPathWarnings(codeownersDescriptor, allRepoFiles)
    if (!options.noReport && missingPathWarnings.length > 0) {
      const historyReady = await ensureCodeownersHistoryAvailability(
        repoRoot,
        {
          allowFetch: Boolean(clonedTempDir),
          interactive: interactiveStdin,
          assumeYes: options.yes,
          cloneUrl,
          progress: historyProgress,
        }
      )
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
  return await promptForYesNo(`Proceed with full clone of ${url}? [y/N] `)
}

/**
 * Prompt for confirmation before fetching additional history for CODEOWNERS
 * pattern age and commit links from a shallow remote clone.
 * @param {string} url
 * @returns {Promise<boolean>}
 */
async function promptForCodeownersHistoryClone (url) {
  return await promptForYesNo(
    `Fetch full history for ${url} to show CODEOWNERS pattern age and commit links? [y/N] `
  )
}

/**
 * Prompt for a simple yes/no confirmation, defaulting to "no".
 * @param {string} question
 * @returns {Promise<boolean>}
 */
async function promptForYesNo (question) {
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
      question,
      (answer) => {
        settle(answer.trim().toLowerCase() === 'y')
      }
    )
  })
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
 * Ensure CODEOWNERS history can be trusted before rendering blame-style links.
 * For temp clones created from remote URLs we can safely deepen history.
 * For user repositories we avoid mutating clone depth and simply skip history.
 * @param {string} repoRoot
 * @param {{
 *   allowFetch?: boolean,
 *   interactive?: boolean,
 *   assumeYes?: boolean,
 *   cloneUrl?: string|null,
 *   progress?: (message: string, ...values: any[]) => void
 * }} options
 * @returns {Promise<boolean>}
 */
async function ensureCodeownersHistoryAvailability (repoRoot, options = {}) {
  if (!isShallowRepository(repoRoot)) {
    return true
  }

  if (!options.allowFetch) {
    return false
  }

  if (!options.assumeYes) {
    if (!options.interactive) {
      return false
    }
    const targetLabel = options.cloneUrl || 'this repository'
    console.log(
      'Full repository history required to show CODEOWNERS pattern age and commit links ' +
      '(this may take longer).'
    )
    const confirmed = await promptForCodeownersHistoryClone(targetLabel)
    if (!confirmed) {
      console.log('Skipping CODEOWNERS history links.')
      return false
    }
  }

  try {
    if (typeof options.progress === 'function') {
      options.progress('Deepening shallow clone to resolve CODEOWNERS history...')
    }
    runGitCommand(['fetch', '--quiet', '--unshallow'], repoRoot)
  } catch {
    return false
  }

  return !isShallowRepository(repoRoot)
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

