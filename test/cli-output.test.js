import assert from 'node:assert/strict'
import test from 'node:test'

import {
  shouldUseColorOutput,
  colorizeCliText,
  formatCodeownersOwnersList,
  formatCodeownersDiscoveryWarningForCli,
  formatMissingPathWarningForCli,
  formatUnprotectedDirectoryWarningForCli,
} from '../lib/cli-output.js'

function stripAnsi (value) {
  return String(value).replaceAll(/\u001b\[[0-9;]*m/g, '')
}

// --- shouldUseColorOutput ---

test('shouldUseColorOutput: returns false when NO_COLOR is set', (t) => {
  const orig = process.env.NO_COLOR
  t.after(() => {
    if (orig === undefined) delete process.env.NO_COLOR
    else process.env.NO_COLOR = orig
  })
  process.env.NO_COLOR = ''
  assert.equal(shouldUseColorOutput({ isTTY: true }), false)
})

test('shouldUseColorOutput: returns false when FORCE_COLOR=0', (t) => {
  const origNo = process.env.NO_COLOR
  const origForce = process.env.FORCE_COLOR
  t.after(() => {
    if (origNo === undefined) delete process.env.NO_COLOR
    else process.env.NO_COLOR = origNo
    if (origForce === undefined) delete process.env.FORCE_COLOR
    else process.env.FORCE_COLOR = origForce
  })
  delete process.env.NO_COLOR
  process.env.FORCE_COLOR = '0'
  assert.equal(shouldUseColorOutput({ isTTY: true }), false)
})

test('shouldUseColorOutput: returns true when FORCE_COLOR is set (non-zero)', (t) => {
  const origNo = process.env.NO_COLOR
  const origForce = process.env.FORCE_COLOR
  t.after(() => {
    if (origNo === undefined) delete process.env.NO_COLOR
    else process.env.NO_COLOR = origNo
    if (origForce === undefined) delete process.env.FORCE_COLOR
    else process.env.FORCE_COLOR = origForce
  })
  delete process.env.NO_COLOR
  process.env.FORCE_COLOR = '1'
  assert.equal(shouldUseColorOutput({ isTTY: false }), true)
})

test('shouldUseColorOutput: returns true for TTY stream without env overrides', (t) => {
  const origNo = process.env.NO_COLOR
  const origForce = process.env.FORCE_COLOR
  t.after(() => {
    if (origNo === undefined) delete process.env.NO_COLOR
    else process.env.NO_COLOR = origNo
    if (origForce === undefined) delete process.env.FORCE_COLOR
    else process.env.FORCE_COLOR = origForce
  })
  delete process.env.NO_COLOR
  delete process.env.FORCE_COLOR
  assert.equal(shouldUseColorOutput({ isTTY: true }), true)
})

test('shouldUseColorOutput: returns false for non-TTY stream without env overrides', (t) => {
  const origNo = process.env.NO_COLOR
  const origForce = process.env.FORCE_COLOR
  t.after(() => {
    if (origNo === undefined) delete process.env.NO_COLOR
    else process.env.NO_COLOR = origNo
    if (origForce === undefined) delete process.env.FORCE_COLOR
    else process.env.FORCE_COLOR = origForce
  })
  delete process.env.NO_COLOR
  delete process.env.FORCE_COLOR
  assert.equal(shouldUseColorOutput({ isTTY: false }), false)
  assert.equal(shouldUseColorOutput({}), false)
})

// --- colorizeCliText ---

test('colorizeCliText: wraps text with ANSI codes when enabled', () => {
  const result = colorizeCliText('hello', ['\u001b[1m'], true)
  assert.equal(result, '\u001b[1mhello\u001b[0m')
})

test('colorizeCliText: returns plain text when disabled', () => {
  assert.equal(colorizeCliText('hello', ['\u001b[1m'], false), 'hello')
})

test('colorizeCliText: returns plain text when styles array is empty', () => {
  assert.equal(colorizeCliText('hello', [], true), 'hello')
})

test('colorizeCliText: supports multiple style codes', () => {
  const result = colorizeCliText('hello', ['\u001b[1m', '\u001b[31m'], true)
  assert.equal(result, '\u001b[1m\u001b[31mhello\u001b[0m')
})

// --- formatCodeownersOwnersList ---

test('formatCodeownersOwnersList: joins owners with commas', () => {
  assert.equal(formatCodeownersOwnersList(['@team-a', '@team-b']), '@team-a, @team-b')
})

test('formatCodeownersOwnersList: returns single owner', () => {
  assert.equal(formatCodeownersOwnersList(['@solo']), '@solo')
})

test('formatCodeownersOwnersList: returns "(none)" for empty array', () => {
  assert.equal(formatCodeownersOwnersList([]), '(none)')
})

test('formatCodeownersOwnersList: returns "(none)" for undefined', () => {
  assert.equal(formatCodeownersOwnersList(undefined), '(none)')
})

// --- formatCodeownersDiscoveryWarningForCli ---

test('formatCodeownersDiscoveryWarningForCli: formats unsupported location warning', () => {
  const warning = /** @type {const} */ ({ path: '.github/CODEOWNERS2', type: 'unsupported-location', message: 'CODEOWNERS file found in unsupported location' })
  const result = stripAnsi(formatCodeownersDiscoveryWarningForCli(warning, false))
  assert.ok(result.includes('.github/CODEOWNERS2'))
  assert.ok(result.includes('unsupported location'))
})

test('formatCodeownersDiscoveryWarningForCli: formats unused supported location warning', () => {
  const warning = /** @type {const} */ ({
    path: 'docs/CODEOWNERS',
    type: 'unused-supported-location',
    referencePath: '.github/CODEOWNERS',
    message: 'CODEOWNERS file is unused because .github/CODEOWNERS takes precedence',
  })
  const result = stripAnsi(formatCodeownersDiscoveryWarningForCli(warning, false))
  assert.ok(result.includes('docs/CODEOWNERS'))
  assert.ok(result.includes('.github/CODEOWNERS'))
  assert.ok(result.includes('is unused because'))
})

// --- formatMissingPathWarningForCli ---

test('formatMissingPathWarningForCli: formats pattern and owners', () => {
  const warning = { codeownersPath: '.github/CODEOWNERS', pattern: '/nonexistent/', owners: ['@team-a', '@team-b'] }
  const result = stripAnsi(formatMissingPathWarningForCli(warning, false))
  assert.ok(result.includes('/nonexistent/'))
  assert.ok(result.includes('@team-a, @team-b'))
})

// --- formatUnprotectedDirectoryWarningForCli ---

test('formatUnprotectedDirectoryWarningForCli: formats directory with file count', () => {
  const warning = { directory: 'src/utils', fileCount: 5 }
  const result = stripAnsi(formatUnprotectedDirectoryWarningForCli(warning, false))
  assert.ok(result.includes('src/utils/'))
  assert.ok(result.includes('5 files'))
  assert.ok(result.includes('new files will lack owners'))
})

test('formatUnprotectedDirectoryWarningForCli: singular file count', () => {
  const warning = { directory: 'lib', fileCount: 1 }
  const result = stripAnsi(formatUnprotectedDirectoryWarningForCli(warning, false))
  assert.ok(result.includes('lib/'))
  assert.ok(result.includes('1 file)'))
  assert.ok(!result.includes('1 files'))
})

test('formatUnprotectedDirectoryWarningForCli: root directory', () => {
  const warning = { directory: '/', fileCount: 3 }
  const result = stripAnsi(formatUnprotectedDirectoryWarningForCli(warning, false))
  assert.ok(result.includes('/'))
  assert.ok(result.includes('3 files'))
})
