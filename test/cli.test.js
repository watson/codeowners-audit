const assert = require('node:assert/strict')
const { execFileSync, spawnSync } = require('node:child_process')
const { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync, existsSync, chmodSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const test = require('node:test')

const projectRoot = path.resolve(__dirname, '..')
const cliPath = path.join(projectRoot, 'report.js')
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

function runGit (cwd, args) {
  execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function createRepo (t, options = {}) {
  const repoDir = mkdtempSync(path.join(tmpdir(), 'codeowners-report-test-'))
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
  assert.ok(reportData.totals.files >= 3)
  assert.ok(reportData.unownedFiles.includes('src/unowned.js'))
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
    const absoluteDir = mkdtempSync(path.join(tmpdir(), 'codeowners-report-outdir-'))
    t.after(() => {
      rmSync(absoluteDir, { recursive: true, force: true })
    })

    const result = runCli(['--output-dir=' + absoluteDir], { cwd: repoDir })
    assert.equal(result.status, 0, result.stderr)
    assert.ok(existsSync(path.join(absoluteDir, defaultOutputFile)))
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

test('--help prints usage without failing', (t) => {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'codeowners-report-help-'))
  t.after(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  const result = runCli(['--help'], { cwd: tempDir })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Usage: codeowners-report \[options\]/)
  assert.match(result.stdout, /--include-untracked/)
  assert.match(result.stdout, /--output-dir/)
  assert.match(result.stdout, /--no-open/)
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

test('unknown and invalid options fail with a useful error', (t) => {
  const repoDir = createRepo(t)

  const unknownResult = runCli(['--nope'], { cwd: repoDir })
  assert.equal(unknownResult.status, 1)
  assert.match(unknownResult.stderr, /Unknown argument: --nope/)

  const missingOutputResult = runCli(['--output'], { cwd: repoDir })
  assert.equal(missingOutputResult.status, 1)
  assert.match(missingOutputResult.stderr, /Missing value for --output/)

  const missingOutputDirResult = runCli(['--output-dir'], { cwd: repoDir })
  assert.equal(missingOutputDirResult.status, 1)
  assert.match(missingOutputDirResult.stderr, /Missing value for --output-dir/)
})
