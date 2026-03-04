'use strict'

/**
 * Create a wall-clock progress logger.
 * @param {boolean} enabled
 * @returns {(message: string, ...values: any[]) => void}
 */
function createProgressLogger (enabled) {
  if (!enabled) return () => {}
  const startedAt = Date.now()
  return (message, ...values) => {
    const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1)
    const rendered = formatTemplate(message, values)
    console.log('[progress +' + elapsedSeconds + 's] ' + rendered)
  }
}

/**
 * Render %d/%s placeholders for simple log templates.
 * @param {string} template
 * @param {any[]} values
 * @returns {string}
 */
function formatTemplate (template, values) {
  let index = 0
  return String(template).replaceAll(/%[sd]/g, () => {
    const value = values[index]
    index++
    return value === undefined ? '' : String(value)
  })
}

module.exports = {
  createProgressLogger,
}
