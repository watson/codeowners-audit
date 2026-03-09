/**
 * Resolve token from CLI flag or conventional env vars.
 * @param {string|undefined} cliToken
 * @returns {{ token: string, source: 'cli'|'GITHUB_TOKEN'|'GH_TOKEN'|'none' }}
 */
export function resolveGithubToken (cliToken) {
  if (cliToken) {
    return {
      token: String(cliToken),
      source: 'cli',
    }
  }
  if (process.env.GITHUB_TOKEN) {
    return {
      token: String(process.env.GITHUB_TOKEN),
      source: 'GITHUB_TOKEN',
    }
  }
  if (process.env.GH_TOKEN) {
    return {
      token: String(process.env.GH_TOKEN),
      source: 'GH_TOKEN',
    }
  }
  return {
    token: '',
    source: 'none',
  }
}

/**
 * Resolve repository owner/repo from origin remote URL.
 * @param {string} repoRoot
 * @param {(args: string[], cwd?: string) => string} runGitCommand
 * @returns {{ owner: string, repo: string }|null}
 */
export function resolveGithubRepoIdentity (repoRoot, runGitCommand) {
  /** @type {string} */
  let remoteUrl
  try {
    remoteUrl = runGitCommand(['remote', 'get-url', 'origin'], repoRoot).trim()
  } catch {
    return null
  }
  return parseRemoteUrlToOwnerRepo(remoteUrl)
}

/**
 * Parse owner/repo from common GitHub remote URL formats.
 * @param {string} remoteUrl
 * @returns {{ owner: string, repo: string }|null}
 */
export function parseRemoteUrlToOwnerRepo (remoteUrl) {
  const sshMatch = remoteUrl.match(/^git@[^:]+:([^/]+)\/(.+?)(?:\.git)?$/)
  if (sshMatch) {
    return {
      owner: sshMatch[1],
      repo: sshMatch[2],
    }
  }

  try {
    const parsed = new URL(remoteUrl)
    const parts = parsed.pathname.replaceAll(/^\/+|\/+$/g, '').split('/')
    if (parts.length >= 2) {
      return {
        owner: parts[0],
        repo: parts[1].replace(/\.git$/i, ''),
      }
    }
  } catch {}

  return null
}
