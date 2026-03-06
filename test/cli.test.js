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
const DEFAULT_EXEC_FILE_MAX_BUFFER_BYTES = 1024 * 1024
const GIT_BUFFER_STRESS_TARGET_BYTES = DEFAULT_EXEC_FILE_MAX_BUFFER_BYTES + (96 * 1024)
const ZENBIN_UPLOAD_STRESS_TARGET_BYTES = 1280 * 1024

function parseOutputPathFromStdout (stdout) {
  const match = stdout.match(/Report ready at (.+)/)
  assert.ok(match, 'stdout should include the report output path')
  return match[1].trim()
}

function buildCliEnv (options = {}) {
  return {
    ...process.env,
    CODEOWNERS_AUDIT_ASSUME_TTY: options.assumeTty === false ? '0' : '1',
    ...(options.env || {}),
  }
}

function runCli (args, options = {}) {
  const cliArgs = options.noOpen === false ? args : ['--no-open', ...args]
  return spawnSync(process.execPath, [cliPath, ...cliArgs], {
    cwd: options.cwd,
    env: buildCliEnv(options),
    encoding: 'utf8',
    input: options.stdinData,
  })
}

function runCliAsync (args, options = {}) {
  const cliArgs = options.noOpen === false ? args : ['--no-open', ...args]
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...cliArgs], {
      cwd: options.cwd,
      env: buildCliEnv(options),
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    child.stdin.end(options.stdinData === undefined ? '' : options.stdinData)
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
    maxBuffer: 64 * 1024 * 1024,
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

function addTrackedBulkFilesForStress (repoDir, minimumGitListBytes) {
  const segmentA = 'a'.repeat(40)
  const segmentB = 'b'.repeat(40)
  const fileSuffix = 'c'.repeat(80)
  const bulkRelativeDir = path.posix.join('bulk', segmentA, segmentB)
  const bulkAbsoluteDir = path.join(repoDir, bulkRelativeDir)
  mkdirSync(bulkAbsoluteDir, { recursive: true })

  let fileCount = 0
  let estimatedGitListBytes = 0
  while (estimatedGitListBytes < minimumGitListBytes) {
    const fileName = `file-${String(fileCount).padStart(5, '0')}-${fileSuffix}.txt`
    writeFileSync(path.join(bulkAbsoluteDir, fileName), 'x\n', 'utf8')
    const relativePath = bulkRelativeDir + '/' + fileName
    estimatedGitListBytes += Buffer.byteLength(relativePath, 'utf8') + 1
    fileCount++
  }

  runGit(repoDir, ['add', 'bulk'])
  return { fileCount, estimatedGitListBytes }
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

function writeFakeNodeScript (scriptPath, scriptLines) {
  if (process.platform === 'win32') {
    const cmdPath = scriptPath.endsWith('.cmd') ? scriptPath : scriptPath + '.cmd'
    const jsPath = scriptPath + '.js'
    writeFileSync(jsPath, scriptLines.join('\n'), 'utf8')
    writeFileSync(cmdPath, `@node "%~dp0${path.basename(jsPath)}" %*\r\n`, 'utf8')
  } else {
    writeFileSync(
      scriptPath,
      ['#!/usr/bin/env node', ...scriptLines, ''].join('\n'),
      'utf8'
    )
    chmodSync(scriptPath, 0o755)
  }
}

test('running the bin creates a report in temp dir with expected shape', (t) => {
  const repoDir = createRepo(t)

  const result = runCli([], { cwd: repoDir })

  assert.equal(result.status, 0, result.stderr)
  const outputPath = parseOutputPathFromStdout(result.stdout)
  assert.ok(outputPath.startsWith(tmpdir()), 'default report should be written in a temp directory')
  assert.ok(existsSync(outputPath), 'default report should be written to disk')
  assert.equal(existsSync(path.join(repoDir, defaultOutputFile)), false, 'default report should not be written in repository root')
  assert.match(result.stdout, /Report ready at/)

  const html = readFileSync(outputPath, 'utf8')
  assert.match(html, /<title>CODEOWNERS Gap Report<\/title>/)
  assert.match(html, /alt="codeowners-audit logo"/, 'report header should include a logo image')
  assert.ok(
    html.includes(`https://raw.githubusercontent.com/watson/codeowners-audit/v${packageVersion}/assets/logo2-small.png`),
    'report logo should be loaded from the versioned raw GitHub asset path'
  )
  assert.match(html, /min-width:\s*0;/, 'panels should remain width-constrained on narrow screens')
  assert.match(html, /overflow-x:\s*auto;/, 'file list areas should use horizontal scrolling for long paths')

  const reportData = parseReportDataFromHtml(html)
  assert.equal(reportData.options.includeUntracked, false)
  assert.equal(Object.hasOwn(reportData, 'topLevel'), false)
  assert.ok(reportData.totals.files >= 3)
  assert.ok(reportData.unownedFiles.includes('src/unowned.js'))
  assert.equal(Array.isArray(reportData.teamOwnership), true)
  assert.equal(Array.isArray(reportData.directoryTeamSuggestions), true)
  assert.equal(reportData.directoryTeamSuggestions.length, 0)
  assert.equal(reportData.directoryTeamSuggestionsMeta.enabled, false)
  assert.deepEqual(reportData.directoryTeamSuggestionsMeta.ignoredTeams, [])
})

test('report includes team ownership index for @org/team owners', (t) => {
  const repoDir = createRepo(t, {
    codeowners: [
      '/src/owned.js @acme/platform @alice',
      '/src/dual.js @acme/platform @acme/security',
    ].join('\n') + '\n',
    trackedFiles: {
      'src/dual.js': 'module.exports = 3\n',
    },
  })

  const result = runCli([], { cwd: repoDir })
  assert.equal(result.status, 0, result.stderr)

  const outputPath = parseOutputPathFromStdout(result.stdout)
  const html = readFileSync(outputPath, 'utf8')
  const reportData = parseReportDataFromHtml(html)

  const platform = reportData.teamOwnership.find(row => row.team === '@acme/platform')
  assert.ok(platform, 'platform team should exist')
  assert.equal(platform.total, 2)
  assert.deepEqual(platform.files, ['src/dual.js', 'src/owned.js'])

  const security = reportData.teamOwnership.find(row => row.team === '@acme/security')
  assert.ok(security, 'security team should exist')
  assert.equal(security.total, 1)
  assert.deepEqual(security.files, ['src/dual.js'])

  assert.equal(reportData.teamOwnership.some(row => row.team === '@alice'), false)
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
  const apiBaseUrl = `http://127.0.0.1:${address.port}`

  const result = await runCliAsync(
    [
      '--suggest-teams',
      '--github-org', 'test-org',
      '--github-token', 'test-token',
      '--github-api-base-url', apiBaseUrl,
      '--output', 'team-suggestions.html',
    ],
    {
      cwd: repoDir,
    }
  )
  assert.equal(result.status, 0, result.stderr)

  const html = readFileSync(path.join(repoDir, 'team-suggestions.html'), 'utf8')
  const reportData = parseReportDataFromHtml(html)
  assert.equal(reportData.directoryTeamSuggestionsMeta.enabled, true)
  assert.equal(reportData.directoryTeamSuggestionsMeta.org, 'test-org')
  assert.equal(reportData.directoryTeamSuggestionsMeta.source, 'repo-teams')
  assert.equal(reportData.directoryTeamSuggestionsMeta.tokenSource, 'cli')
  assert.equal(JSON.stringify(reportData).includes('test-token'), false)

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
      '--suggest-teams',
      '--github-org', 'test-org',
      '--output', 'no-auth-suggestions.html',
    ],
    {
      cwd: repoDir,
      env: {
        GITHUB_TOKEN: '',
        GH_TOKEN: '',
      },
    }
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
    /Missing GitHub token/
  )
})

test('team suggestions fall back to GITHUB_TOKEN env when --github-token is omitted', async (t) => {
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
  const apiBaseUrl = `http://127.0.0.1:${address.port}`

  const result = await runCliAsync(
    [
      '--suggest-teams',
      '--github-org', 'test-org',
      '--github-api-base-url', apiBaseUrl,
      '--output', 'team-suggestions-env-fallback.html',
    ],
    {
      cwd: repoDir,
      env: {
        GITHUB_TOKEN: 'test-token',
        GH_TOKEN: '',
      },
    }
  )
  assert.equal(result.status, 0, result.stderr)

  const html = readFileSync(path.join(repoDir, 'team-suggestions-env-fallback.html'), 'utf8')
  const reportData = parseReportDataFromHtml(html)
  const suggestion = reportData.directoryTeamSuggestions.find(row => row.path === 'pkg/uncovered')
  assert.ok(suggestion, 'should include suggestion for the uncovered folder')
  assert.equal(suggestion.status, 'ok')
  assert.equal(reportData.directoryTeamSuggestionsMeta.tokenSource, 'GITHUB_TOKEN')
  assert.equal(JSON.stringify(reportData).includes('test-token'), false)
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
  const apiBaseUrl = `http://127.0.0.1:${address.port}`

  const result = await runCliAsync(
    [
      '--suggest-teams',
      '--github-org', 'test-org',
      '--github-token', 'test-token',
      '--github-api-base-url', apiBaseUrl,
      '--suggest-ignore-teams', 'alpha-team',
      '--output', 'ignore-team-suggestions.html',
    ],
    {
      cwd: repoDir,
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
    const result = runCli([`--output=${equalsPath}`], { cwd: repoDir })
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

    const result = runCli([`--output-dir=${absoluteDir}`], { cwd: repoDir })
    assert.equal(result.status, 0, result.stderr)
    assert.ok(existsSync(path.join(absoluteDir, defaultOutputFile)))
  }
})

test('--cwd allows running outside repository cwd', (t) => {
  const repoDir = createRepo(t)
  const outsideDir = mkdtempSync(path.join(tmpdir(), 'codeowners-audit-external-cwd-'))
  t.after(() => {
    rmSync(outsideDir, { recursive: true, force: true })
  })

  {
    const result = runCli(['--cwd', repoDir, '--output', 'reports/from-working-dir.html'], { cwd: outsideDir })
    assert.equal(result.status, 0, result.stderr)
    assert.ok(existsSync(path.join(repoDir, 'reports', 'from-working-dir.html')))
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

test('progress output is suppressed by default', (t) => {
  const repoDir = createRepo(t)
  const result = runCli(['--suggest-teams', '--output', 'default-no-progress.html'], { cwd: repoDir })

  assert.equal(result.status, 0, result.stderr)
  assert.doesNotMatch(result.stdout, /\[progress \+/)
  assert.doesNotMatch(result.stderr, /\[progress \+/)
})

test('--verbose enables verbose progress output', (t) => {
  const repoDir = createRepo(t)
  const result = runCli(['--verbose', '--suggest-teams', '--output', 'verbose-progress.html'], { cwd: repoDir })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /\[progress \+/)
})

test('--fail-on-unowned exits non-zero when unowned files exist and still writes report', (t) => {
  const repoDir = createRepo(t, {
    trackedFiles: {
      'src/also-unowned.js': 'module.exports = 3\n',
    },
  })

  const result = runCli(['--fail-on-unowned'], { cwd: repoDir })

  assert.equal(result.status, 1)
  assert.match(result.stdout, /Report ready at/)
  const outputPath = parseOutputPathFromStdout(result.stdout)
  assert.ok(existsSync(outputPath), 'fail-on-unowned mode should still write report output')
  assert.match(result.stderr, /src\/also-unowned\.js/)
  assert.match(result.stderr, /src\/unowned\.js/)
})

test('report includes missing CODEOWNERS path warnings in validation metadata', (t) => {
  const repoDir = createRepo(t, {
    codeowners: [
      '/src/owned.js @team',
      '/src/unowned.js @team',
      '/CODEOWNERS @team',
      '/does-not-exist.js @acme/platform @alice',
      '/missing-dir/ @acme/security @bob',
    ].join('\n') + '\n',
  })

  const result = runCli(['--output', 'missing-path-warnings.html'], { cwd: repoDir })

  assert.equal(result.status, 0, result.stderr)
  const html = readFileSync(path.join(repoDir, 'missing-path-warnings.html'), 'utf8')
  assert.match(html, /id="missing-path-warnings-heading">Patterns With No Matching Repository Paths<\/h3>/)
  assert.ok(
    html.indexOf('Patterns With No Matching Repository Paths') < html.indexOf('CODEOWNERS Location Warnings'),
    'missing path warnings should appear before location warnings in the report'
  )
  assert.doesNotMatch(html, /missing-path-warnings-summary/)
  assert.match(html, /patternSpan\.className = 'warning-path'/)
  assert.match(html, /ownersSpan\.className = 'warning-owners'/)
  assert.match(html, /ownerLabelSpan\.textContent = ' owners: '/)
  assert.doesNotMatch(html, /textSpan\.textContent = ' \(from '/)
  const reportData = parseReportDataFromHtml(html)
  assert.equal(reportData.codeownersValidationMeta.discoveryWarningCount, 0)
  assert.equal(reportData.codeownersValidationMeta.missingPathWarningCount, 2)
  assert.deepEqual(
    reportData.codeownersValidationMeta.missingPathWarnings.map((warning) => warning.pattern),
    ['/does-not-exist.js', '/missing-dir/']
  )
  assert.equal(reportData.codeownersValidationMeta.missingPathWarnings[0].codeownersPath, 'CODEOWNERS')
  assert.deepEqual(reportData.codeownersValidationMeta.missingPathWarnings[0].owners, ['@acme/platform', '@alice'])
  assert.deepEqual(reportData.codeownersValidationMeta.missingPathWarnings[1].owners, ['@acme/security', '@bob'])
  assert.equal(
    Object.hasOwn(reportData.codeownersValidationMeta.missingPathWarnings[0], 'scopedDir'),
    false
  )
  assert.doesNotMatch(result.stderr, /CODEOWNERS pattern\(s\) do not match any repository files/)
})

test('--no-report prints missing CODEOWNERS path warnings to stderr', (t) => {
  const repoDir = createRepo(t, {
    codeowners: [
      '/src/owned.js @team',
      '/src/unowned.js @team',
      '/CODEOWNERS @team',
      '/does-not-exist.js @acme/platform @alice',
    ].join('\n') + '\n',
  })

  const result = runCli(['--no-report'], { cwd: repoDir })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stderr, /Missing CODEOWNERS paths \(1\):/)
  assert.match(result.stderr, /- \/does-not-exist\.js owners: @acme\/platform, @alice/)
  assert.match(
    result.stdout,
    /Coverage summary:\nglobs: "\*\*"\ncodeowners file: CODEOWNERS\nanalyzed files: 3\nunknown files: 0\nmissing path warnings: 1\nlocation warnings: 0/
  )
})

test('report includes CODEOWNERS discovery warnings for unused and unsupported files', (t) => {
  const repoDir = createRepo(t, {
    codeowners: '/src/unowned.js @root\n',
    trackedFiles: {
      '.github/CODEOWNERS': '/src/owned.js @team\n',
      'docs/CODEOWNERS': '/src/owned.js @docs\n',
      'packages/CODEOWNERS': '/src/owned.js @nested\n',
    },
  })

  const result = runCli(['--output', 'codeowners-discovery-warnings.html'], { cwd: repoDir })

  assert.equal(result.status, 0, result.stderr)
  const html = readFileSync(path.join(repoDir, 'codeowners-discovery-warnings.html'), 'utf8')
  assert.match(html, /id="codeowners-discovery-warnings-heading">CODEOWNERS Location Warnings<\/h3>/)
  assert.doesNotMatch(html, /codeowners-discovery-warnings-summary/)
  const reportData = parseReportDataFromHtml(html)
  assert.equal(reportData.codeownersValidationMeta.discoveryWarningCount, 3)
  assert.deepEqual(
    reportData.codeownersValidationMeta.discoveryWarnings.map((warning) => [warning.path, warning.type]),
    [
      ['CODEOWNERS', 'unused-supported-location'],
      ['docs/CODEOWNERS', 'unused-supported-location'],
      ['packages/CODEOWNERS', 'unsupported-location'],
    ]
  )
  assert.match(
    reportData.codeownersValidationMeta.discoveryWarnings[0].message,
    /^CODEOWNERS is unused because GitHub selects \.github\/CODEOWNERS first\.$/
  )
  assert.match(
    reportData.codeownersValidationMeta.discoveryWarnings[2].message,
    /^packages\/CODEOWNERS is in an unsupported location and is ignored by GitHub\.$/
  )
})

test('--no-report prints CODEOWNERS discovery warnings to stderr', (t) => {
  const repoDir = createRepo(t, {
    codeowners: [
      '/src/owned.js @team',
      '/src/unowned.js @team',
    ].join('\n') + '\n',
    trackedFiles: {
      'docs/CODEOWNERS': '/src/owned.js @docs\n',
      'packages/CODEOWNERS': '/src/owned.js @nested\n',
    },
  })

  const result = runCli(['--no-report'], { cwd: repoDir })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stderr, /CODEOWNERS location warnings \(2\):/)
  assert.match(result.stderr, /docs\/CODEOWNERS is unused because GitHub selects CODEOWNERS first\./)
  assert.match(
    result.stderr,
    /packages\/CODEOWNERS is in an unsupported location and is ignored by GitHub\./
  )
  assert.match(result.stdout, /codeowners file: CODEOWNERS/)
  assert.match(result.stdout, /location warnings: 2/)
  assert.match(result.stdout, /missing path warnings: 0/)
})

test('unsupported-only CODEOWNERS locations fail with a clear error', (t) => {
  const repoDir = createRepo(t)

  runGit(repoDir, ['rm', '-f', 'CODEOWNERS'])
  mkdirSync(path.join(repoDir, 'packages'), { recursive: true })
  writeFileSync(path.join(repoDir, 'packages/CODEOWNERS'), '/src/owned.js @nested\n', 'utf8')
  runGit(repoDir, ['add', 'packages/CODEOWNERS'])

  const result = runCli([], { cwd: repoDir })

  assert.equal(result.status, 2)
  assert.match(result.stderr, /No supported CODEOWNERS files found in this repository\./)
  assert.match(
    result.stderr,
    /GitHub only supports \.github\/CODEOWNERS, CODEOWNERS, docs\/CODEOWNERS\./
  )
  assert.match(result.stderr, /Unsupported CODEOWNERS files were found at: packages\/CODEOWNERS\./)
})

test('--fail-on-missing-paths exits non-zero when CODEOWNERS paths are missing', (t) => {
  const repoDir = createRepo(t, {
    codeowners: [
      '/src/owned.js @team',
      '/src/unowned.js @team',
      '/CODEOWNERS @team',
      '/does-not-exist.js @team',
    ].join('\n') + '\n',
  })

  const result = runCli(['--fail-on-missing-paths'], { cwd: repoDir })

  assert.equal(result.status, 1)
  assert.match(result.stdout, /Report ready at/)
})

test('--fail-on-missing-paths is repository-wide and not scoped by --glob', (t) => {
  const repoDir = createRepo(t, {
    codeowners: [
      '/src/owned.js @team',
      '/src/unowned.js @team',
      '/CODEOWNERS @team',
      '/does-not-exist.js @team',
    ].join('\n') + '\n',
  })

  const result = runCli(['--fail-on-missing-paths', '--glob', 'src/owned.js'], { cwd: repoDir })

  assert.equal(result.status, 1)
  assert.doesNotMatch(result.stdout, /Coverage summary:/)
})

test('--fail-on-missing-paths passes when all CODEOWNERS paths match repository files', (t) => {
  const repoDir = createRepo(t, {
    codeowners: [
      '/src/owned.js @team',
      '/src/unowned.js @team',
      '/CODEOWNERS @team',
    ].join('\n') + '\n',
  })

  const result = runCli(['--fail-on-missing-paths'], { cwd: repoDir })

  assert.equal(result.status, 0, result.stderr)
})

test('--fail-on-location-warnings exits non-zero when extra CODEOWNERS files are found', (t) => {
  const repoDir = createRepo(t, {
    codeowners: [
      '/src/owned.js @team',
      '/src/unowned.js @team',
    ].join('\n') + '\n',
    trackedFiles: {
      'docs/CODEOWNERS': '/src/owned.js @docs\n',
      'packages/CODEOWNERS': '/src/owned.js @nested\n',
    },
  })

  const result = runCli(['--fail-on-location-warnings'], { cwd: repoDir })

  assert.equal(result.status, 1)
  assert.match(result.stdout, /Report ready at/)
})

test('--fail-on-location-warnings is repository-wide and not scoped by --glob', (t) => {
  const repoDir = createRepo(t, {
    codeowners: [
      '/src/owned.js @team',
      '/src/unowned.js @team',
    ].join('\n') + '\n',
    trackedFiles: {
      'docs/CODEOWNERS': '/src/owned.js @docs\n',
    },
  })

  const result = runCli(['--fail-on-location-warnings', '--glob', 'src/owned.js'], { cwd: repoDir })

  assert.equal(result.status, 1)
  assert.doesNotMatch(result.stdout, /Coverage summary:/)
})

test('--fail-on-location-warnings passes when there are no CODEOWNERS location warnings', (t) => {
  const repoDir = createRepo(t)

  const result = runCli(['--fail-on-location-warnings'], { cwd: repoDir })

  assert.equal(result.status, 0, result.stderr)
})

test('--no-open does not prompt to open report even with interactive stdin', (t) => {
  const repoDir = createRepo(t)
  const result = runCli(['--no-open'], {
    cwd: repoDir,
    noOpen: false,
    stdinData: 'no\n',
  })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Report ready at/)
  assert.doesNotMatch(result.stdout, /Press Enter to open it in your browser/)
  assert.doesNotMatch(result.stdout, /Opened report in browser/)
})

test('--no-report skips HTML output and implies listing unowned files in interactive mode', (t) => {
  const repoDir = createRepo(t)
  const result = runCli(['--no-report'], { cwd: repoDir })

  assert.equal(result.status, 0, result.stderr)
  assert.doesNotMatch(result.stdout, /Report ready at/)
  assert.match(result.stdout, /src\/unowned\.js/)
  assert.doesNotMatch(result.stdout, /Press Enter to open it in your browser/)
  assert.doesNotMatch(result.stderr, /CODEOWNERS check failed/)
})

test('--list-unowned prints unowned files to stdout', (t) => {
  const repoDir = createRepo(t)
  const result = runCli(['--list-unowned'], { cwd: repoDir })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Unknown files \(\d+\):/)
  assert.match(result.stdout, /CODEOWNERS/)
  assert.match(result.stdout, /src\/unowned\.js/)
  assert.doesNotMatch(result.stdout, /Coverage summary:/)
  assert.doesNotMatch(result.stderr, /CODEOWNERS check failed/)
})

test('non-interactive stdin defaults to --no-open, --list-unowned, and --fail-on-unowned', (t) => {
  const repoDir = createRepo(t)
  const result = runCli([], {
    cwd: repoDir,
    assumeTty: false,
    noOpen: false,
    stdinData: '\n',
  })

  assert.equal(result.status, 1)
  assert.match(result.stdout, /Standard input is non-interactive; defaulting to --no-open --list-unowned --fail-on-unowned/)
  assert.match(result.stdout, /Report ready at/)
  assert.match(result.stdout, /CODEOWNERS/)
  assert.match(result.stdout, /src\/unowned\.js/)
  const outputPath = parseOutputPathFromStdout(result.stdout)
  assert.ok(existsSync(outputPath), 'non-interactive mode should still write report output')
  assert.doesNotMatch(result.stdout, /Press Enter to open it in your browser/)
  assert.doesNotMatch(result.stderr, /CODEOWNERS check failed/)
})

test('non-interactive mode supports --no-report while still listing and failing on unowned files', (t) => {
  const repoDir = createRepo(t)
  const result = runCli(['--no-report'], {
    cwd: repoDir,
    assumeTty: false,
  })

  assert.equal(result.status, 1)
  assert.match(result.stdout, /Standard input is non-interactive; defaulting to --no-open --list-unowned --fail-on-unowned/)
  assert.match(result.stdout, /CODEOWNERS/)
  assert.doesNotMatch(result.stdout, /Report ready at/)
  assert.match(result.stdout, /src\/unowned\.js/)
  assert.doesNotMatch(result.stderr, /CODEOWNERS check failed/)
})

test('non-interactive stdin allows output flags while preserving non-interactive defaults', (t) => {
  const repoDir = createRepo(t)
  const outputPath = path.join('reports', 'custom-non-tty-report.html')
  const outputDir = path.join('reports-dir')

  const outputResult = runCli(['--output', outputPath], {
    cwd: repoDir,
    assumeTty: false,
  })
  assert.equal(outputResult.status, 1)
  assert.match(outputResult.stdout, /Standard input is non-interactive; defaulting to --no-open --list-unowned --fail-on-unowned/)
  assert.match(outputResult.stdout, /Report ready at/)
  assert.match(outputResult.stdout, /src\/unowned\.js/)
  assert.ok(existsSync(path.join(repoDir, outputPath)))
  assert.doesNotMatch(outputResult.stderr, /CODEOWNERS check failed/)

  const outputDirResult = runCli(['--output-dir', outputDir], {
    cwd: repoDir,
    assumeTty: false,
  })
  assert.equal(outputDirResult.status, 1)
  assert.match(outputDirResult.stdout, /Report ready at/)
  assert.match(outputDirResult.stdout, /src\/unowned\.js/)
  assert.ok(existsSync(path.join(repoDir, outputDir, defaultOutputFile)))
  assert.doesNotMatch(outputDirResult.stderr, /CODEOWNERS check failed/)
})

test('--no-report cannot be combined with --upload', (t) => {
  const repoDir = createRepo(t)
  const result = runCli(['--no-report', '--upload'], { cwd: repoDir })

  assert.equal(result.status, 2)
  assert.match(result.stderr, /--no-report cannot be combined with --upload/)
})

test('--glob filters files before ownership validation when fail-on-unowned is enabled', (t) => {
  const repoDir = createRepo(t)

  const passingResult = runCli(['--fail-on-unowned', '-g', 'src/owned.js'], { cwd: repoDir })
  assert.equal(passingResult.status, 0, passingResult.stderr)
  assert.doesNotMatch(passingResult.stdout, /Coverage summary:/)
  assert.match(passingResult.stdout, /Report ready at/)

  const failingResult = runCli(['--fail-on-unowned', '--glob=src/*.js'], { cwd: repoDir })
  assert.equal(failingResult.status, 1)
  assert.match(failingResult.stderr, /src\/unowned\.js/)
})

test('--glob can be repeated and combines as a union', (t) => {
  const repoDir = createRepo(t)

  const result = runCli(
    ['--fail-on-unowned', '--glob', 'src/owned.js', '--glob', 'src/unowned.js'],
    { cwd: repoDir }
  )

  assert.equal(result.status, 1)
  assert.match(result.stderr, /src\/unowned\.js/)
})

test('--glob also scopes report generation without fail-on-unowned mode', (t) => {
  const repoDir = createRepo(t)

  const result = runCli(['--glob', 'src/owned.js', '--output', 'glob-scoped.html'], { cwd: repoDir })
  assert.equal(result.status, 0, result.stderr)

  const html = readFileSync(path.join(repoDir, 'glob-scoped.html'), 'utf8')
  const reportData = parseReportDataFromHtml(html)
  assert.equal(reportData.totals.files, 1)
  assert.equal(reportData.totals.unowned, 0)
  assert.deepEqual(reportData.unownedFiles, [])
})

test('directory CODEOWNERS pattern without trailing slash owns descendants', (t) => {
  const repoDir = createRepo(t, {
    codeowners: '/integration-tests/profiler @team\n',
    trackedFiles: {
      'integration-tests/profiler/profiler.spec.js': 'module.exports = true\n',
    },
  })

  const result = runCli(['--fail-on-unowned', '--glob', 'integration-tests/profiler/profiler.spec.js'], { cwd: repoDir })

  assert.equal(result.status, 0, result.stderr)
  assert.doesNotMatch(result.stdout, /Coverage summary:/)
})

test('wildcard root pattern does not own nested descendants', (t) => {
  const repoDir = createRepo(t, {
    codeowners: '/* @team\n',
    trackedFiles: {
      'nested/deep/file.js': 'module.exports = true\n',
    },
  })

  const result = runCli(['--fail-on-unowned', '--glob', 'nested/deep/file.js'], { cwd: repoDir })

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

  const result = runCli(['--fail-on-unowned', '--glob', 'packages/dd-trace/test-crashtracking/crashtracker.spec.js'], { cwd: repoDir })

  assert.equal(result.status, 0, result.stderr)
  assert.doesNotMatch(result.stdout, /Coverage summary:/)
})

test('.github/CODEOWNERS takes precedence over root and docs CODEOWNERS files', (t) => {
  const repoDir = createRepo(t, {
    codeowners: '/src/root-owned.js @root\n',
    trackedFiles: {
      '.github/CODEOWNERS': '/src/github-owned.js @github\n',
      'docs/CODEOWNERS': '/src/docs-owned.js @docs\n',
      'src/root-owned.js': 'module.exports = "root"\n',
      'src/github-owned.js': 'module.exports = "github"\n',
      'src/docs-owned.js': 'module.exports = "docs"\n',
    },
  })

  const result = runCli([
    '--glob', 'src/root-owned.js',
    '--glob', 'src/github-owned.js',
    '--glob', 'src/docs-owned.js',
    '--output', 'github-codeowners-scope.html',
  ], { cwd: repoDir })
  assert.equal(result.status, 0, result.stderr)

  const html = readFileSync(path.join(repoDir, 'github-codeowners-scope.html'), 'utf8')
  const reportData = parseReportDataFromHtml(html)

  assert.equal(reportData.totals.owned, 1)
  assert.equal(reportData.totals.unowned, 2)
  assert.ok(!reportData.unownedFiles.includes('src/github-owned.js'))
  assert.ok(reportData.unownedFiles.includes('src/root-owned.js'))
  assert.ok(reportData.unownedFiles.includes('src/docs-owned.js'))

  assert.deepEqual(reportData.codeownersFiles.map(row => row.path), ['.github/CODEOWNERS'])
  assert.equal(Object.hasOwn(reportData.codeownersFiles[0], 'dir'), false)
})

test('root CODEOWNERS takes precedence over docs/CODEOWNERS when .github is absent', (t) => {
  const repoDir = createRepo(t, {
    codeowners: '/src/root-owned.js @root\n',
    trackedFiles: {
      'docs/CODEOWNERS': '/src/docs-owned.js @docs\n',
      'src/root-owned.js': 'module.exports = "root"\n',
      'src/docs-owned.js': 'module.exports = "docs"\n',
    },
  })

  const result = runCli([
    '--glob', 'src/root-owned.js',
    '--glob', 'src/docs-owned.js',
    '--output', 'root-codeowners-scope.html',
  ], { cwd: repoDir })
  assert.equal(result.status, 0, result.stderr)

  const html = readFileSync(path.join(repoDir, 'root-codeowners-scope.html'), 'utf8')
  const reportData = parseReportDataFromHtml(html)

  assert.equal(reportData.totals.owned, 1)
  assert.equal(reportData.totals.unowned, 1)
  assert.ok(!reportData.unownedFiles.includes('src/root-owned.js'))
  assert.ok(reportData.unownedFiles.includes('src/docs-owned.js'))
  assert.deepEqual(reportData.codeownersFiles.map(row => row.path), ['CODEOWNERS'])
})

test('nested CODEOWNERS files are ignored', (t) => {
  const repoDir = createRepo(t, {
    codeowners: '/packages/root-owned.js @root\n',
    trackedFiles: {
      'packages/CODEOWNERS': '/nested-owned.js @nested\n',
      'packages/root-owned.js': 'module.exports = "root"\n',
      'packages/nested-owned.js': 'module.exports = "nested"\n',
    },
  })

  const result = runCli([
    '--glob', 'packages/root-owned.js',
    '--glob', 'packages/nested-owned.js',
    '--output', 'nested-codeowners-ignored.html',
  ], { cwd: repoDir })
  assert.equal(result.status, 0, result.stderr)

  const html = readFileSync(path.join(repoDir, 'nested-codeowners-ignored.html'), 'utf8')
  const reportData = parseReportDataFromHtml(html)

  assert.equal(reportData.totals.owned, 1)
  assert.equal(reportData.totals.unowned, 1)
  assert.ok(!reportData.unownedFiles.includes('packages/root-owned.js'))
  assert.ok(reportData.unownedFiles.includes('packages/nested-owned.js'))
  assert.deepEqual(reportData.codeownersFiles.map(row => row.path), ['CODEOWNERS'])
})

test('handles large repositories without git stdout buffer overflow', (t) => {
  const repoDir = createRepo(t)
  const stressData = addTrackedBulkFilesForStress(repoDir, GIT_BUFFER_STRESS_TARGET_BYTES)
  assert.ok(
    stressData.estimatedGitListBytes > DEFAULT_EXEC_FILE_MAX_BUFFER_BYTES,
    'fixture should exceed the historical 1 MiB execFileSync maxBuffer default'
  )

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
  assert.match(result.stdout, /Usage: codeowners-audit \[repo-or-path\] \[options\]/)
  assert.match(result.stdout, /--include-untracked/)
  assert.match(result.stdout, /--output-dir/)
  assert.match(result.stdout, /--cwd/)
  assert.match(result.stdout, /-y, --yes/)
  assert.match(result.stdout, /--no-open/)
  assert.match(result.stdout, /--no-report/)
  assert.match(result.stdout, /--list-unowned/)
  assert.match(result.stdout, /--fail-on-unowned/)
  assert.match(result.stdout, /--fail-on-missing-paths/)
  assert.match(result.stdout, /--fail-on-location-warnings/)
  assert.match(result.stdout, /--glob/)
  assert.match(result.stdout, /-g, --glob <pattern>/)
  assert.match(result.stdout, /--suggest-teams/)
  assert.match(result.stdout, /--suggest-ignore-teams/)
  assert.match(result.stdout, /--github-token/)
  assert.match(result.stdout, /--verbose/)
  assert.match(result.stdout, /--version/)
  assert.match(result.stdout, /  -o, --output <path> {6}Output HTML file path/)
  assert.match(result.stdout, /--suggest-window-days <days>\n {27}Git history lookback window for suggestions/)
  assert.match(result.stdout, /--suggest-ignore-teams <list>\n {27}Comma-separated team slugs/)
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

test('opens local report in browser after Enter confirmation', (t) => {
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
  writeFakeNodeScript(fakeOpenPath, [
    'const fs = require("node:fs")',
    `fs.writeFileSync(${JSON.stringify(openLogPath)}, process.argv.slice(2).join("\\n"), "utf8")`,
  ])

  const result = runCli([], {
    cwd: repoDir,
    noOpen: false,
    stdinData: '\n',
    env: {
      PATH: fakeBinDir + path.delimiter + process.env.PATH,
    },
  })

  assert.equal(result.status, 0, result.stderr)
  assert.ok(existsSync(openLogPath), 'fake browser opener should be called')
  assert.match(readFileSync(openLogPath, 'utf8').trim(), /codeowners-gaps-report\.html$/)
  assert.match(result.stdout, /Press Enter to open it in your browser/)
  assert.match(result.stdout, /Opened report in browser/)
})

test('-y opens local report in browser without prompting', (t) => {
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
  writeFakeNodeScript(fakeOpenPath, [
    'const fs = require("node:fs")',
    `fs.writeFileSync(${JSON.stringify(openLogPath)}, process.argv.slice(2).join("\\n"), "utf8")`,
  ])

  const result = runCli(['-y'], {
    cwd: repoDir,
    noOpen: false,
    env: {
      PATH: fakeBinDir + path.delimiter + process.env.PATH,
    },
  })

  assert.equal(result.status, 0, result.stderr)
  assert.ok(existsSync(openLogPath), 'fake browser opener should be called')
  assert.match(readFileSync(openLogPath, 'utf8').trim(), /codeowners-gaps-report\.html$/)
  assert.doesNotMatch(result.stdout, /Press Enter to open it in your browser/)
  assert.match(result.stdout, /Opened report in browser/)
})

test('does not open local report when open confirmation is declined', (t) => {
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
  writeFakeNodeScript(fakeOpenPath, [
    'const fs = require("node:fs")',
    `fs.writeFileSync(${JSON.stringify(openLogPath)}, process.argv.slice(2).join("\\n"), "utf8")`,
  ])

  const result = runCli([], {
    cwd: repoDir,
    noOpen: false,
    stdinData: 'no\n',
    env: {
      PATH: fakeBinDir + path.delimiter + process.env.PATH,
    },
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(existsSync(openLogPath), false, 'fake browser opener should not be called')
  assert.match(result.stdout, /Press Enter to open it in your browser/)
  assert.match(result.stdout, /Skipped opening report in browser/)
})

test('--upload uses fetch response URL in output', async (t) => {
  const repoDir = createRepo(t)

  let capturedPayload = ''
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      capturedPayload = body
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ url: 'https://zenbin.org/p/test-page' }))
    })
  })
  await /** @type {Promise<void>} */ (
    new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  )
  t.after(() => { server.close() })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const apiBaseUrl = `http://127.0.0.1:${address.port}`

  const result = await runCliAsync(['--upload'], {
    cwd: repoDir,
    env: {
      CODEOWNERS_AUDIT_ZENBIN_BASE_URL: apiBaseUrl,
    },
  })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Uploaded report \(zenbin\): https:\/\/zenbin\.org\/p\/test-page/)
  assert.ok(capturedPayload.length > 0, 'mock server should receive the upload payload')
  assert.match(capturedPayload, /"html":/)
})

test('--upload opens uploaded URL in browser after Enter confirmation', async (t) => {
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
  writeFakeNodeScript(fakeOpenPath, [
    'const fs = require("node:fs")',
    `fs.writeFileSync(${JSON.stringify(openLogPath)}, process.argv.slice(2).join("\\n"), "utf8")`,
  ])

  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ url: 'https://zenbin.org/p/test-upload-open' }))
    })
  })
  await /** @type {Promise<void>} */ (
    new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  )
  t.after(() => { server.close() })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const apiBaseUrl = `http://127.0.0.1:${address.port}`

  const result = await runCliAsync(['--upload'], {
    cwd: repoDir,
    noOpen: false,
    stdinData: '\n',
    env: {
      PATH: fakeBinDir + path.delimiter + process.env.PATH,
      CODEOWNERS_AUDIT_ZENBIN_BASE_URL: apiBaseUrl,
    },
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(readFileSync(openLogPath, 'utf8').trim(), 'https://zenbin.org/p/test-upload-open')
  assert.match(result.stdout, /Press Enter to open it in your browser/)
  assert.match(result.stdout, /Opened report in browser\./)
})

test('--upload fails with a clear message when the report is too large', async (t) => {
  const repoDir = createRepo(t)

  addTrackedBulkFilesForStress(repoDir, ZENBIN_UPLOAD_STRESS_TARGET_BYTES)

  const server = createServer((_req, res) => {
    res.statusCode = 500
    res.end('should not be called')
  })
  await /** @type {Promise<void>} */ (
    new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  )
  t.after(() => { server.close() })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const apiBaseUrl = `http://127.0.0.1:${address.port}`

  const result = await runCliAsync(['--upload'], {
    cwd: repoDir,
    env: {
      CODEOWNERS_AUDIT_ZENBIN_BASE_URL: apiBaseUrl,
    },
  })

  assert.equal(result.status, 2)
  assert.match(result.stderr, /report is too large for ZenBin/)
})

// --- Remote repo (first positional argument) tests ---

function createBareRemoteRepo (t, options = {}) {
  const srcDir = createRepo(t, options)
  commitStaged(srcDir, 'initial commit', 0, 'Test User', 'test@example.com')

  const bareDir = mkdtempSync(path.join(tmpdir(), 'cotest-bare-'))
  t.after(() => {
    rmSync(bareDir, { recursive: true, force: true })
  })

  execFileSync('git', ['clone', '--bare', srcDir, bareDir], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  return `file://${bareDir}`
}

test('first positional as remote URL clones and produces a report', (t) => {
  const remoteUrl = createBareRemoteRepo(t)

  const outputDir = mkdtempSync(path.join(tmpdir(), 'codeowners-audit-remote-out-'))
  t.after(() => {
    rmSync(outputDir, { recursive: true, force: true })
  })
  const outputFile = path.join(outputDir, 'remote-report.html')

  const result = runCli([remoteUrl, '--output', outputFile])

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Cloning/)
  assert.ok(existsSync(outputFile), 'report should exist at the specified output path')

  const html = readFileSync(outputFile, 'utf8')
  assert.match(html, /<title>CODEOWNERS Gap Report<\/title>/)

  const reportData = parseReportDataFromHtml(html)
  assert.doesNotMatch(reportData.repoName, /codeowners-audit-/, 'repoName should not be the temp clone directory name')
})

test('remote clone report uses owner/repo as the repo name for GitHub-like URLs', (t) => {
  const remoteUrl = createBareRemoteRepo(t)

  const outputDir = mkdtempSync(path.join(tmpdir(), 'codeowners-audit-name-out-'))
  t.after(() => {
    rmSync(outputDir, { recursive: true, force: true })
  })
  const outputFile = path.join(outputDir, 'name-test.html')

  const result = runCli([remoteUrl, '--output', outputFile])

  assert.equal(result.status, 0, result.stderr)
  const html = readFileSync(outputFile, 'utf8')
  const reportData = parseReportDataFromHtml(html)
  assert.doesNotMatch(reportData.repoName, /codeowners-audit-/, 'repoName should not contain the temp dir prefix')
})

test('first positional as remote URL resolves --output relative to cwd', (t) => {
  const remoteUrl = createBareRemoteRepo(t)

  const workDir = mkdtempSync(path.join(tmpdir(), 'codeowners-audit-remote-cwd-'))
  t.after(() => {
    rmSync(workDir, { recursive: true, force: true })
  })

  const result = runCli([remoteUrl, '--output', 'my-report.html'], { cwd: workDir })

  assert.equal(result.status, 0, result.stderr)
  const expectedPath = path.join(workDir, 'my-report.html')
  assert.ok(existsSync(expectedPath), `report should be written at ${expectedPath}`)
})

test('first positional as remote URL cleans up the temp clone', (t) => {
  const remoteUrl = createBareRemoteRepo(t)

  const result = runCli([remoteUrl])

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Cloning/)
})

test('--yes skips full-clone confirmation for remote --suggest-teams runs', (t) => {
  const remoteUrl = createBareRemoteRepo(t)

  const outputDir = mkdtempSync(path.join(tmpdir(), 'codeowners-audit-remote-suggest-out-'))
  t.after(() => {
    rmSync(outputDir, { recursive: true, force: true })
  })
  const outputFile = path.join(outputDir, 'remote-suggest-report.html')

  const result = runCli([remoteUrl, '--suggest-teams', '--yes', '--output', outputFile])

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Full repository clone required for --suggest-teams/)
  assert.doesNotMatch(result.stdout, /Proceed with full clone/)
  assert.match(result.stdout, /Cloning/)
  assert.ok(existsSync(outputFile), 'report should exist at the specified output path')
})

test('first positional as local path works like --cwd', (t) => {
  const repoDir = createRepo(t)

  const outputDir = mkdtempSync(path.join(tmpdir(), 'codeowners-audit-localpath-out-'))
  t.after(() => {
    rmSync(outputDir, { recursive: true, force: true })
  })
  const outputFile = path.join(outputDir, 'local-report.html')

  const result = runCli([repoDir, '--output', outputFile])

  assert.equal(result.status, 0, result.stderr)
  assert.ok(existsSync(outputFile), 'report should exist')
})

test('first positional and --cwd cannot both be specified', (t) => {
  const repoDir = createRepo(t)

  const result = runCli([repoDir, '--cwd', repoDir])

  assert.equal(result.status, 2)
  assert.match(result.stderr, /Cannot specify both/)
})

test('first positional with invalid remote URL fails with a clear error', (t) => {
  const result = runCli(['file:///nonexistent/repo/path'])

  assert.equal(result.status, 2)
  assert.match(result.stderr, /Failed to clone repository/)
})

test('GitHub shorthand is detected as a remote URL', (t) => {
  const result = runCli(['nonexistent-owner-abc/nonexistent-repo-xyz'])

  assert.equal(result.status, 2)
  assert.match(result.stdout, /Cloning https:\/\/github\.com\/nonexistent-owner-abc\/nonexistent-repo-xyz\.git/)
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

  const missingWorkingDirResult = runCli(['--cwd'], { cwd: repoDir })
  assert.equal(missingWorkingDirResult.status, 2)
  assert.match(missingWorkingDirResult.stderr, /Missing value for --cwd/)

  const missingGlobResult = runCli(['--glob'], { cwd: repoDir })
  assert.equal(missingGlobResult.status, 2)
  assert.match(missingGlobResult.stderr, /Missing value for --glob/)

  const missingShortGlobResult = runCli(['-g'], { cwd: repoDir })
  assert.equal(missingShortGlobResult.status, 2)
  assert.match(missingShortGlobResult.stderr, /Missing value for --glob/)

  const missingSuggestionsWindowResult = runCli(['--suggest-window-days'], { cwd: repoDir })
  assert.equal(missingSuggestionsWindowResult.status, 2)
  assert.match(missingSuggestionsWindowResult.stderr, /Missing value for --suggest-window-days/)

  const invalidSuggestionsTopResult = runCli(['--suggest-top=0'], { cwd: repoDir })
  assert.equal(invalidSuggestionsTopResult.status, 2)
  assert.match(invalidSuggestionsTopResult.stderr, /--suggest-top must be >= 1/)

  const missingIgnoreTeamsResult = runCli(['--suggest-ignore-teams'], { cwd: repoDir })
  assert.equal(missingIgnoreTeamsResult.status, 2)
  assert.match(missingIgnoreTeamsResult.stderr, /Missing value for --suggest-ignore-teams/)
})
