import assert from 'node:assert/strict'
import test from 'node:test'

import { parseRemoteUrlToOwnerRepo, resolveGithubToken } from '../lib/github-identity.js'

// --- parseRemoteUrlToOwnerRepo ---

test('parseRemoteUrlToOwnerRepo: parses SSH URL', () => {
  assert.deepEqual(
    parseRemoteUrlToOwnerRepo('git@github.com:my-org/my-repo.git'),
    { owner: 'my-org', repo: 'my-repo' }
  )
})

test('parseRemoteUrlToOwnerRepo: parses SSH URL without .git suffix', () => {
  assert.deepEqual(
    parseRemoteUrlToOwnerRepo('git@github.com:owner/repo'),
    { owner: 'owner', repo: 'repo' }
  )
})

test('parseRemoteUrlToOwnerRepo: parses HTTPS URL', () => {
  assert.deepEqual(
    parseRemoteUrlToOwnerRepo('https://github.com/owner/repo.git'),
    { owner: 'owner', repo: 'repo' }
  )
})

test('parseRemoteUrlToOwnerRepo: parses HTTPS URL without .git suffix', () => {
  assert.deepEqual(
    parseRemoteUrlToOwnerRepo('https://github.com/owner/repo'),
    { owner: 'owner', repo: 'repo' }
  )
})

test('parseRemoteUrlToOwnerRepo: handles non-GitHub hosts', () => {
  assert.deepEqual(
    parseRemoteUrlToOwnerRepo('https://gitlab.example.com/team/project.git'),
    { owner: 'team', repo: 'project' }
  )
})

test('parseRemoteUrlToOwnerRepo: returns null for unrecognized formats', () => {
  assert.equal(parseRemoteUrlToOwnerRepo('not-a-url'), null)
})

test('parseRemoteUrlToOwnerRepo: returns null for URL with single path segment', () => {
  assert.equal(parseRemoteUrlToOwnerRepo('https://github.com/only-one'), null)
})

// --- resolveGithubToken ---

test('resolveGithubToken: uses CLI token when provided', () => {
  const result = resolveGithubToken('my-cli-token')
  assert.deepEqual(result, { token: 'my-cli-token', source: 'cli' })
})

test('resolveGithubToken: falls back to GITHUB_TOKEN env var', (t) => {
  const origGH = process.env.GITHUB_TOKEN
  const origGHCli = process.env.GH_TOKEN
  t.after(() => {
    if (origGH === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = origGH
    if (origGHCli === undefined) delete process.env.GH_TOKEN
    else process.env.GH_TOKEN = origGHCli
  })
  process.env.GITHUB_TOKEN = 'env-github-token'
  delete process.env.GH_TOKEN

  const result = resolveGithubToken(undefined)
  assert.deepEqual(result, { token: 'env-github-token', source: 'GITHUB_TOKEN' })
})

test('resolveGithubToken: falls back to GH_TOKEN env var', (t) => {
  const origGH = process.env.GITHUB_TOKEN
  const origGHCli = process.env.GH_TOKEN
  t.after(() => {
    if (origGH === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = origGH
    if (origGHCli === undefined) delete process.env.GH_TOKEN
    else process.env.GH_TOKEN = origGHCli
  })
  delete process.env.GITHUB_TOKEN
  process.env.GH_TOKEN = 'env-gh-token'

  const result = resolveGithubToken(undefined)
  assert.deepEqual(result, { token: 'env-gh-token', source: 'GH_TOKEN' })
})

test('resolveGithubToken: returns empty token with source "none" when nothing available', (t) => {
  const origGH = process.env.GITHUB_TOKEN
  const origGHCli = process.env.GH_TOKEN
  t.after(() => {
    if (origGH === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = origGH
    if (origGHCli === undefined) delete process.env.GH_TOKEN
    else process.env.GH_TOKEN = origGHCli
  })
  delete process.env.GITHUB_TOKEN
  delete process.env.GH_TOKEN

  const result = resolveGithubToken(undefined)
  assert.deepEqual(result, { token: '', source: 'none' })
})
