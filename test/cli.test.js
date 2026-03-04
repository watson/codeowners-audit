import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync, existsSync, chmodSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliPath = path.join(projectRoot, 'report.js')
const packageVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const defaultOutputFile = 'codeowners-gaps-report.html'

function parseOutputPathFromStdout (stdout) {
  const match = stdout.match(/Wrote CODEOWNERS gap report to (.+) \(\d+ analyzed files, \d+ unowned\)\./)
  assert.ok(match, 'stdout should include the report output path')
  return match[1]
}

function runCli (args, options = {}) {
  const cliArgs = options.noOpen === false ? args : ['--no-open', ...args]
  return spawnSync(process.execPath, [cliPath, ...cliArgs], {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...(options.env || {}),
    },
    encoding: 'utf8',
  })
}

function runCliAsync (args, options = {}) {
  const cliArgs = options.noOpen === false ? args : ['--no-open', ...args]
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...cliArgs], {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...(options.env || {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', (status) => {
      resolve({
        status,
        stdout,
        stderr,
      })
    })
  })
}

function runGit (cwd, args, options = {}) {
  execFileSync('git', args, {
    cwd,
    env: {
      ...process.env,
      ...(options.env || {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function isoTimestampDaysAgo (daysAgo) {
  return new Date(Date.now() - (daysAgo * 24 * 60 * 60 * 1000)).toISOString()
}

function commitStaged (repoDir, message, daysAgo, authorName, authorEmail) {
  const timestamp = isoTimestampDaysAgo(daysAgo)
  runGit(
    repoDir,
    [
      '-c', 'user.name=Codeowners Audit Tests',
      '-c', 'user.email=codeowners-audit-tests@example.com',
      'commit',
      '-m', message,
    ],
    {
      env: {
        GIT_AUTHOR_NAME: authorName,
        GIT_AUTHOR_EMAIL: authorEmail,
        GIT_AUTHOR_DATE: timestamp,
        GIT_COMMITTER_DATE: timestamp,
      },
    }
  )
}

function createRepo (t, options = {}) {
  const repoDir = mkdtempSync(path.join(tmpdir(), 'codeowners-audit-test-'))
  t.after(() => {
    rmSync(repoDir, { recursive: true, force: true })
  })

  runGit(repoDir, ['init'])

  const files = {
    CODEOWNERS: options.codeowners || '/src/owned.js @team\n',
    'src/owned.js': 'module.exports = 1\n',
    'src/unowned.js': 'module.exports = 2\n',
    ...(options.trackedFiles || {}),
  }

  for (const [filePath, content] of Object.entries(files)) {
    const absolutePath = path.join(repoDir, filePath)
    mkdirSync(path.dirname(absolutePath), { recursive: true })
    writeFileSync(absolutePath, content, 'utf8')
  }

  runGit(repoDir, ['add', '.'])

  if (options.remoteUrl) {
    runGit(repoDir, ['remote', 'add', 'origin', options.remoteUrl])
  }

  if (options.untrackedFiles) {
    for (const [filePath, content] of Object.entries(options.untrackedFiles)) {
      const absolutePath = path.join(repoDir, filePath)
      mkdirSync(path.dirname(absolutePath), { recursive: true })
      writeFileSync(absolutePath, content, 'utf8')
    }
  }

  return repoDir
}

function parseReportDataFromHtml (html) {
  const match = html.match(/<script type="application\/json" id="report-data">([\s\S]*?)<\/script>/)
  assert.ok(match, 'report JSON should exist in report-data script tag')
  return JSON.parse(match[1])
}

function getOpenCommandName () {
  if (process.platform === 'darwin') return 'open'
  if (process.platform === 'win32') return null
  return 'xdg-open'
}

test('running the bin creates a report in temp dir with expected shape', (t) => {
  const repoDir = createRepo(t)

  const result = runCli([], { cwd: repoDir })

  assert.equal(result.status, 0, result.stderr)
  const outputPath = parseOutputPathFromStdout(result.stdout)
  assert.ok(outputPath.startsWith(tmpdir()), 'default report should be written in a temp directory')
  assert.ok(existsSync(outputPath), 'default report should be written to disk')
  assert.equal(existsSync(path.join(repoDir, defaultOutputFile)), false, 'default report should not be written in repository root')
  assert.match(result.stdout, /Wrote CODEOWNERS gap report/)

  const html = readFileSync(outputPath, 'utf8')
  assert.match(html, /<title>CODEOWNERS Gap Report<\/title>/)

  const reportData = parseReportDataFromHtml(html)
  assert.equal(reportData.options.includeUntracked, false)
  assert.equal(Object.hasOwn(reportData, 'topLevel'), false)
  assert.ok(reportData.totals.files >= 3)
  assert.ok(reportData.unownedFiles.includes('src/unowned.js'))
  assert.equal(Array.isArray(reportData.directoryTeamSuggestions), true)
  assert.equal(reportData.directoryTeamSuggestions.length, 0)
  assert.equal(reportData.directoryTeamSuggestionsMeta.enabled, false)
  assert.deepEqual(reportData.directoryTeamSuggestionsMeta.ignoredTeams, [])
})

test('team suggestions map editors to repo teams for 0% covered directories', async (t) => {
  const repoDir = createRepo(t, {
    remoteUrl: 'git@github.com:test-org/test-repo.git',
    trackedFiles: {
      'pkg/uncovered/a.js': 'module.exports = "a1"\n',
      'pkg/uncovered/b.js': 'module.exports = "b1"\n',
    },
  })

  commitStaged(repoDir, 'initial snapshot outside window', 500, 'Bootstrap', 'bootstrap@example.com')

  writeFileSync(path.join(repoDir, 'pkg/uncovered/a.js'), 'module.exports = "a2"\n', 'utf8')
  runGit(repoDir, ['add', 'pkg/uncovered/a.js'])
  commitStaged(repoDir, 'alice update 1', 30, 'Alice', '123+alice@users.noreply.github.com')

  writeFileSync(path.join(repoDir, 'pkg/uncovered/a.js'), 'module.exports = "a3"\n', 'utf8')
  runGit(repoDir, ['add', 'pkg/uncovered/a.js'])
  commitStaged(repoDir, 'alice update 2', 20, 'Alice', '123+alice@users.noreply.github.com')

  writeFileSync(path.join(repoDir, 'pkg/uncovered/b.js'), 'module.exports = "b2"\n', 'utf8')
  runGit(repoDir, ['add', 'pkg/uncovered/b.js'])
  commitStaged(repoDir, 'bob update', 10, 'Bob', '456+bob@users.noreply.github.com')

  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    res.setHeader('content-type', 'application/json')
    if (url.pathname === '/repos/test-org/test-repo/teams') {
      res.end(JSON.stringify([
        { slug: 'alpha-team', name: 'Alpha Team' },
        { slug: 'beta-team', name: 'Beta Team' },
      ]))
      return
    }
    if (url.pathname === '/orgs/test-org/teams/alpha-team/members') {
      res.end(JSON.stringify([
        { login: 'alice' },
      ]))
      return
    }
    if (url.pathname === '/orgs/test-org/teams/beta-team/members') {
      res.end(JSON.stringify([
        { login: 'bob' },
      ]))
      return
    }
    res.statusCode = 404
    res.end(JSON.stringify({ message: 'not found' }))
  })
  await /** @type {Promise<void>} */ (
    new Promise((resolve) => {
      server.listen(0, '127.0.0.1', resolve)
    })
  )
  t.after(() => {
    server.close()
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const apiBaseUrl = 'http://127.0.0.1:' + address.port

  const result = await runCliAsync(
    [
      '--team-suggestions',
      '--github-org', 'test-org',
      '--github-token-env', 'TEST_GH_TOKEN',
      '--github-api-base-url', apiBaseUrl,
      '--output', 'team-suggestions.html',
    ],
    {
      cwd: repoDir,
      env: {
        TEST_GH_TOKEN: 'test-token',
      },
    }
  )
  assert.equal(result.status, 0, result.stderr)

  const html = readFileSync(path.join(repoDir, 'team-suggestions.html'), 'utf8')
  const reportData = parseReportDataFromHtml(html)
  assert.equal(reportData.directoryTeamSuggestionsMeta.enabled, true)
  assert.equal(reportData.directoryTeamSuggestionsMeta.org, 'test-org')
  assert.equal(reportData.directoryTeamSuggestionsMeta.source, 'repo-teams')

  const suggestion = reportData.directoryTeamSuggestions.find(row => row.path === 'pkg/uncovered')
  assert.ok(suggestion, 'should include suggestion for the uncovered folder')
  assert.equal(suggestion.status, 'ok')
  assert.equal(suggestion.candidates[0].team, '@test-org/alpha-team')
  assert.equal(suggestion.totalEdits, 3)
  assert.equal(suggestion.mappedEdits, 3)
})

test('team suggestions return no-auth status when token is missing', (t) => {
  const repoDir = createRepo(t, {
    remoteUrl: 'git@github.com:test-org/test-repo.git',
    trackedFiles: {
      'pkg/uncovered/a.js': 'module.exports = "a1"\n',
    },
  })

  commitStaged(repoDir, 'initial snapshot', 500, 'Bootstrap', 'bootstrap@example.com')
  writeFileSync(path.join(repoDir, 'pkg/uncovered/a.js'), 'module.exports = "a2"\n', 'utf8')
  runGit(repoDir, ['add', 'pkg/uncovered/a.js'])
  commitStaged(repoDir, 'alice update', 10, 'Alice', '123+alice@users.noreply.github.com')

  const result = runCli(
    [
      '--team-suggestions',
      '--github-org', 'test-org',
      '--github-token-env', 'TEST_GH_TOKEN',
      '--output', 'no-auth-suggestions.html',
    ],
    { cwd: repoDir }
  )
  assert.equal(result.status, 0, result.stderr)
  const html = readFileSync(path.join(repoDir, 'no-auth-suggestions.html'), 'utf8')
  const reportData = parseReportDataFromHtml(html)

  const suggestion = reportData.directoryTeamSuggestions.find(row => row.path === 'pkg/uncovered')
  assert.ok(suggestion, 'should include suggestion diagnostics for uncovered folder')
  assert.equal(suggestion.status, 'no-auth')
  assert.equal(reportData.directoryTeamSuggestionsMeta.enabled, true)
  assert.match(
    reportData.directoryTeamSuggestionsMeta.warnings.join('\n'),
    /Missing token/
  )
})

test('team suggestions support ignored team list', async (t) => {
  const repoDir = createRepo(t, {
    remoteUrl: 'git@github.com:test-org/test-repo.git',
    trackedFiles: {
      'pkg/uncovered/a.js': 'module.exports = "a1"\n',
      'pkg/uncovered/b.js': 'module.exports = "b1"\n',
    },
  })

  commitStaged(repoDir, 'initial snapshot outside window', 500, 'Bootstrap', 'bootstrap@example.com')

  writeFileSync(path.join(repoDir, 'pkg/uncovered/a.js'), 'module.exports = "a2"\n', 'utf8')
  runGit(repoDir, ['add', 'pkg/uncovered/a.js'])
  commitStaged(repoDir, 'alice update 1', 30, 'Alice', '123+alice@users.noreply.github.com')

  writeFileSync(path.join(repoDir, 'pkg/uncovered/a.js'), 'module.exports = "a3"\n', 'utf8')
  runGit(repoDir, ['add', 'pkg/uncovered/a.js'])
  commitStaged(repoDir, 'alice update 2', 20, 'Alice', '123+alice@users.noreply.github.com')

  writeFileSync(path.join(repoDir, 'pkg/uncovered/b.js'), 'module.exports = "b2"\n', 'utf8')
  runGit(repoDir, ['add', 'pkg/uncovered/b.js'])
  commitStaged(repoDir, 'bob update', 10, 'Bob', '456+bob@users.noreply.github.com')

  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    res.setHeader('content-type', 'application/json')
    if (url.pathname === '/repos/test-org/test-repo/teams') {
      res.end(JSON.stringify([
        { slug: 'alpha-team', name: 'Alpha Team' },
        { slug: 'beta-team', name: 'Beta Team' },
      ]))
      return
    }
    if (url.pathname === '/orgs/test-org/teams/alpha-team/members') {
      res.end(JSON.stringify([{ login: 'alice' }]))
      return
    }
    if (url.pathname === '/orgs/test-org/teams/beta-team/members') {
      res.end(JSON.stringify([{ login: 'bob' }]))
      return
    }
    res.statusCode = 404
    res.end(JSON.stringify({ message: 'not found' }))
  })
  await /** @type {Promise<void>} */ (
    new Promise((resolve) => {
      server.listen(0, '127.0.0.1', resolve)
    })
  )
  t.after(() => {
    server.close()
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const apiBaseUrl = 'http://127.0.0.1:' + address.port

  const result = await runCliAsync(
    [
      '--team-suggestions',
      '--github-org', 'test-org',
      '--github-token-env', 'TEST_GH_TOKEN',
      '--github-api-base-url', apiBaseUrl,
      '--team-suggestions-ignore-teams', 'alpha-team',
      '--output', 'ignore-team-suggestions.html',
    ],
    {
      cwd: repoDir,
      env: {
        TEST_GH_TOKEN: 'test-token',
      },
    }
  )
  assert.equal(result.status, 0, result.stderr)

  const html = readFileSync(path.join(repoDir, 'ignore-team-suggestions.html'), 'utf8')
  const reportData = parseReportDataFromHtml(html)
  const suggestion = reportData.directoryTeamSuggestions.find(row => row.path === 'pkg/uncovered')
  assert.ok(suggestion)
  assert.equal(suggestion.status, 'ok')
  assert.equal(suggestion.candidates[0].team, '@test-org/beta-team')
  assert.deepEqual(reportData.directoryTeamSuggestionsMeta.ignoredTeams, ['alpha-team'])
})

test('output path options write to the requested location', (t) => {
  const repoDir = createRepo(t)

  {
    const customRelativePath = 'reports/custom-output.html'
    const result = runCli(['--output', customRelativePath], { cwd: repoDir })
    assert.equal(result.status, 0, result.stderr)
    assert.ok(existsSync(path.join(repoDir, customRelativePath)))
    assert.equal(existsSync(path.join(repoDir, defaultOutputFile)), false)
  }

  {
    const equalsPath = 'reports/equals-output.html'
    const result = runCli(['--output=' + equalsPath], { cwd: repoDir })
    assert.equal(result.status, 0, result.stderr)
    assert.ok(existsSync(path.join(repoDir, equalsPath)))
  }
})

test('output directory option writes to the requested directory', (t) => {
  const repoDir = createRepo(t)

  {
    const relativeDir = 'reports'
    const result = runCli(['--output-dir', relativeDir], { cwd: repoDir })
    assert.equal(result.status, 0, result.stderr)
    assert.ok(existsSync(path.join(repoDir, relativeDir, defaultOutputFile)))
  }

  {
    const absoluteDir = mkdtempSync(path.join(tmpdir(), 'codeowners-audit-outdir-'))
    t.after(() => {
      rmSync(absoluteDir, { recursive: true, force: true })
    })

    const result = runCli(['--output-dir=' + absoluteDir], { cwd: repoDir })
    assert.equal(result.status, 0, result.stderr)
    assert.ok(existsSync(path.join(absoluteDir, defaultOutputFile)))
  }
})

test('working directory option allows running outside repository cwd', (t) => {
  const repoDir = createRepo(t)
  const outsideDir = mkdtempSync(path.join(tmpdir(), 'codeowners-audit-external-cwd-'))
  t.after(() => {
    rmSync(outsideDir, { recursive: true, force: true })
  })

  {
    const result = runCli(['--working-dir', repoDir, '--output', 'reports/from-working-dir.html'], { cwd: outsideDir })
    assert.equal(result.status, 0, result.stderr)
    assert.ok(existsSync(path.join(repoDir, 'reports', 'from-working-dir.html')))
  }

  {
    const result = runCli(['-C=' + repoDir, '--output', 'reports/from-short-alias.html'], { cwd: outsideDir })
    assert.equal(result.status, 0, result.stderr)
    assert.ok(existsSync(path.join(repoDir, 'reports', 'from-short-alias.html')))
  }
})

test('--include-untracked adds untracked files to analysis', (t) => {
  const repoDir = createRepo(t, {
    codeowners: '/tracked.js @team\n',
    trackedFiles: {
      'tracked.js': 'tracked\n',
    },
    untrackedFiles: {
      'new-untracked-file.txt': 'hello\n',
    },
  })

  const withoutFlagResult = runCli(['--output', 'without-untracked.html'], { cwd: repoDir })
  assert.equal(withoutFlagResult.status, 0, withoutFlagResult.stderr)
  const withoutFlagHtml = readFileSync(path.join(repoDir, 'without-untracked.html'), 'utf8')
  const withoutFlagData = parseReportDataFromHtml(withoutFlagHtml)
  unlinkSync(path.join(repoDir, 'without-untracked.html'))

  const withFlagResult = runCli(
    ['--include-untracked', '--output', 'with-untracked.html'],
    { cwd: repoDir }
  )
  assert.equal(withFlagResult.status, 0, withFlagResult.stderr)
  const withFlagHtml = readFileSync(path.join(repoDir, 'with-untracked.html'), 'utf8')
  const withFlagData = parseReportDataFromHtml(withFlagHtml)

  assert.equal(withFlagData.options.includeUntracked, true)
  assert.equal(withFlagData.totals.files, withoutFlagData.totals.files + 1)
  assert.ok(withFlagData.unownedFiles.includes('new-untracked-file.txt'))
})

test('--check exits non-zero when unowned files exist and skips report generation', (t) => {
  const repoDir = createRepo(t, {
    trackedFiles: {
      'src/also-unowned.js': 'module.exports = 3\n',
    },
  })

  const result = runCli(['--check'], { cwd: repoDir })

  assert.equal(result.status, 1)
  assert.doesNotMatch(result.stdout, /Wrote CODEOWNERS gap report/)
  assert.match(result.stderr, /CODEOWNERS check failed/)
  assert.match(result.stderr, /src\/also-unowned\.js/)
  assert.match(result.stderr, /src\/unowned\.js/)
})

test('--check glob filters files before ownership validation', (t) => {
  const repoDir = createRepo(t)

  const passingResult = runCli(['--check', 'src/owned.js'], { cwd: repoDir })
  assert.equal(passingResult.status, 0, passingResult.stderr)
  assert.match(passingResult.stdout, /CODEOWNERS check passed/)
  assert.doesNotMatch(passingResult.stdout, /Wrote CODEOWNERS gap report/)

  const failingResult = runCli(['--check=src/*.js'], { cwd: repoDir })
  assert.equal(failingResult.status, 1)
  assert.match(failingResult.stderr, /src\/unowned\.js/)
})

test('directory CODEOWNERS pattern without trailing slash owns descendants', (t) => {
  const repoDir = createRepo(t, {
    codeowners: '/integration-tests/profiler @team\n',
    trackedFiles: {
      'integration-tests/profiler/profiler.spec.js': 'module.exports = true\n',
    },
  })

  const result = runCli(['--check', 'integration-tests/profiler/profiler.spec.js'], { cwd: repoDir })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /CODEOWNERS check passed/)
})

test('wildcard root pattern does not own nested descendants', (t) => {
  const repoDir = createRepo(t, {
    codeowners: '/* @team\n',
    trackedFiles: {
      'nested/deep/file.js': 'module.exports = true\n',
    },
  })

  const result = runCli(['--check', 'nested/deep/file.js'], { cwd: repoDir })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /nested\/deep\/file\.js/)
})

test('wildcard in middle still allows directory descendant ownership', (t) => {
  const repoDir = createRepo(t, {
    codeowners: '/packages/*/test-crashtracking @team\n',
    trackedFiles: {
      'packages/dd-trace/test-crashtracking/crashtracker.spec.js': 'module.exports = true\n',
    },
  })

  const result = runCli(['--check', 'packages/dd-trace/test-crashtracking/crashtracker.spec.js'], { cwd: repoDir })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /CODEOWNERS check passed/)
})

test('top-level .github/CODEOWNERS applies rules repository-wide', (t) => {
  const repoDir = createRepo(t, {
    codeowners: '/does-not-match-anything @fallback\n',
    trackedFiles: {
      '.github/CODEOWNERS': '/src/owned.js @team\n',
    },
  })

  const result = runCli(['--output', 'github-codeowners-scope.html'], { cwd: repoDir })
  assert.equal(result.status, 0, result.stderr)

  const html = readFileSync(path.join(repoDir, 'github-codeowners-scope.html'), 'utf8')
  const reportData = parseReportDataFromHtml(html)

  assert.equal(reportData.totals.owned, 1)
  assert.equal(reportData.totals.unowned, reportData.totals.files - 1)
  assert.ok(!reportData.unownedFiles.includes('src/owned.js'))
  assert.ok(reportData.unownedFiles.includes('src/unowned.js'))

  const githubCodeowners = reportData.codeownersFiles.find(row => row.path === '.github/CODEOWNERS')
  assert.ok(githubCodeowners, 'report should include .github/CODEOWNERS metadata')
  assert.equal(githubCodeowners.dir, '.')
})

test('handles large repositories without git stdout buffer overflow', (t) => {
  const repoDir = createRepo(t)
  const longSegment = 'x'.repeat(160)
  const largeFileCount = 6500

  for (let index = 0; index < largeFileCount; index++) {
    const filePath = path.join(repoDir, 'bulk', `file-${String(index).padStart(5, '0')}-${longSegment}.txt`)
    mkdirSync(path.dirname(filePath), { recursive: true })
    writeFileSync(filePath, 'x\n', 'utf8')
  }

  runGit(repoDir, ['add', 'bulk'])

  const result = runCli(['--output', 'large-repo-report.html'], { cwd: repoDir })
  assert.equal(result.status, 0, result.stderr)
  assert.ok(existsSync(path.join(repoDir, 'large-repo-report.html')))
})

test('--help prints usage without failing', (t) => {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'codeowners-audit-help-'))
  t.after(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  const result = runCli(['--help'], { cwd: tempDir })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Usage: codeowners-audit \[options\]/)
  assert.match(result.stdout, /--include-untracked/)
  assert.match(result.stdout, /--output-dir/)
  assert.match(result.stdout, /--working-dir/)
  assert.match(result.stdout, /--no-open/)
  assert.match(result.stdout, /--check/)
  assert.match(result.stdout, /--team-suggestions/)
  assert.match(result.stdout, /--team-suggestions-ignore-teams/)
  assert.match(result.stdout, /--github-token-env/)
  assert.match(result.stdout, /--version/)
})

test('--version prints package version without failing', (t) => {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'codeowners-audit-version-'))
  t.after(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  const result = runCli(['--version'], { cwd: tempDir })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), packageVersion)

  const shortResult = runCli(['-v'], { cwd: tempDir })
  assert.equal(shortResult.status, 0, shortResult.stderr)
  assert.equal(shortResult.stdout.trim(), packageVersion)
})

test('opens local report in browser by default', (t) => {
  const openerCommand = getOpenCommandName()
  if (!openerCommand) {
    t.skip('automatic browser opening test is not supported on win32')
    return
  }

  const repoDir = createRepo(t)
  const fakeBinDir = path.join(repoDir, 'fake-bin')
  const fakeOpenPath = path.join(fakeBinDir, openerCommand)
  const openLogPath = path.join(repoDir, 'fake-open-target.txt')
  mkdirSync(fakeBinDir, { recursive: true })
  writeFileSync(
    fakeOpenPath,
    [
      '#!/usr/bin/env node',
      'const fs = require("node:fs")',
      `fs.writeFileSync(${JSON.stringify(openLogPath)}, process.argv.slice(2).join("\\n"), "utf8")`,
      '',
    ].join('\n'),
    'utf8'
  )
  chmodSync(fakeOpenPath, 0o755)

  const result = runCli([], {
    cwd: repoDir,
    noOpen: false,
    env: {
      PATH: fakeBinDir + path.delimiter + process.env.PATH,
    },
  })

  assert.equal(result.status, 0, result.stderr)
  assert.ok(existsSync(openLogPath), 'fake browser opener should be called')
  assert.match(readFileSync(openLogPath, 'utf8').trim(), /codeowners-gaps-report\.html$/)
  assert.match(result.stdout, /Opened report in browser/)
})

test('--upload uses curl response URL in output', (t) => {
  const repoDir = createRepo(t)
  const fakeBinDir = path.join(repoDir, 'fake-bin')
  const fakeCurlPath = path.join(fakeBinDir, 'curl')
  const uploadLogPath = path.join(repoDir, 'fake-upload-payload.txt')
  mkdirSync(fakeBinDir, { recursive: true })
  writeFileSync(
    fakeCurlPath,
    [
      '#!/usr/bin/env node',
      'const fs = require("node:fs")',
      'const payload = fs.readFileSync(0, "utf8")',
      `fs.writeFileSync(${JSON.stringify(uploadLogPath)}, payload, "utf8")`,
      'process.stdout.write(JSON.stringify({ url: "https://zenbin.org/p/test-page" }))',
      '',
    ].join('\n'),
    'utf8'
  )
  chmodSync(fakeCurlPath, 0o755)

  const result = runCli(['--upload'], {
    cwd: repoDir,
    env: {
      PATH: fakeBinDir + path.delimiter + process.env.PATH,
    },
  })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Uploaded report \(zenbin\): https:\/\/zenbin\.org\/p\/test-page/)
  assert.ok(existsSync(uploadLogPath), 'fake curl should receive payload via stdin')
  assert.match(readFileSync(uploadLogPath, 'utf8'), /"html":/)
})

test('--upload opens uploaded URL in browser by default', (t) => {
  const openerCommand = getOpenCommandName()
  if (!openerCommand) {
    t.skip('automatic browser opening test is not supported on win32')
    return
  }

  const repoDir = createRepo(t)
  const fakeBinDir = path.join(repoDir, 'fake-bin')
  const fakeCurlPath = path.join(fakeBinDir, 'curl')
  const fakeOpenPath = path.join(fakeBinDir, openerCommand)
  const uploadLogPath = path.join(repoDir, 'fake-upload-payload.txt')
  const openLogPath = path.join(repoDir, 'fake-open-target.txt')
  mkdirSync(fakeBinDir, { recursive: true })
  writeFileSync(
    fakeCurlPath,
    [
      '#!/usr/bin/env node',
      'const fs = require("node:fs")',
      'const payload = fs.readFileSync(0, "utf8")',
      `fs.writeFileSync(${JSON.stringify(uploadLogPath)}, payload, "utf8")`,
      'process.stdout.write(JSON.stringify({ url: "https://zenbin.org/p/test-upload-open" }))',
      '',
    ].join('\n'),
    'utf8'
  )
  writeFileSync(
    fakeOpenPath,
    [
      '#!/usr/bin/env node',
      'const fs = require("node:fs")',
      `fs.writeFileSync(${JSON.stringify(openLogPath)}, process.argv.slice(2).join("\\n"), "utf8")`,
      '',
    ].join('\n'),
    'utf8'
  )
  chmodSync(fakeCurlPath, 0o755)
  chmodSync(fakeOpenPath, 0o755)

  const result = runCli(['--upload'], {
    cwd: repoDir,
    noOpen: false,
    env: {
      PATH: fakeBinDir + path.delimiter + process.env.PATH,
    },
  })

  assert.equal(result.status, 0, result.stderr)
  assert.ok(existsSync(uploadLogPath), 'fake curl should receive payload via stdin')
  assert.equal(readFileSync(openLogPath, 'utf8').trim(), 'https://zenbin.org/p/test-upload-open')
  assert.match(result.stdout, /Opened report in browser: https:\/\/zenbin\.org\/p\/test-upload-open/)
})

test('--upload fails with a clear message when the report is too large', (t) => {
  const repoDir = createRepo(t)
  const fakeBinDir = path.join(repoDir, 'fake-bin')
  const fakeCurlPath = path.join(fakeBinDir, 'curl')
  const uploadLogPath = path.join(repoDir, 'fake-upload-payload.txt')
  mkdirSync(fakeBinDir, { recursive: true })
  writeFileSync(
    fakeCurlPath,
    [
      '#!/usr/bin/env node',
      'const fs = require("node:fs")',
      'const payload = fs.readFileSync(0, "utf8")',
      `fs.writeFileSync(${JSON.stringify(uploadLogPath)}, payload, "utf8")`,
      'process.stdout.write(JSON.stringify({ url: "https://zenbin.org/p/should-not-run" }))',
      '',
    ].join('\n'),
    'utf8'
  )
  chmodSync(fakeCurlPath, 0o755)

  const longSegment = 'x'.repeat(160)
  const largeFileCount = 6500
  for (let index = 0; index < largeFileCount; index++) {
    const filePath = path.join(repoDir, 'bulk', `file-${String(index).padStart(5, '0')}-${longSegment}.txt`)
    mkdirSync(path.dirname(filePath), { recursive: true })
    writeFileSync(filePath, 'x\n', 'utf8')
  }
  runGit(repoDir, ['add', 'bulk'])

  const result = runCli(['--upload'], {
    cwd: repoDir,
    env: {
      PATH: fakeBinDir + path.delimiter + process.env.PATH,
    },
  })

  assert.equal(result.status, 2)
  assert.match(result.stderr, /report is too large for ZenBin/)
  assert.equal(existsSync(uploadLogPath), false, 'curl should not be called for oversized payloads')
})

test('unknown and invalid options fail with a useful error', (t) => {
  const repoDir = createRepo(t)

  const unknownResult = runCli(['--nope'], { cwd: repoDir })
  assert.equal(unknownResult.status, 2)
  assert.match(unknownResult.stderr, /Unknown argument: --nope/)

  const missingOutputResult = runCli(['--output'], { cwd: repoDir })
  assert.equal(missingOutputResult.status, 2)
  assert.match(missingOutputResult.stderr, /Missing value for --output/)

  const missingOutputDirResult = runCli(['--output-dir'], { cwd: repoDir })
  assert.equal(missingOutputDirResult.status, 2)
  assert.match(missingOutputDirResult.stderr, /Missing value for --output-dir/)

  const missingWorkingDirResult = runCli(['--working-dir'], { cwd: repoDir })
  assert.equal(missingWorkingDirResult.status, 2)
  assert.match(missingWorkingDirResult.stderr, /Missing value for --working-dir/)

  const missingCheckGlobResult = runCli(['--check='], { cwd: repoDir })
  assert.equal(missingCheckGlobResult.status, 2)
  assert.match(missingCheckGlobResult.stderr, /Missing value for --check/)

  const missingSuggestionsWindowResult = runCli(['--team-suggestions-window-days'], { cwd: repoDir })
  assert.equal(missingSuggestionsWindowResult.status, 2)
  assert.match(missingSuggestionsWindowResult.stderr, /Missing value for --team-suggestions-window-days/)

  const invalidSuggestionsTopResult = runCli(['--team-suggestions-top=0'], { cwd: repoDir })
  assert.equal(invalidSuggestionsTopResult.status, 2)
  assert.match(invalidSuggestionsTopResult.stderr, /--team-suggestions-top must be >= 1/)

  const missingIgnoreTeamsResult = runCli(['--team-suggestions-ignore-teams'], { cwd: repoDir })
  assert.equal(missingIgnoreTeamsResult.status, 2)
  assert.match(missingIgnoreTeamsResult.stderr, /Missing value for --team-suggestions-ignore-teams/)
})
