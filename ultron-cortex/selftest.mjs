import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { applyChanges, createSelfTestWorkspace, discoverWorkspace, rankFiles } from './core.mjs'
import { evidenceFresh, loadCheckpoint, recordEvidence, saveCheckpoint, workingTreeFingerprint } from './reliability.mjs'

const root = createSelfTestWorkspace()
process.env.ULTRON_CORTEX_STATE_DIR = path.join(root, '.cortex-state')

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

  const before = workingTreeFingerprint(root)
  const applied = applyChanges(root, [{
    path: 'src/math.js',
    type: 'replace',
    replacements: [{ oldString: 'return a - b', newString: 'return a + b' }],
  }])
  assert.deepEqual(applied.changedFiles, ['src/math.js'])
  assert.match(fs.readFileSync(path.join(root, 'src', 'math.js'), 'utf8'), /a \+ b/)
  const after = workingTreeFingerprint(root)
  assert.notEqual(before, after, 'working-tree fingerprint must change after source changes')

  const evidence = recordEvidence(root, 'selftest', {
    passed: true,
    status: 'completed',
    checks: [{ command: 'npm test', ok: true, skipped: false, code: 0, durationMs: 10 }],
  }, { fingerprint: after })
  assert.equal(evidence.verified, true)
  assert.equal(evidenceFresh(root, evidence).fresh, true)

  fs.appendFileSync(path.join(root, 'src', 'other.js'), '// changed after verification\n')
  assert.equal(evidenceFresh(root, evidence).fresh, false, 'verification evidence must become stale after code changes')

  saveCheckpoint(root, { status: 'in-progress', stage: 'selftest', task: 'fix math' })
  const checkpoint = loadCheckpoint(root)
  assert.equal(checkpoint.status, 'in-progress')
  assert.equal(checkpoint.task, 'fix math')
  assert.equal(typeof checkpoint.fingerprint, 'string')

  let escaped = false
  try {
    applyChanges(root, [{ path: '../escape.js', type: 'write', content: 'nope' }])
  } catch { escaped = true }
  assert.equal(escaped, true)

  console.log('ULTRON Coding Brain self-test passed: discovery, ranking, safe edit, path guard, working-tree fingerprint, evidence freshness, checkpoint restore.')
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
