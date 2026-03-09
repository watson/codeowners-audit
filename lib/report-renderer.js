import { readFileSync } from 'node:fs'

export const packageVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

const REPORT_TEMPLATE_PATH = new URL('./report.template.html', import.meta.url)
const REPORT_DATA_PLACEHOLDER = '__REPORT_DATA_JSON__'
const REPORT_LOGO_URL_PLACEHOLDER = '__REPORT_LOGO_URL__'
const REPORT_LOGO_URL = `https://raw.githubusercontent.com/watson/codeowners-audit/v${packageVersion}/assets/logo2-small.png`
const REPORT_VERSION_PLACEHOLDER = '__REPORT_VERSION__'
const REPORT_REPO_URL_PLACEHOLDER = '__REPORT_REPO_URL__'
const REPORT_REPO_URL = 'https://github.com/watson/codeowners-audit'
const REPORT_HTML_TEMPLATE = readFileSync(REPORT_TEMPLATE_PATH, 'utf8')

/**
 * Render a complete self-contained HTML page for the report.
 * @param {import('./types.js').ReportData} report
 * @returns {string}
 */
export function renderHtml (report) {
  const serializedReport = JSON.stringify(report, null, 2).replaceAll('<', String.raw`\u003c`)

  return REPORT_HTML_TEMPLATE
    .replace(REPORT_DATA_PLACEHOLDER, serializedReport)
    .replace(REPORT_LOGO_URL_PLACEHOLDER, REPORT_LOGO_URL)
    .replace(REPORT_VERSION_PLACEHOLDER, packageVersion)
    .replace(REPORT_REPO_URL_PLACEHOLDER, REPORT_REPO_URL)
}
