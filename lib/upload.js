import path from 'node:path'
import { readFileSync } from 'node:fs'
import { UPLOAD_PROVIDER } from './cli-args.js'

const ZENBIN_BASE_URL = process.env.CODEOWNERS_AUDIT_ZENBIN_BASE_URL || 'https://zenbin.org'
const ZENBIN_MAX_UPLOAD_BYTES = 1024 * 1024

/**
 * Upload the generated HTML report to ZenBin and return the public URL.
 * @param {string} filePath
 * @returns {Promise<string>}
 */
export async function uploadReport (filePath) {
  const fileBaseName = path.basename(filePath, path.extname(filePath))
  const pageId = createZenbinPageId(fileBaseName)
  const payload = JSON.stringify({ html: readFileSync(filePath, 'utf8') })
  const payloadBytes = Buffer.byteLength(payload, 'utf8')

  if (payloadBytes >= ZENBIN_MAX_UPLOAD_BYTES) {
    throw new Error(
      `Upload failed (${UPLOAD_PROVIDER}): report is too large for ZenBin (${formatBytes(payloadBytes)} payload; ` +
      `limit is about ${formatBytes(ZENBIN_MAX_UPLOAD_BYTES)}). ` +
      `Re-run without --upload and share the generated HTML file directly.`
    )
  }

  const url = `${ZENBIN_BASE_URL}/v1/pages/${pageId}`

  /** @type {globalThis.Response} */
  let httpResponse
  try {
    httpResponse = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    })
  } catch (error) {
    throw new Error(`Upload failed (${UPLOAD_PROVIDER}): ${error instanceof Error ? error.message : String(error)}`)
  }

  const responseText = await httpResponse.text()

  if (!httpResponse.ok) {
    const likelyTooLargeHint = httpResponse.status === 400
      ? ` (ZenBin may reject payloads near 1 MiB; current payload is ${formatBytes(payloadBytes)})`
      : ''
    throw new Error(
      `Upload failed (${UPLOAD_PROVIDER}): HTTP ${httpResponse.status}${likelyTooLargeHint}`
    )
  }

  /** @type {{ url?: string }} */
  let response
  try {
    response = JSON.parse(responseText)
  } catch {
    throw new Error(
      `Upload failed (${UPLOAD_PROVIDER}): invalid JSON response: ${JSON.stringify(responseText.trim())}`
    )
  }

  const maybeUrl = response && typeof response.url === 'string' ? response.url.trim() : ''
  if (!/^https?:\/\//.test(maybeUrl)) {
    throw new Error(`Upload failed (${UPLOAD_PROVIDER}): missing URL in response: ${JSON.stringify(response)}`)
  }

  return maybeUrl
}

/**
 * Format bytes as an integer KiB value.
 * @param {number} byteCount
 * @returns {string}
 */
function formatBytes (byteCount) {
  return `${Math.ceil(byteCount / 1024)} KiB`
}

/**
 * Build a stable-ish unique page id for ZenBin uploads.
 * @param {string} fileBaseName
 * @returns {string}
 */
function createZenbinPageId (fileBaseName) {
  const normalizedBase = fileBaseName
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, 40)

  const base = normalizedBase || 'report'
  const timestamp = Date.now().toString(36)
  const randomPart = Math.random().toString(36).slice(2, 8)
  return `${base}-${timestamp}-${randomPart}`
}
