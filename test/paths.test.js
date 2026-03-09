import assert from 'node:assert/strict'
import test from 'node:test'

import { directoryAncestors } from '../lib/paths.js'

test('directoryAncestors: returns parent directories for nested path', () => {
  assert.deepEqual(directoryAncestors('src/lib/utils/file.js'), [
    'src',
    'src/lib',
    'src/lib/utils',
  ])
})

test('directoryAncestors: returns single parent for one-level path', () => {
  assert.deepEqual(directoryAncestors('src/file.js'), ['src'])
})

test('directoryAncestors: returns empty array for top-level file', () => {
  assert.deepEqual(directoryAncestors('file.js'), [])
})

test('directoryAncestors: returns empty array for empty string', () => {
  assert.deepEqual(directoryAncestors(''), [])
})

test('directoryAncestors: handles deeply nested paths', () => {
  assert.deepEqual(directoryAncestors('a/b/c/d/e.txt'), [
    'a',
    'a/b',
    'a/b/c',
    'a/b/c/d',
  ])
})
