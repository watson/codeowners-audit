#!/usr/bin/env node
/* eslint-disable no-console */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { audit, isShallowRepository } from './lib/audit.js'
import {
  parseArgs,
  printUsage,
  UPLOAD_PROVIDER,
} from './lib/cli-args.js'
import { outputUnownedReportResults } from './lib/cli-output.js'
import { runGitCommand, toPosixPath, formatCommandError } from './lib/git.js'
import { createProgressLogger } from './lib/progress.js'
import {
  isInteractiveStdin,
  promptForFullClone,
  promptForCodeownersHistoryClone,
  promptForReportOpen,
  openReportInBrowser,
} from './lib/prompts.js'
import { packageVersion } from './lib/report-renderer.js'
import {
  isRepoUrl,
  normalizeRepoUrl,
} from './lib/repository.js'
import { uploadReport } from './lib/upload.js'

const EXIT_CODE_RUNTIME_ERROR = 2

main()

/**
 * Run the report generation flow.
 * @returns {Promise<void>}
 */
async function main () {
  /** @type {string|null} */
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

    const outputAbsolutePath = clonedTempDir
      ? path.resolve(process.cwd(), options.outputPath)
      : path.resolve(repoRoot, options.outputPath)
    const outputRelativePath = toPosixPath(path.relative(repoRoot, outputAbsolutePath))

    const historyProgress = createProgressLogger(options.verbose)
    const progress = createProgressLogger(options.verbose)

    const { report, html } = await audit(repoRoot, {
      ...options,
      outputRelativePath,
      progress,
      ensureHistoryAvailability: () => ensureCodeownersHistoryAvailability(
        repoRoot,
        {
          allowFetch: Boolean(clonedTempDir),
          interactive: interactiveStdin,
          assumeYes: options.yes,
          cloneUrl,
          progress: historyProgress,
        }
      ),
    })

    if (!options.noReport && html) {
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
    console.error(error)
    process.exit(EXIT_CODE_RUNTIME_ERROR)
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
