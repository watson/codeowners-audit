import http from 'node:http'
import https from 'node:https'
import { readFileSync } from 'node:fs'

const DEFAULT_GITHUB_API_TIMEOUT_MS = 10000
const packageVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

/**
 * Fetch all array pages from GitHub REST API.
 * @param {{ token: string, baseUrl: string, timeoutMs?: number }} apiContext
 * @param {string} routePath
 * @returns {Promise<any[]>}
 */
async function fetchGithubApiPaginatedArray (apiContext, routePath) {
  const items = []
  for (let page = 1; page < 200; page++) {
    const response = await requestGithubApi(
      apiContext,
      routePath,
      new URLSearchParams({ per_page: '100', page: String(page) })
    )
    if (!Array.isArray(response.body)) {
      throw new Error(`Expected array response for ${routePath}, got ${typeof response.body}`)
    }
    items.push(...response.body)
    if (response.body.length < 100) break
  }
  return items
}

/**
 * Fetch a JSON value from GitHub REST API.
 * @param {{ token: string, baseUrl: string, timeoutMs?: number }} apiContext
 * @param {string} routePath
 * @returns {Promise<any>}
 */
async function fetchGithubApiJson (apiContext, routePath) {
  const response = await requestGithubApi(apiContext, routePath)
  return response.body
}

/**
 * Execute an HTTP request against the configured GitHub API endpoint.
 * @param {{ token: string, baseUrl: string, timeoutMs?: number }} apiContext
 * @param {string} routePath
 * @param {URLSearchParams} [query]
 * @returns {Promise<{ status: number, headers: Record<string, string>, body: any }>}
 */
async function requestGithubApi (apiContext, routePath, query = new URLSearchParams()) {
  const url = new URL(routePath.replace(/^\/+/, ''), ensureTrailingSlash(apiContext.baseUrl))
  for (const [key, value] of query.entries()) {
    url.searchParams.set(key, value)
  }

  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': `codeowners-audit/${packageVersion}`,
    authorization: `Bearer ${apiContext.token}`,
    'x-github-api-version': '2022-11-28',
  }

  const response = await requestJson(url, headers, apiContext.timeoutMs || DEFAULT_GITHUB_API_TIMEOUT_MS)
  if (response.status >= 400) {
    const apiMessage = response.body && typeof response.body.message === 'string'
      ? response.body.message
      : `HTTP ${response.status}`
    const error = new Error(`GitHub API request failed for ${routePath}: ${apiMessage}`)
    // @ts-ignore
    error.status = response.status
    throw error
  }
  return response
}

/**
 * Ensure a URL string ends with a slash.
 * @param {string} value
 * @returns {string}
 */
function ensureTrailingSlash (value) {
  return value.endsWith('/') ? value : `${value}/`
}

/**
 * Perform an HTTP request and parse JSON body.
 * @param {URL} url
 * @param {Record<string, string>} headers
 * @param {number} timeoutMs
 * @returns {Promise<{ status: number, headers: Record<string, string>, body: any }>}
 */
async function requestJson (url, headers, timeoutMs) {
  const transport = url.protocol === 'http:' ? http : https
  return await new Promise((resolve, reject) => {
    const request = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'GET',
        headers,
      },
      (response) => {
        /** @type {string[]} */
        const chunks = []
        response.setEncoding('utf8')
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          const rawBody = chunks.join('')
          let parsedBody = null
          if (rawBody) {
            try {
              parsedBody = JSON.parse(rawBody)
            } catch {
              parsedBody = { message: rawBody }
            }
          }
          /** @type {Record<string, string>} */
          const flatHeaders = {}
          for (const [headerKey, headerValue] of Object.entries(response.headers)) {
            if (!headerValue) continue
            flatHeaders[headerKey.toLowerCase()] = Array.isArray(headerValue) ? headerValue.join(', ') : String(headerValue)
          }
          resolve({
            status: response.statusCode || 0,
            headers: flatHeaders,
            body: parsedBody,
          })
        })
      }
    )
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`Request timed out after ${timeoutMs} ms`))
    })
    request.on('error', reject)
    request.end()
  })
}

export {
  fetchGithubApiJson,
  fetchGithubApiPaginatedArray,
  requestGithubApi,
}
