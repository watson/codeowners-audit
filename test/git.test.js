import assert from 'node:assert/strict'
import test from 'node:test'

import { toPosixPath, formatCommandError } from '../lib/git.js'

// --- toPosixPath ---

test('toPosixPath: returns posix path unchanged', () => {
  assert.equal(toPosixPath('src/lib/file.js'), 'src/lib/file.js')
})

test('toPosixPath: handles single segment', () => {
  assert.equal(toPosixPath('file.js'), 'file.js')
})

test('toPosixPath: handles empty string', () => {
  assert.equal(toPosixPath(''), '')
})

// --- formatCommandError ---

test('formatCommandError: extracts stderr from error object', () => {
  const error = { stderr: 'fatal: not a git repository', message: 'Command failed' }
  assert.equal(formatCommandError(error), 'fatal: not a git repository')
})

test('formatCommandError: falls back to message when stderr is empty', () => {
  const error = { stderr: '', message: 'Command failed' }
  assert.equal(formatCommandError(error), 'Command failed')
})

test('formatCommandError: falls back to message when stderr is missing', () => {
  const error = { message: 'Something went wrong' }
  assert.equal(formatCommandError(error), 'Something went wrong')
})

test('formatCommandError: converts non-object errors to string', () => {
  assert.equal(formatCommandError('string error'), 'string error')
  assert.equal(formatCommandError(42), '42')
  assert.equal(formatCommandError(null), 'null')
})

test('formatCommandError: trims whitespace from stderr', () => {
  const error = { stderr: '  error message  \n', message: 'unused' }
  assert.equal(formatCommandError(error), 'error message')
})
