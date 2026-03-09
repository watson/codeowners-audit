import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isRepoUrl,
  normalizeRepoUrl,
  deriveDisplayNameFromUrl,
  deriveRepoWebUrlFromRemoteUrl,
} from '../lib/repository.js'

// --- isRepoUrl ---

test('isRepoUrl: recognizes HTTPS URLs', () => {
  assert.ok(isRepoUrl('https://github.com/owner/repo.git'))
  assert.ok(isRepoUrl('http://gitlab.example.com/owner/repo'))
})

test('isRepoUrl: recognizes SSH URLs', () => {
  assert.ok(isRepoUrl('git@github.com:owner/repo.git'))
})

test('isRepoUrl: recognizes GitHub shorthand (owner/repo)', () => {
  assert.ok(isRepoUrl('owner/repo'))
  assert.ok(isRepoUrl('my-org/my-repo'))
  assert.ok(isRepoUrl('user123/repo.name'))
})

test('isRepoUrl: rejects local paths', () => {
  assert.ok(!isRepoUrl('.'))
  assert.ok(!isRepoUrl('./some/path'))
  assert.ok(!isRepoUrl('/absolute/path'))
  assert.ok(!isRepoUrl('relative-dir'))
})

test('isRepoUrl: rejects shorthand with invalid characters', () => {
  assert.ok(!isRepoUrl('owner/repo/extra'))
  assert.ok(!isRepoUrl('-invalid/repo'))
})

// --- normalizeRepoUrl ---

test('normalizeRepoUrl: returns full URLs unchanged', () => {
  const url = 'https://github.com/owner/repo.git'
  assert.equal(normalizeRepoUrl(url), url)
})

test('normalizeRepoUrl: returns SSH URLs unchanged', () => {
  const url = 'git@github.com:owner/repo.git'
  assert.equal(normalizeRepoUrl(url), url)
})

test('normalizeRepoUrl: expands GitHub shorthand to HTTPS URL', () => {
  assert.equal(normalizeRepoUrl('owner/repo'), 'https://github.com/owner/repo.git')
})

// --- deriveDisplayNameFromUrl ---

test('deriveDisplayNameFromUrl: extracts owner/repo from HTTPS URL', () => {
  assert.equal(deriveDisplayNameFromUrl('https://github.com/owner/repo.git'), 'owner/repo')
  assert.equal(deriveDisplayNameFromUrl('https://github.com/owner/repo'), 'owner/repo')
})

test('deriveDisplayNameFromUrl: extracts owner/repo from SSH URL', () => {
  assert.equal(deriveDisplayNameFromUrl('git@github.com:owner/repo.git'), 'owner/repo')
  assert.equal(deriveDisplayNameFromUrl('git@github.com:owner/repo'), 'owner/repo')
})

test('deriveDisplayNameFromUrl: handles file:// URLs', () => {
  const name = deriveDisplayNameFromUrl('file:///home/user/my-repo.git')
  assert.equal(name, 'my-repo')
})

test('deriveDisplayNameFromUrl: falls back to URL for unrecognized formats', () => {
  const url = 'some-unknown-format'
  assert.equal(deriveDisplayNameFromUrl(url), url)
})

// --- deriveRepoWebUrlFromRemoteUrl ---

test('deriveRepoWebUrlFromRemoteUrl: converts SSH to HTTPS web URL', () => {
  assert.equal(
    deriveRepoWebUrlFromRemoteUrl('git@github.com:owner/repo.git'),
    'https://github.com/owner/repo'
  )
})

test('deriveRepoWebUrlFromRemoteUrl: converts HTTPS clone URL to web URL', () => {
  assert.equal(
    deriveRepoWebUrlFromRemoteUrl('https://github.com/owner/repo.git'),
    'https://github.com/owner/repo'
  )
})

test('deriveRepoWebUrlFromRemoteUrl: preserves non-GitHub hosts', () => {
  assert.equal(
    deriveRepoWebUrlFromRemoteUrl('git@gitlab.example.com:team/project.git'),
    'https://gitlab.example.com/team/project'
  )
})

test('deriveRepoWebUrlFromRemoteUrl: returns null for file:// URLs', () => {
  assert.equal(deriveRepoWebUrlFromRemoteUrl('file:///home/user/repo.git'), null)
})

test('deriveRepoWebUrlFromRemoteUrl: returns null for unrecognized formats', () => {
  assert.equal(deriveRepoWebUrlFromRemoteUrl('not-a-url'), null)
})
