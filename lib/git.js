import { execFileSync } from 'node:child_process'
import path from 'node:path'

const GIT_COMMAND_MAX_BUFFER = 64 * 1024 * 1024

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
 * Normalize a path to POSIX separators.
 * @param {string} value
 * @returns {string}
 */
function toPosixPath (value) {
  return value.split(path.sep).join('/')
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

export {
  GIT_COMMAND_MAX_BUFFER,
  runGitCommand,
  toPosixPath,
  formatCommandError,
}
