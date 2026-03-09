/* eslint-disable no-console */

import { execFileSync } from 'node:child_process'
import readline from 'node:readline'

/**
 * Determine whether stdin is interactive.
 * The env override exists to keep automated tests deterministic.
 * @returns {boolean}
 */
export function isInteractiveStdin () {
  if (process.env.CODEOWNERS_AUDIT_ASSUME_TTY === '1') return true
  if (process.env.CODEOWNERS_AUDIT_ASSUME_TTY === '0') return false
  return Boolean(process.stdin.isTTY)
}

/**
 * Prompt for permission before opening the report in a browser.
 * @param {string} target
 * @returns {Promise<boolean>}
 */
export async function promptForReportOpen (target) {
  if (!isInteractiveStdin()) return false

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  return await new Promise((resolve) => {
    let settled = false
    /** @param {boolean} value */
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
export async function promptForFullClone (url) {
  return await promptForYesNo(`Proceed with full clone of ${url}? [y/N] `)
}

/**
 * Prompt for confirmation before fetching additional history for CODEOWNERS
 * pattern age and commit links from a shallow remote clone.
 * @param {string} url
 * @returns {Promise<boolean>}
 */
export async function promptForCodeownersHistoryClone (url) {
  return await promptForYesNo(
    `Fetch full history for ${url} to show CODEOWNERS pattern age and commit links? [y/N] `
  )
}

/**
 * Prompt for a simple yes/no confirmation, defaulting to "no".
 * @param {string} question
 * @returns {Promise<boolean>}
 */
export async function promptForYesNo (question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  return await new Promise((resolve) => {
    let settled = false
    /** @param {boolean} value */
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
 * Open a report target in the system browser.
 * @param {string} target
 * @returns {void}
 */
export function openReportInBrowser (target) {
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
