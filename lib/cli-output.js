const EXIT_CODE_UNCOVERED = 1
const ANSI_RESET = '\u001b[0m'
const ANSI_BOLD = '\u001b[1m'
const ANSI_DIM = '\u001b[2m'
const ANSI_RED = '\u001b[31m'
const ANSI_GREEN = '\u001b[32m'
const ANSI_YELLOW = '\u001b[33m'
const ANSI_CYAN = '\u001b[36m'

export { EXIT_CODE_UNCOVERED }

/**
 * Determine whether ANSI color output should be enabled for a stream.
 * @param {{ isTTY?: boolean }} stream
 * @returns {boolean}
 */
export function shouldUseColorOutput (stream) {
  if (process.env.NO_COLOR !== undefined) return false
  if (process.env.FORCE_COLOR === '0') return false
  if (process.env.FORCE_COLOR !== undefined) return true
  return Boolean(stream && stream.isTTY)
}

/**
 * Wrap text with ANSI color/style codes when enabled.
 * @param {string} text
 * @param {string[]} styles
 * @param {boolean} enabled
 * @returns {string}
 */
export function colorizeCliText (text, styles, enabled) {
  if (!enabled || styles.length === 0) return text
  return `${styles.join('')}${text}${ANSI_RESET}`
}

/**
 * Format a CODEOWNERS discovery warning for CLI output.
 * @param {import('./types.js').DiscoveryWarning} warning
 * @param {boolean} useColor
 * @returns {string}
 */
export function formatCodeownersDiscoveryWarningForCli (warning, useColor) {
  const bullet = colorizeCliText('- ', [ANSI_DIM], useColor)
  const warningPath = colorizeCliText(warning.path, [ANSI_YELLOW], useColor)
  const warningText = colorizeCliText(
    warning.type === 'unused-supported-location'
      ? ' is unused because GitHub selects '
      : ' is in an unsupported location and is ignored by GitHub.',
    [ANSI_DIM],
    useColor
  )

  if (warning.type === 'unused-supported-location' && warning.referencePath) {
    const referencePath = colorizeCliText(warning.referencePath, [ANSI_CYAN], useColor)
    const trailingText = colorizeCliText(' first.', [ANSI_DIM], useColor)
    return bullet + warningPath + warningText + referencePath + trailingText
  }

  return bullet + warningPath + warningText
}

/**
 * Format a missing CODEOWNERS path warning for CLI output.
 * @param {import('./types.js').MissingPathWarning} warning
 * @param {boolean} useColor
 * @returns {string}
 */
export function formatMissingPathWarningForCli (warning, useColor) {
  const bullet = colorizeCliText('- ', [ANSI_DIM], useColor)
  const warningPath = colorizeCliText(warning.pattern, [ANSI_YELLOW], useColor)
  const ownerLabel = colorizeCliText(' owners: ', [ANSI_DIM], useColor)
  const ownerList = formatCodeownersOwnersList(warning.owners)
  const ownerText = colorizeCliText(ownerList, [ANSI_CYAN], useColor)
  return bullet + warningPath + ownerLabel + ownerText
}

/**
 * Format an unprotected directory warning for CLI output.
 * @param {import('./types.js').UnprotectedDirectoryWarning} warning
 * @param {boolean} useColor
 * @returns {string}
 */
export function formatUnprotectedDirectoryWarningForCli (warning, useColor) {
  const bullet = colorizeCliText('- ', [ANSI_DIM], useColor)
  const dirPath = colorizeCliText(
    warning.directory === '/' ? '/' : `${warning.directory}/`,
    [ANSI_YELLOW],
    useColor
  )
  const detail = colorizeCliText(
    ` (${warning.fileCount} ${warning.fileCount === 1 ? 'file' : 'files'}) — new files will lack owners`,
    [ANSI_DIM],
    useColor
  )
  return bullet + dirPath + detail
}

/**
 * Format a CODEOWNERS owner list for human-readable output.
 * @param {string[]|undefined} owners
 * @returns {string}
 */
export function formatCodeownersOwnersList (owners) {
  if (!Array.isArray(owners) || owners.length === 0) return '(none)'
  return owners.join(', ')
}

/**
 * Emit CLI results for unowned file reporting and failure gating.
 * Coverage summary is always printed.
 * Exit code 1 means policy violations when fail flags are enabled.
 * @param {{
 *   totals: { files: number, unowned: number },
 *   codeownersFiles?: { path: string, rules: number }[],
 *   unownedFiles: string[],
 *   codeownersValidationMeta?: {
 *     discoveryWarnings?: import('./types.js').DiscoveryWarning[],
 *     missingPathWarnings?: import('./types.js').MissingPathWarning[],
 *     unprotectedDirectoryWarnings?: import('./types.js').UnprotectedDirectoryWarning[]
 *   }
 * }} report
 * @param {{
 *   noReport: boolean,
 *   listUnowned: boolean,
 *   failOnUnowned: boolean,
 *   failOnMissingPaths: boolean,
 *   failOnLocationWarnings: boolean,
 *   failOnFragileCoverage: boolean,
 *   checkGlobs: string[],
 *   showCoverageSummary?: boolean,
 * }} options
 * @returns {void}
 */
export function outputUnownedReportResults (report, options) {
  const globListLabel = options.checkGlobs.length === 1
    ? JSON.stringify(options.checkGlobs[0])
    : JSON.stringify(options.checkGlobs)
  const activeCodeownersPath = Array.isArray(report.codeownersFiles) && report.codeownersFiles[0]
    ? report.codeownersFiles[0].path
    : null
  const discoveryWarnings = Array.isArray(report.codeownersValidationMeta?.discoveryWarnings)
    ? report.codeownersValidationMeta.discoveryWarnings
    : []
  const locationWarningCount = discoveryWarnings.length
  const missingPathWarnings = Array.isArray(report.codeownersValidationMeta?.missingPathWarnings)
    ? report.codeownersValidationMeta.missingPathWarnings
    : []
  const missingPathWarningCount = missingPathWarnings.length
  const unprotectedDirectoryWarnings = Array.isArray(report.codeownersValidationMeta?.unprotectedDirectoryWarnings)
    ? report.codeownersValidationMeta.unprotectedDirectoryWarnings
    : []
  const unprotectedDirectoryWarningCount = unprotectedDirectoryWarnings.length
  const unknownFileCount = report.unownedFiles.length
  const colorStdout = shouldUseColorOutput(process.stdout)
  const colorStderr = shouldUseColorOutput(process.stderr)

  if (options.listUnowned && unknownFileCount > 0) {
    console.log(
      colorizeCliText(`Unknown files (${unknownFileCount}):`, [ANSI_BOLD, ANSI_RED], colorStdout)
    )
    for (const filePath of report.unownedFiles) {
      console.log(`- ${filePath}`)
    }
    console.log('')
  }

  if (options.noReport && missingPathWarningCount > 0) {
    console.error(
      colorizeCliText(
        `Missing CODEOWNERS paths (${missingPathWarningCount}):`,
        [ANSI_BOLD, ANSI_YELLOW],
        colorStderr
      )
    )
    for (const warning of missingPathWarnings) {
      console.error('%s', formatMissingPathWarningForCli(warning, colorStderr))
    }
    console.error('')
  }

  if (options.noReport && locationWarningCount > 0) {
    console.error(
      colorizeCliText(
        `CODEOWNERS location warnings (${locationWarningCount}):`,
        [ANSI_BOLD, ANSI_YELLOW],
        colorStderr
      )
    )
    for (const warning of discoveryWarnings) {
      console.error('%s', formatCodeownersDiscoveryWarningForCli(warning, colorStderr))
    }
    console.error('')
  }

  if (options.noReport && unprotectedDirectoryWarningCount > 0) {
    console.error(
      colorizeCliText(
        `Directories with fragile coverage (${unprotectedDirectoryWarningCount}):`,
        [ANSI_BOLD, ANSI_YELLOW],
        colorStderr
      )
    )
    for (const warning of unprotectedDirectoryWarnings) {
      console.error('%s', formatUnprotectedDirectoryWarningForCli(warning, colorStderr))
    }
    console.error('')
  }

  if (options.showCoverageSummary !== false) {
    console.log(
      [
        colorizeCliText('Coverage summary:', [ANSI_BOLD, ANSI_CYAN], colorStdout),
        `${colorizeCliText('globs:', [ANSI_DIM], colorStdout)} ${globListLabel}`,
        ...(activeCodeownersPath
          ? [`${colorizeCliText('codeowners file:', [ANSI_DIM], colorStdout)} ${colorizeCliText(activeCodeownersPath, [ANSI_BOLD], colorStdout)}`]
          : []),
        `${colorizeCliText('analyzed files:', [ANSI_DIM], colorStdout)} ${colorizeCliText(String(report.totals.files), [ANSI_BOLD], colorStdout)}`,
        `${colorizeCliText('unknown files:', [ANSI_DIM], colorStdout)} ${colorizeCliText(String(report.totals.unowned), report.totals.unowned > 0 ? [ANSI_BOLD, ANSI_RED] : [ANSI_BOLD, ANSI_GREEN], colorStdout)}`,
        `${colorizeCliText('missing path warnings:', [ANSI_DIM], colorStdout)} ${colorizeCliText(String(missingPathWarningCount), missingPathWarningCount > 0 ? [ANSI_BOLD, ANSI_YELLOW] : [ANSI_BOLD, ANSI_GREEN], colorStdout)}`,
        `${colorizeCliText('location warnings:', [ANSI_DIM], colorStdout)} ${colorizeCliText(String(locationWarningCount), locationWarningCount > 0 ? [ANSI_BOLD, ANSI_YELLOW] : [ANSI_BOLD, ANSI_GREEN], colorStdout)}`,
        `${colorizeCliText('fragile coverage directories:', [ANSI_DIM], colorStdout)} ${colorizeCliText(String(unprotectedDirectoryWarningCount), unprotectedDirectoryWarningCount > 0 ? [ANSI_BOLD, ANSI_YELLOW] : [ANSI_BOLD, ANSI_GREEN], colorStdout)}`,
      ].join('\n')
    )
  }

  if (options.failOnUnowned && report.unownedFiles.length > 0) {
    if (!options.listUnowned) {
      console.error('')
      for (const filePath of report.unownedFiles) {
        console.error('  - %s', filePath)
      }
    }
    process.exitCode = EXIT_CODE_UNCOVERED
  }

  if (options.failOnMissingPaths && missingPathWarningCount > 0) {
    process.exitCode = EXIT_CODE_UNCOVERED
  }

  if (options.failOnLocationWarnings && locationWarningCount > 0) {
    process.exitCode = EXIT_CODE_UNCOVERED
  }

  if (options.failOnFragileCoverage && unprotectedDirectoryWarningCount > 0) {
    process.exitCode = EXIT_CODE_UNCOVERED
  }
}
