import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { discoverWorkspace, resolveWorkspace } from './core.mjs'

function stateRoot() {
  return path.resolve(process.env.ULTRON_CORTEX_STATE_DIR || path.join(os.homedir(), '.ultron', 'coding-brain'))
}

function workspaceKey(rawWorkspace) {
  const root = resolveWorkspace(rawWorkspace)
  let real = root
  try { real = fs.realpathSync(root) } catch {}
  return crypto.createHash('sha1').update(`${os.hostname()}::${real}`).digest('hex').slice(0, 16)
}

export function stateDir(rawWorkspace) {
  const dir = path.join(stateRoot(), workspaceKey(rawWorkspace))
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function gitFiles(root) {
  try {
    const result = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 16 * 1024 * 1024,
    })
    if (result.status !== 0) return null
    return String(result.stdout || '').split('\0').filter(Boolean).map((file) => file.replaceAll('\\', '/')).sort()
  } catch {
    return null
  }
}

function fallbackFiles(root) {
  try { return discoverWorkspace(root, { maxFiles: 5000 }).files.slice().sort() }
  catch { return [] }
}

/**
 * A cross-platform content fingerprint inspired by gstack-wtree.
 * It binds verification to the files actually on disk, not to a commit SHA.
 * Tracked + untracked non-ignored files are included when Git is available.
 */
export function workingTreeFingerprint(rawWorkspace) {
  const root = resolveWorkspace(rawWorkspace)
  const files = gitFiles(root) || fallbackFiles(root)
  const hash = crypto.createHash('sha256')
  hash.update('ULTRON-CORTEX-WTREE-v1\0')
  for (const rel of files) {
    hash.update(rel)
    hash.update('\0')
    const abs = path.resolve(root, rel)
    try {
      const stat = fs.statSync(abs)
      if (!stat.isFile()) { hash.update('<non-file>\0'); continue }
      // Safety valve for generated giant files accidentally left unignored.
      if (stat.size > 16 * 1024 * 1024) {
        hash.update(`<large:${stat.size}:${stat.mtimeMs}>\0`)
        continue
      }
      hash.update(fs.readFileSync(abs))
      hash.update('\0')
    } catch {
      // Deleted tracked files remain in git ls-files, so deletion changes the hash.
      hash.update('<missing>\0')
    }
  }
  return hash.digest('hex')
}

function compactChecks(validation) {
  return (Array.isArray(validation?.checks) ? validation.checks : []).map((check) => ({
    command: String(check?.command || ''),
    ok: Boolean(check?.ok),
    skipped: Boolean(check?.skipped),
    code: Number.isFinite(Number(check?.code)) ? Number(check.code) : null,
    signal: check?.signal || null,
    durationMs: Number(check?.durationMs || 0),
  }))
}

function appendJsonl(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 })
  try { fs.chmodSync(file, 0o600) } catch {}
}

export function recordEvidence(rawWorkspace, label, validation, options = {}) {
  const root = resolveWorkspace(rawWorkspace)
  const fingerprint = options.fingerprint || workingTreeFingerprint(root)
  const checks = compactChecks(validation)
  const attempted = checks.filter((check) => !check.skipped)
  const verified = validation?.status === 'completed' && attempted.length > 0 && attempted.every((check) => check.ok)
  const record = {
    version: 1,
    ts: new Date().toISOString(),
    label: String(label || 'validation'),
    workspace: root,
    fingerprint,
    validationStatus: String(validation?.status || 'unknown'),
    passed: Boolean(validation?.passed),
    verified,
    reason: validation?.reason ? String(validation.reason).slice(0, 500) : null,
    checks,
  }
  appendJsonl(path.join(stateDir(root), 'evidence.jsonl'), record)
  return record
}

export function evidenceFresh(rawWorkspace, evidence) {
  if (!evidence?.fingerprint) return { fresh: false, currentFingerprint: workingTreeFingerprint(rawWorkspace), evidenceFingerprint: null }
  const currentFingerprint = workingTreeFingerprint(rawWorkspace)
  return {
    fresh: currentFingerprint === evidence.fingerprint,
    currentFingerprint,
    evidenceFingerprint: evidence.fingerprint,
  }
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tmp, file)
  try { fs.chmodSync(file, 0o600) } catch {}
}

export function saveCheckpoint(rawWorkspace, data = {}) {
  const root = resolveWorkspace(rawWorkspace)
  const checkpoint = {
    version: 1,
    updatedAt: new Date().toISOString(),
    workspace: root,
    fingerprint: workingTreeFingerprint(root),
    ...data,
  }
  atomicJson(path.join(stateDir(root), 'checkpoint.json'), checkpoint)
  return checkpoint
}

export function loadCheckpoint(rawWorkspace) {
  const root = resolveWorkspace(rawWorkspace)
  const file = path.join(stateDir(root), 'checkpoint.json')
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

export function isContinuationTask(task) {
  return /^(?:finish|continue|resume|retry|try again|keep going|proceed|do it|finish it)(?:\s+(?:it|this|that|now))?[.!?\s]*$/i.test(String(task || '').trim())
}

export function isBugTask(task) {
  const value = String(task || '')
  return /\b(?:bug|broken|error|exception|crash|failing|failure|fails|failed|regression|not working|doesn['’]?t work|stopped working|timeout|rate limit|wrong output|unexpected|fix why|debug|root cause|troubleshoot)\b/i.test(value)
}

export function isComplexFeatureTask(task) {
  const value = String(task || '')
  if (isBugTask(value)) return false
  const action = /\b(?:implement|build|create|add|integrate|migrate|redesign|refactor|architect|introduce)\b/i.test(value)
  const surface = /\b(?:feature|system|workflow|service|api|endpoint|backend|frontend|page|dashboard|authentication|authorization|database|schema|module|integration|architecture|pipeline)\b/i.test(value)
  const tiny = /\b(?:typo|rename|one line|single line|small text|comment only)\b/i.test(value)
  return action && surface && !tiny
}
