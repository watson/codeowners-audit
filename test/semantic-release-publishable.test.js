import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  analyzeCommits,
  generateNotes,
  getPublishableCommits,
} from '../scripts/semantic-release-publishable.mjs'

function runGit (cwd, args, options = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...(options.env || {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function createRepo (t) {
  const repoDir = mkdtempSync(path.join(tmpdir(), 'codeowners-audit-release-test-'))
  t.after(() => {
    rmSync(repoDir, { recursive: true, force: true })
  })

  runGit(repoDir, ['init'])

  writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({
    name: 'codeowners-audit-test-fixture',
    version: '1.0.0',
  }, null, 2) + '\n')
  writeFileSync(path.join(repoDir, 'report.js'), 'console.log("hello")\n')
  mkdirSync(path.join(repoDir, 'lib'), { recursive: true })
  writeFileSync(path.join(repoDir, 'lib', 'index.js'), 'export const value = 1\n')

  runGit(repoDir, ['add', '.'])
  commit(repoDir, 'chore: initial release')

  return repoDir
}

function commit (repoDir, message) {
  runGit(
    repoDir,
    [
      '-c', 'user.name=Codeowners Audit Tests',
      '-c', 'user.email=codeowners-audit-tests@example.com',
      'commit',
      '-m', message,
    ]
  )

  return {
    hash: runGit(repoDir, ['rev-parse', 'HEAD']).trim(),
    message,
  }
}

function commitFile (repoDir, filePath, content, message) {
  const absolutePath = path.join(repoDir, filePath)
  mkdirSync(path.dirname(absolutePath), { recursive: true })
  writeFileSync(absolutePath, content, 'utf8')
  runGit(repoDir, ['add', filePath])
  return commit(repoDir, message)
}

function createLogger () {
  return {
    log () {},
  }
}

test('getPublishableCommits keeps only commits that touch release paths', (t) => {
  const repoDir = createRepo(t)
  const docsCommit = commitFile(repoDir, 'README.md', '# docs\n', 'feat: rewrite README')
  const fixCommit = commitFile(repoDir, 'lib/index.js', 'export const value = 2\n', 'fix: respect ignored CODEOWNERS warnings')
  const perfCommit = commitFile(repoDir, 'lib/report.template.html', '<html>fast</html>\n', 'perf: shrink report template')

  const publishableCommits = getPublishableCommits(
    {
      releasePaths: ['report.js', 'lib/**', 'package.json'],
    },
    {
      cwd: repoDir,
      commits: [perfCommit, fixCommit, docsCommit],
      logger: createLogger(),
    }
  )

  assert.deepEqual(
    publishableCommits.map((commit) => commit.hash),
    [perfCommit.hash, fixCommit.hash]
  )
  assert.deepEqual(publishableCommits[0].publishableFiles, ['lib/report.template.html'])
  assert.deepEqual(publishableCommits[1].publishableFiles, ['lib/index.js'])
})

test('analyzeCommits ignores semantic commits that only touch non-publishable files', async (t) => {
  const repoDir = createRepo(t)
  const docsCommit = commitFile(repoDir, 'README.md', '# docs\n', 'feat: rewrite README')
  const fixCommit = commitFile(repoDir, 'lib/index.js', 'export const value = 2\n', 'fix: respect ignored CODEOWNERS warnings')

  const releaseType = await analyzeCommits(
    {
      releasePaths: ['report.js', 'lib/**', 'package.json'],
    },
    {
      cwd: repoDir,
      commits: [fixCommit, docsCommit],
      logger: createLogger(),
    }
  )

  assert.equal(releaseType, 'patch')
})

test('generateNotes excludes semantic commits that only touch non-publishable files', async (t) => {
  const repoDir = createRepo(t)
  const docsCommit = commitFile(repoDir, 'README.md', '# docs\n', 'feat: rewrite README')
  const fixCommit = commitFile(repoDir, 'lib/index.js', 'export const value = 2\n', 'fix: respect ignored CODEOWNERS warnings')

  const notes = await generateNotes(
    {
      releasePaths: ['report.js', 'lib/**', 'package.json'],
    },
    {
      cwd: repoDir,
      commits: [fixCommit, docsCommit],
      lastRelease: {
        gitTag: 'v1.0.0',
        gitHead: '1111111',
      },
      nextRelease: {
        version: '1.0.1',
        gitTag: 'v1.0.1',
        gitHead: fixCommit.hash,
      },
      options: {
        repositoryUrl: 'https://github.com/watson/codeowners-audit.git',
      },
      logger: createLogger(),
    }
  )

  assert.match(notes, /Only conventional commits that touched publishable CLI\/runtime files/)
  assert.match(notes, /respect ignored CODEOWNERS warnings/)
  assert.doesNotMatch(notes, /rewrite README/)
})
