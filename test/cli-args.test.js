import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseArgs,
  TEAM_SUGGESTIONS_DEFAULT_WINDOW_DAYS,
  TEAM_SUGGESTIONS_DEFAULT_TOP,
  GITHUB_API_BASE_URL,
} from '../lib/cli-args.js'

// --- defaults ---

test('parseArgs: returns defaults with no arguments', () => {
  const result = parseArgs([])
  assert.equal(result.repoOrPath, undefined)
  assert.equal(result.includeUntracked, false)
  assert.equal(result.noReport, false)
  assert.equal(result.listUnowned, false)
  assert.equal(result.failOnUnowned, false)
  assert.equal(result.failOnMissingPaths, false)
  assert.equal(result.failOnLocationWarnings, false)
  assert.deepEqual(result.checkGlobs, ['**'])
  assert.equal(result.teamSuggestions, false)
  assert.equal(result.teamSuggestionsWindowDays, TEAM_SUGGESTIONS_DEFAULT_WINDOW_DAYS)
  assert.equal(result.teamSuggestionsTop, TEAM_SUGGESTIONS_DEFAULT_TOP)
  assert.deepEqual(result.teamSuggestionsIgnoreTeams, [])
  assert.equal(result.githubOrg, null)
  assert.equal(result.githubToken, undefined)
  assert.equal(result.githubApiBaseUrl, GITHUB_API_BASE_URL)
  assert.equal(result.upload, false)
  assert.equal(result.yes, false)
  assert.equal(result.open, true)
  assert.equal(result.verbose, false)
  assert.equal(result.help, false)
  assert.equal(result.version, false)
})

// --- positional argument ---

test('parseArgs: accepts positional repo-or-path', () => {
  const result = parseArgs(['owner/repo'])
  assert.equal(result.repoOrPath, 'owner/repo')
})

// --- boolean flags ---

test('parseArgs: --include-untracked', () => {
  assert.equal(parseArgs(['--include-untracked']).includeUntracked, true)
})

test('parseArgs: --no-report', () => {
  assert.equal(parseArgs(['--no-report']).noReport, true)
})

test('parseArgs: --list-unowned', () => {
  assert.equal(parseArgs(['--list-unowned']).listUnowned, true)
})

test('parseArgs: --fail-on-unowned', () => {
  assert.equal(parseArgs(['--fail-on-unowned']).failOnUnowned, true)
})

test('parseArgs: --fail-on-missing-paths', () => {
  assert.equal(parseArgs(['--fail-on-missing-paths']).failOnMissingPaths, true)
})

test('parseArgs: --fail-on-location-warnings', () => {
  assert.equal(parseArgs(['--fail-on-location-warnings']).failOnLocationWarnings, true)
})

test('parseArgs: --suggest-teams', () => {
  assert.equal(parseArgs(['--suggest-teams']).teamSuggestions, true)
})

test('parseArgs: --upload', () => {
  assert.equal(parseArgs(['--upload']).upload, true)
})

test('parseArgs: --yes and -y', () => {
  assert.equal(parseArgs(['--yes']).yes, true)
  assert.equal(parseArgs(['-y']).yes, true)
})

test('parseArgs: --no-open', () => {
  assert.equal(parseArgs(['--no-open']).open, false)
})

test('parseArgs: --verbose', () => {
  assert.equal(parseArgs(['--verbose']).verbose, true)
})

test('parseArgs: --help and -h', () => {
  assert.equal(parseArgs(['--help']).help, true)
  assert.equal(parseArgs(['-h']).help, true)
})

test('parseArgs: --version and -v', () => {
  assert.equal(parseArgs(['--version']).version, true)
  assert.equal(parseArgs(['-v']).version, true)
})

// --- string options (space and = forms) ---

test('parseArgs: --output and -o', () => {
  assert.equal(parseArgs(['--output', '/tmp/out.html']).outputPath, '/tmp/out.html')
  assert.equal(parseArgs(['-o', '/tmp/out.html']).outputPath, '/tmp/out.html')
  assert.equal(parseArgs(['--output=/tmp/out.html']).outputPath, '/tmp/out.html')
})

test('parseArgs: --cwd', () => {
  assert.equal(parseArgs(['--cwd', '/some/dir']).workingDir, '/some/dir')
  assert.equal(parseArgs(['--cwd=/some/dir']).workingDir, '/some/dir')
})

test('parseArgs: --github-org', () => {
  assert.equal(parseArgs(['--github-org', 'my-org']).githubOrg, 'my-org')
  assert.equal(parseArgs(['--github-org=my-org']).githubOrg, 'my-org')
})

test('parseArgs: --github-token', () => {
  assert.equal(parseArgs(['--github-token', 'tok123']).githubToken, 'tok123')
  assert.equal(parseArgs(['--github-token=tok123']).githubToken, 'tok123')
})

test('parseArgs: --github-api-base-url', () => {
  const url = 'https://api.github.example.com'
  assert.equal(parseArgs(['--github-api-base-url', url]).githubApiBaseUrl, url)
  assert.equal(parseArgs([`--github-api-base-url=${url}`]).githubApiBaseUrl, url)
})

// --- numeric options ---

test('parseArgs: --suggest-window-days', () => {
  assert.equal(parseArgs(['--suggest-window-days', '90']).teamSuggestionsWindowDays, 90)
  assert.equal(parseArgs(['--suggest-window-days=90']).teamSuggestionsWindowDays, 90)
})

test('parseArgs: --suggest-top', () => {
  assert.equal(parseArgs(['--suggest-top', '5']).teamSuggestionsTop, 5)
  assert.equal(parseArgs(['--suggest-top=5']).teamSuggestionsTop, 5)
})

// --- glob options ---

test('parseArgs: --glob and -g (repeatable)', () => {
  const result = parseArgs(['--glob', 'src/**', '-g', 'lib/**'])
  assert.deepEqual(result.checkGlobs, ['src/**', 'lib/**'])
})

test('parseArgs: --glob= form', () => {
  const result = parseArgs(['--glob=src/**'])
  assert.deepEqual(result.checkGlobs, ['src/**'])
})

test('parseArgs: deduplicates globs', () => {
  const result = parseArgs(['--glob', 'src/**', '--glob', 'src/**'])
  assert.deepEqual(result.checkGlobs, ['src/**'])
})

// --- validation errors ---

test('parseArgs: throws on unknown argument', () => {
  assert.throws(() => parseArgs(['--unknown-flag']), /Unknown argument/)
})

test('parseArgs: throws when --cwd and positional are both given', () => {
  assert.throws(() => parseArgs(['owner/repo', '--cwd', '/dir']), /Cannot specify both/)
})

test('parseArgs: throws when --suggest-window-days < 1', () => {
  assert.throws(() => parseArgs(['--suggest-window-days', '0']), /must be >= 1/)
})

test('parseArgs: throws when --suggest-top < 1', () => {
  assert.throws(() => parseArgs(['--suggest-top', '0']), /must be >= 1/)
})

test('parseArgs: throws when --github-api-base-url is invalid', () => {
  assert.throws(() => parseArgs(['--github-api-base-url', 'not-a-url']), /Invalid value/)
})

test('parseArgs: throws on missing --output value', () => {
  assert.throws(() => parseArgs(['--output']), /Missing value/)
})

test('parseArgs: throws on missing --cwd value', () => {
  assert.throws(() => parseArgs(['--cwd']), /Missing value/)
})

test('parseArgs: throws on missing --github-org value', () => {
  assert.throws(() => parseArgs(['--github-org']), /Missing value/)
})

test('parseArgs: throws on non-numeric --suggest-window-days', () => {
  assert.throws(() => parseArgs(['--suggest-window-days', 'abc']), /Invalid numeric/)
})

// --- help bypasses validation ---

test('parseArgs: --help skips most validation', () => {
  // With --help, conflicting args and missing values are tolerated
  const result = parseArgs(['--help', '--suggest-window-days', '0'])
  assert.equal(result.help, true)
})
