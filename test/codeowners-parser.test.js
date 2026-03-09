import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseCodeowners,
  parseCodeownersRuleLine,
  createPatternMatcher,
  findMatchingOwners,
} from '../lib/codeowners-parser.js'

// --- parseCodeownersRuleLine ---

test('parseCodeownersRuleLine: parses a simple rule', () => {
  const result = parseCodeownersRuleLine('*.js @owner')
  assert.deepEqual(result, { pattern: '*.js', owners: ['@owner'] })
})

test('parseCodeownersRuleLine: parses multiple owners', () => {
  const result = parseCodeownersRuleLine('/src/ @team-a @team-b @user')
  assert.deepEqual(result, { pattern: '/src/', owners: ['@team-a', '@team-b', '@user'] })
})

test('parseCodeownersRuleLine: returns null for blank lines', () => {
  assert.equal(parseCodeownersRuleLine(''), null)
  assert.equal(parseCodeownersRuleLine('   '), null)
})

test('parseCodeownersRuleLine: returns null for comment lines', () => {
  assert.equal(parseCodeownersRuleLine('# this is a comment'), null)
  assert.equal(parseCodeownersRuleLine('  # indented comment'), null)
})

test('parseCodeownersRuleLine: returns null for pattern-only lines (no owners)', () => {
  assert.equal(parseCodeownersRuleLine('/src/'), null)
})

test('parseCodeownersRuleLine: returns null for negation patterns', () => {
  assert.equal(parseCodeownersRuleLine('!/src/ @owner'), null)
})

test('parseCodeownersRuleLine: strips inline comments', () => {
  const result = parseCodeownersRuleLine('*.js @owner # inline comment')
  assert.deepEqual(result, { pattern: '*.js', owners: ['@owner'] })
})

test('parseCodeownersRuleLine: preserves escaped hash in pattern', () => {
  const result = parseCodeownersRuleLine('\\#file @owner')
  assert.deepEqual(result, { pattern: '#file', owners: ['@owner'] })
})

test('parseCodeownersRuleLine: handles escaped spaces in pattern', () => {
  const result = parseCodeownersRuleLine('path\\ with\\ spaces @owner')
  assert.deepEqual(result, { pattern: 'path with spaces', owners: ['@owner'] })
})

// --- createPatternMatcher ---

test('createPatternMatcher: matches simple file extension', () => {
  const matches = createPatternMatcher('*.js')
  assert.ok(matches('app.js'))
  assert.ok(matches('src/app.js'))
  assert.ok(!matches('app.ts'))
  assert.ok(!matches('app.jsx'))
})

test('createPatternMatcher: anchored pattern matches from root only', () => {
  const matches = createPatternMatcher('/src/')
  assert.ok(matches('src/file.js'))
  assert.ok(!matches('lib/src/file.js'))
})

test('createPatternMatcher: unanchored pattern matches anywhere', () => {
  const matches = createPatternMatcher('docs/')
  assert.ok(matches('docs/readme.md'))
  assert.ok(matches('project/docs/readme.md'))
})

test('createPatternMatcher: directory pattern matches descendants', () => {
  const matches = createPatternMatcher('/src/')
  assert.ok(matches('src/a.js'))
  assert.ok(matches('src/nested/b.js'))
})

test('createPatternMatcher: double star matches across directories', () => {
  const matches = createPatternMatcher('/src/**/*.js')
  assert.ok(matches('src/nested/app.js'))
  assert.ok(matches('src/deep/nested/app.js'))
  assert.ok(!matches('src/nested/app.ts'))
})

test('createPatternMatcher: single star does not cross directory boundary', () => {
  const matches = createPatternMatcher('/src/*.js')
  assert.ok(matches('src/app.js'))
  assert.ok(!matches('src/nested/app.js'))
})

test('createPatternMatcher: question mark matches single non-slash character', () => {
  const matches = createPatternMatcher('file?.js')
  assert.ok(matches('file1.js'))
  assert.ok(matches('fileA.js'))
  assert.ok(!matches('file.js'))
  assert.ok(!matches('file12.js'))
})

test('createPatternMatcher: empty pattern after stripping slashes never matches', () => {
  const matches = createPatternMatcher('/')
  assert.ok(!matches('anything'))
  assert.ok(!matches(''))
})

test('createPatternMatcher: includeDescendants option', () => {
  const withDescendants = createPatternMatcher('src', { includeDescendants: true })
  assert.ok(withDescendants('src'))
  assert.ok(withDescendants('src/file.js'))
  assert.ok(withDescendants('src/nested/file.js'))

  const withoutDescendants = createPatternMatcher('src', { includeDescendants: false })
  assert.ok(withoutDescendants('src'))
  assert.ok(!withoutDescendants('src/file.js'))
})

test('createPatternMatcher: includeDescendants does not apply when last segment has wildcards', () => {
  const matches = createPatternMatcher('*.js', { includeDescendants: true })
  assert.ok(matches('app.js'))
  assert.ok(!matches('app.js/something'))
})

test('createPatternMatcher: escapes regex special characters in pattern', () => {
  const matches = createPatternMatcher('/file.name+test.js')
  assert.ok(matches('file.name+test.js'))
  assert.ok(!matches('fileXnameXtestXjs'))
})

// --- parseCodeowners ---

test('parseCodeowners: parses multi-line content into rules', () => {
  const content = [
    '# Comment',
    '',
    '*.js @js-team',
    '/docs/ @docs-team',
    '*.ts @ts-team @js-team',
  ].join('\n')

  const rules = parseCodeowners(content)
  assert.equal(rules.length, 3)
  assert.equal(rules[0].pattern, '*.js')
  assert.deepEqual(rules[0].owners, ['@js-team'])
  assert.equal(rules[1].pattern, '/docs/')
  assert.deepEqual(rules[1].owners, ['@docs-team'])
  assert.equal(rules[2].pattern, '*.ts')
  assert.deepEqual(rules[2].owners, ['@ts-team', '@js-team'])
})

test('parseCodeowners: each rule has a working matches function', () => {
  const rules = parseCodeowners('*.js @owner\n/docs/ @docs')
  assert.ok(rules[0].matches('app.js'))
  assert.ok(!rules[0].matches('app.ts'))
  assert.ok(rules[1].matches('docs/readme.md'))
  assert.ok(!rules[1].matches('src/docs/readme.md'))
})

test('parseCodeowners: handles CRLF line endings', () => {
  const rules = parseCodeowners('*.js @owner\r\n*.ts @owner2\r\n')
  assert.equal(rules.length, 2)
})

test('parseCodeowners: returns empty array for empty content', () => {
  assert.deepEqual(parseCodeowners(''), [])
  assert.deepEqual(parseCodeowners('\n\n\n'), [])
})

// --- findMatchingOwners ---

test('findMatchingOwners: returns last matching rule owners', () => {
  const rules = parseCodeowners('* @default\n*.js @js-team\n/src/ @src-team')
  // src/app.js matches all three rules; last match wins
  const owners = findMatchingOwners('src/app.js', rules)
  assert.deepEqual(owners, ['@src-team'])
})

test('findMatchingOwners: returns undefined when no rules match', () => {
  const rules = parseCodeowners('/docs/ @docs-team')
  const owners = findMatchingOwners('src/app.js', rules)
  assert.equal(owners, undefined)
})

test('findMatchingOwners: returns first rule for catch-all pattern', () => {
  const rules = parseCodeowners('* @default-team')
  const owners = findMatchingOwners('any/file/path.txt', rules)
  assert.deepEqual(owners, ['@default-team'])
})
