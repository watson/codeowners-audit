import path from 'node:path'
import { runGitCommand } from './git.js'

/**
 * Determine whether a value looks like a remote repository URL or shorthand
 * rather than a local file path.
 * @param {string} value
 * @returns {boolean}
 */
export function isRepoUrl (value) {
  if (value.includes('://')) return true
  if (value.startsWith('git@')) return true
  if (/^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9._-]+$/.test(value)) return true
  return false
}

/**
 * Normalize a repo identifier to a URL suitable for `git clone`.
 * Full URLs and SSH addresses are returned as-is.
 * GitHub-style shorthand (owner/repo) is expanded to an HTTPS URL.
 * @param {string} value
 * @returns {string}
 */
export function normalizeRepoUrl (value) {
  if (value.includes('://') || value.startsWith('git@')) return value
  return `https://github.com/${value}.git`
}

/**
 * Resolve a human-friendly display name for a repository.
 * Tries `git remote get-url origin` first and extracts "owner/repo" from it.
 * Falls back to the directory basename when no origin remote is available.
 * @param {string} repoRoot
 * @returns {string}
 */
export function resolveRepoDisplayName (repoRoot) {
  try {
    const remoteUrl = runGitCommand(['remote', 'get-url', 'origin'], repoRoot).trim()
    if (remoteUrl) {
      return deriveDisplayNameFromUrl(remoteUrl)
    }
  } catch {}
  return path.basename(repoRoot)
}

/**
 * Resolve a browsable repository URL from the origin remote when possible.
 * Returns null for repositories without an origin remote or file-based remotes.
 * @param {string} repoRoot
 * @returns {string|null}
 */
export function resolveRepoWebUrl (repoRoot) {
  try {
    const remoteUrl = runGitCommand(['remote', 'get-url', 'origin'], repoRoot).trim()
    if (remoteUrl) {
      return deriveRepoWebUrlFromRemoteUrl(remoteUrl)
    }
  } catch {}
  return null
}

/**
 * Derive a human-friendly repository name from a remote URL.
 * For GitHub/GitLab-style URLs, returns "owner/repo".
 * Falls back to the URL itself for unrecognised formats.
 * @param {string} url
 * @returns {string}
 */
export function deriveDisplayNameFromUrl (url) {
  const sshMatch = url.match(/^git@[^:]+:([^/]+)\/(.+?)(?:\.git)?$/)
  if (sshMatch) {
    return `${sshMatch[1]}/${sshMatch[2]}`
  }

  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'file:') {
      const base = path.posix.basename(parsed.pathname).replace(/\.git$/i, '')
      return base || url
    }
    const segments = parsed.pathname.replaceAll(/^\/+|\/+$/g, '').split('/')
    if (segments.length >= 2) {
      return `${segments[0]}/${segments[1].replace(/\.git$/i, '')}`
    }
  } catch {}

  return url
}

/**
 * Derive a browsable repository URL from a common git remote URL.
 * Supports git@host:owner/repo.git and http(s)://host/owner/repo(.git) forms.
 * @param {string} remoteUrl
 * @returns {string|null}
 */
export function deriveRepoWebUrlFromRemoteUrl (remoteUrl) {
  const sshMatch = remoteUrl.match(/^git@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/)
  if (sshMatch) {
    return `https://${sshMatch[1]}/${sshMatch[2]}/${sshMatch[3]}`
  }

  try {
    const parsed = new URL(remoteUrl)
    if (parsed.protocol === 'file:') return null
    const segments = parsed.pathname.replaceAll(/^\/+|\/+$/g, '').split('/')
    if (segments.length >= 2) {
      return `${parsed.protocol}//${parsed.host}/${segments[0]}/${segments[1].replace(/\.git$/i, '')}`
    }
  } catch {}

  return null
}
