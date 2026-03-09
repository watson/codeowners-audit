/**
 * Extract parent directories from a repo-relative file path.
 * @param {string} filePath
 * @returns {string[]}
 */
export function directoryAncestors (filePath) {
  const segments = filePath.split('/')
  const ancestors = []
  let current = ''
  for (let index = 0; index < segments.length - 1; index++) {
    current = current ? `${current}/${segments[index]}` : segments[index]
    ancestors.push(current)
  }
  return ancestors
}
