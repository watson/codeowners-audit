import { execFileSync } from 'node:child_process'

import { analyzeCommits as analyzeConventionalCommits } from '@semantic-release/commit-analyzer'
import { generateNotes as generateConventionalNotes } from '@semantic-release/release-notes-generator'

const DEFAULT_RELEASE_PATHS = [
  'report.js',
  'lib/**',
  'package.json',
]

const publishableCommitCache = new Map()

function toPathspec (pattern) {
  return /[*?[]/.test(pattern) ? `:(glob)${pattern}` : pattern
}

function makeCacheKey (cwd, releasePaths, commits) {
  return JSON.stringify([cwd, releasePaths, commits.map(({ hash }) => hash)])
}

function listChangedPublishableFiles (cwd, hash, releasePaths) {
  if (!hash) return []

  const output = execFileSync(
    'git',
    [
      'diff-tree',
      '--root',
      '--no-commit-id',
      '--name-only',
      '-r',
      '-m',
      hash,
      '--',
      ...releasePaths.map(toPathspec),
    ],
    {
      cwd,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    }
  )

  return [...new Set(output.split('\n').map((value) => value.trim()).filter(Boolean))]
}

export function getReleasePaths (pluginConfig = {}) {
  const releasePaths = pluginConfig.releasePaths

  return Array.isArray(releasePaths) && releasePaths.length > 0
    ? releasePaths
    : DEFAULT_RELEASE_PATHS
}

export function getNotesHeader (pluginConfig = {}) {
  return pluginConfig.notesHeader ?? 'Only conventional commits that touched publishable CLI/runtime files are included in this release.'
}

export function getPublishableCommits (pluginConfig = {}, context) {
  const { commits, cwd, logger } = context
  const releasePaths = getReleasePaths(pluginConfig)
  const cacheKey = makeCacheKey(cwd, releasePaths, commits)

  if (publishableCommitCache.has(cacheKey)) {
    return publishableCommitCache.get(cacheKey)
  }

  const publishableCommits = commits
    .map((commit) => ({
      ...commit,
      publishableFiles: listChangedPublishableFiles(cwd, commit.hash, releasePaths),
    }))
    .filter((commit) => commit.publishableFiles.length > 0)

  if (logger?.log) {
    logger.log(
      'Found %s publishable commits out of %s total when matching release paths: %s',
      publishableCommits.length,
      commits.length,
      releasePaths.join(', ')
    )
  }

  publishableCommitCache.set(cacheKey, publishableCommits)
  return publishableCommits
}

export async function analyzeCommits (pluginConfig = {}, context) {
  const publishableCommits = getPublishableCommits(pluginConfig, context)

  if (publishableCommits.length === 0) {
    context.logger.log('No publishable commits were found since the previous release.')
    return null
  }

  return analyzeConventionalCommits(pluginConfig.commitAnalyzer ?? {}, {
    ...context,
    commits: publishableCommits,
  })
}

export async function generateNotes (pluginConfig = {}, context) {
  const publishableCommits = getPublishableCommits(pluginConfig, context)

  if (publishableCommits.length === 0) {
    return ''
  }

  const notes = await generateConventionalNotes(pluginConfig.releaseNotesGenerator ?? {}, {
    ...context,
    commits: publishableCommits,
  })

  const notesHeader = getNotesHeader(pluginConfig)
  return notesHeader ? `${notesHeader}\n\n${notes}` : notes
}
