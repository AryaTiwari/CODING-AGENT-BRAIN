import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { applyChanges, createSelfTestWorkspace, discoverWorkspace, rankFiles } from './core.mjs'

const root = createSelfTestWorkspace()
try {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'cortex-test', scripts: { test: 'node -e "process.exit(0)"' } }, null, 2))
  fs.writeFileSync(path.join(root, 'src', 'math.js'), 'export function add(a, b) { return a - b }\n')
  fs.writeFileSync(path.join(root, 'src', 'other.js'), 'export const value = 42\n')

  const discovered = discoverWorkspace(root)
  assert(discovered.files.includes('src/math.js'))
  assert(discovered.files.includes('package.json'))
  const ranked = rankFiles('fix the add function in math', discovered.files, 3)
  assert.equal(ranked[0], 'src/math.js')

  const applied = applyChanges(root, [{
    path: 'src/math.js',
    type: 'replace',
    replacements: [{ oldString: 'return a - b', newString: 'return a + b' }],
  }])
  assert.deepEqual(applied.changedFiles, ['src/math.js'])
  assert.match(fs.readFileSync(path.join(root, 'src', 'math.js'), 'utf8'), /a \+ b/)

  let escaped = false
  try {
    applyChanges(root, [{ path: '../escape.js', type: 'write', content: 'nope' }])
  } catch { escaped = true }
  assert.equal(escaped, true)

  console.log('ULTRON Coding Brain self-test passed: discovery, relevance ranking, safe edit, path guard.')
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
