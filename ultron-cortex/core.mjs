import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const IGNORE_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'coverage', '.cache', '.turbo', '.ultron', 'vendor'])
const CODE_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.ts', '.tsx', '.jsx', '.json', '.css', '.scss', '.html', '.md', '.py', '.go', '.rs', '.java', '.kt', '.kts', '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.php', '.rb', '.sh', '.ps1', '.sql', '.toml', '.yaml', '.yml'])
const SPECIAL_FILES = new Set(['package.json', 'tsconfig.json', 'vite.config.js', 'vite.config.ts', 'next.config.js', 'next.config.mjs', 'README.md', 'Cargo.toml', 'pyproject.toml', 'requirements.txt'])
const MAX_FILE_BYTES = 256 * 1024
const MAX_CONTEXT_CHARS = 90_000
const MAX_CONTEXT_FILES = 16

function tokens(text) {
  return new Set(String(text || '').toLowerCase().split(/[^a-z0-9_./-]+/).filter((value) => value.length >= 2))
}

function inside(root, candidate) {
  const rel = path.relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function blockedRelative(rel) {
  const parts = String(rel || '').split(/[\\/]+/).filter(Boolean)
  return parts.some((part) => IGNORE_DIRS.has(part))
}

export function resolveWorkspace(raw) {
  const root = path.resolve(String(raw || process.cwd()))
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`Coding workspace does not exist: ${root}`)
  return root
}

export function discoverWorkspace(rawWorkspace, { maxFiles = 2500 } = {}) {
  const root = resolveWorkspace(rawWorkspace)
  const files = []
  const queue = ['']
  while (queue.length && files.length < maxFiles) {
    const relDir = queue.shift()
    const absDir = path.join(root, relDir)
    let entries = []
    try { entries = fs.readdirSync(absDir, { withFileTypes: true }) } catch { continue }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (entry.name.startsWith('.') && !['.env.example', '.github'].includes(entry.name)) continue
      const rel = path.join(relDir, entry.name)
      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(entry.name)) queue.push(rel)
        continue
      }
      if (!entry.isFile()) continue
      const ext = path.extname(entry.name).toLowerCase()
      if (!CODE_EXTENSIONS.has(ext) && !SPECIAL_FILES.has(entry.name) && entry.name !== '.env.example') continue
      let stat
      try { stat = fs.statSync(path.join(root, rel)) } catch { continue }
      if (stat.size > MAX_FILE_BYTES) continue
      files.push(rel.replaceAll('\\', '/'))
      if (files.length >= maxFiles) break
    }
  }
  return { root, files, truncated: files.length >= maxFiles }
}

export function rankFiles(task, files, limit = MAX_CONTEXT_FILES) {
  const wanted = tokens(task)
  return [...files]
    .map((file) => {
      const fileTokens = tokens(file.replace(/[._/-]+/g, ' '))
      let score = 0
      for (const token of wanted) if (fileTokens.has(token)) score += token.length >= 5 ? 3 : 1
      if (/package\.json$|tsconfig\.json$|README\.md$/i.test(file)) score += 0.5
      if (/test|spec/i.test(task) && /test|spec/i.test(file)) score += 3
      if (/interface|ui|frontend|css|style/i.test(task) && /interface|app|src|css|style|component/i.test(file)) score += 2
      if (/server|api|backend/i.test(task) && /server|api|route|core/i.test(file)) score += 2
      return { file, score }
    })
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
    .slice(0, limit)
    .map((entry) => entry.file)
}

function readText(root, rel, maxChars = 18_000) {
  const abs = path.resolve(root, rel)
  if (!inside(root, abs) || blockedRelative(rel)) throw new Error(`Unsafe file path: ${rel}`)
  const text = fs.readFileSync(abs, 'utf8')
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n/* ...truncated by ULTRON Coding Brain... */` : text
}

export function buildContext(root, candidates) {
  const chunks = []
  let used = 0
  for (const rel of candidates.slice(0, MAX_CONTEXT_FILES)) {
    let text
    try { text = readText(root, rel) } catch { continue }
    const chunk = `\n--- FILE: ${rel} ---\n${text}\n--- END FILE ---\n`
    if (used + chunk.length > MAX_CONTEXT_CHARS) break
    chunks.push(chunk)
    used += chunk.length
  }
  return chunks.join('')
}

function extractJson(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('Coding model did not return a JSON object.')
  try { return JSON.parse(raw.slice(start, end + 1)) } catch (error) { throw new Error(`Coding model returned invalid JSON: ${error.message}`) }
}

async function postJson(url, payload, timeoutMs = 120_000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    const text = await response.text()
    let data
    try { data = JSON.parse(text) } catch { data = { error: text } }
    if (!response.ok) throw new Error(data?.error || `Mark 3 inference returned HTTP ${response.status}`)
    return data
  } finally { clearTimeout(timer) }
}

async function infer(mark3Url, role, messages) {
  const base = String(mark3Url || 'http://127.0.0.1:8790').replace(/\/$/, '')
  const result = await postJson(`${base}/api/coding/infer`, { role, messages }, 150_000)
  if (!result?.text) throw new Error(`Mark 3 returned no ${role} text.`)
  return { text: result.text, model: result.model, provider: result.provider }
}

function plannedFiles(plan, available, fallback) {
  const exact = new Set(available)
  const requested = Array.isArray(plan?.files) ? plan.files.map((item) => String(item || '').replaceAll('\\', '/')) : []
  const valid = requested.filter((item) => exact.has(item))
  return [...new Set([...valid, ...fallback])].slice(0, MAX_CONTEXT_FILES)
}

export async function createPlan({ task, workspace, mark3Url }) {
  const discovered = discoverWorkspace(workspace)
  const initial = rankFiles(task, discovered.files)
  const context = buildContext(discovered.root, initial)
  const response = await infer(mark3Url, 'planner', [
    { role: 'system', content: 'You are ULTRON Coding Brain Planner. Produce a minimal implementation plan. Inspect the supplied repository context only. Return JSON only with keys: summary (string), files (array of repository-relative file paths), steps (array of short strings), validation (array of existing project checks you expect should run). Never invent file paths when an existing one is sufficient.' },
    { role: 'user', content: `TASK:\n${task}\n\nREPOSITORY FILE LIST:\n${discovered.files.slice(0, 1200).join('\n')}\n\nLIKELY RELEVANT FILE CONTENT:\n${context}` },
  ])
  const plan = extractJson(response.text)
  const files = plannedFiles(plan, discovered.files, initial)
  return { discovered, plan, files, planner: { model: response.model, provider: response.provider } }
}

function normalizeChanges(payload) {
  const changes = Array.isArray(payload?.changes) ? payload.changes : []
  return changes.slice(0, 12).map((change) => ({
    path: String(change?.path || '').replaceAll('\\', '/'),
    type: change?.type === 'write' ? 'write' : 'replace',
    content: typeof change?.content === 'string' ? change.content : undefined,
    replacements: Array.isArray(change?.replacements) ? change.replacements.slice(0, 30).map((r) => ({ oldString: String(r?.oldString ?? ''), newString: String(r?.newString ?? '') })) : [],
  })).filter((change) => change.path)
}

export function applyChanges(rawWorkspace, rawChanges) {
  const root = resolveWorkspace(rawWorkspace)
  const changes = normalizeChanges({ changes: rawChanges })
  if (!changes.length) return { changedFiles: [], backups: new Map() }
  const backups = new Map()
  const changedFiles = []
  try {
    for (const change of changes) {
      if (blockedRelative(change.path)) throw new Error(`Refusing to edit protected path: ${change.path}`)
      const abs = path.resolve(root, change.path)
      if (!inside(root, abs)) throw new Error(`Refusing to edit outside workspace: ${change.path}`)
      const existed = fs.existsSync(abs)
      const before = existed ? fs.readFileSync(abs, 'utf8') : null
      backups.set(abs, before)
      let after = before ?? ''
      if (change.type === 'write') {
        if (typeof change.content !== 'string') throw new Error(`Missing content for ${change.path}`)
        after = change.content
      } else {
        if (!existed) throw new Error(`Cannot replace content in missing file: ${change.path}`)
        for (const replacement of change.replacements) {
          if (!replacement.oldString) throw new Error(`Empty oldString for ${change.path}`)
          const first = after.indexOf(replacement.oldString)
          if (first < 0) throw new Error(`Replacement target not found in ${change.path}`)
          if (after.indexOf(replacement.oldString, first + replacement.oldString.length) >= 0) throw new Error(`Replacement target is ambiguous in ${change.path}`)
          after = after.slice(0, first) + replacement.newString + after.slice(first + replacement.oldString.length)
        }
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, after, 'utf8')
      changedFiles.push(change.path)
    }
    return { changedFiles: [...new Set(changedFiles)], backups }
  } catch (error) {
    for (const [abs, before] of backups.entries()) {
      try {
        if (before === null) fs.rmSync(abs, { force: true })
        else fs.writeFileSync(abs, before, 'utf8')
      } catch {}
    }
    throw error
  }
}

function executable(name) {
  if (process.platform !== 'win32') return name
  if (['npm', 'pnpm', 'yarn'].includes(name)) return `${name}.cmd`
  return name
}

function runCommand(command, args, cwd, timeoutMs = 120_000) {
  return new Promise((resolve) => {
    const started = Date.now()
    let stdout = ''
    let stderr = ''
    let child
    try { child = spawn(executable(command), args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }) }
    catch (error) { return resolve({ command: [command, ...args].join(' '), ok: false, skipped: true, error: error.message, durationMs: Date.now() - started }) }
    const timer = setTimeout(() => { try { child.kill() } catch {} }, timeoutMs)
    child.stdout.on('data', (data) => { if (stdout.length < 16_000) stdout += data.toString() })
    child.stderr.on('data', (data) => { if (stderr.length < 16_000) stderr += data.toString() })
    child.on('error', (error) => { clearTimeout(timer); resolve({ command: [command, ...args].join(' '), ok: false, skipped: error.code === 'ENOENT', error: error.message, stdout, stderr, durationMs: Date.now() - started }) })
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ command: [command, ...args].join(' '), ok: code === 0, code, signal, stdout: stdout.slice(-8000), stderr: stderr.slice(-8000), durationMs: Date.now() - started }) })
  })
}

export async function validateWorkspace(rawWorkspace) {
  const root = resolveWorkspace(rawWorkspace)
  const packagePath = path.join(root, 'package.json')
  if (!fs.existsSync(packagePath)) return { passed: true, status: 'not-run', checks: [], reason: 'No package.json validation scripts found.' }
  let pkg
  try { pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8')) } catch { return { passed: true, status: 'not-run', checks: [], reason: 'package.json is not readable JSON.' } }
  const scripts = pkg.scripts || {}
  const names = ['typecheck', 'test', 'lint'].filter((name) => typeof scripts[name] === 'string').slice(0, 2)
  if (!names.length) return { passed: true, status: 'not-run', checks: [], reason: 'No typecheck/test/lint script exists.' }
  const manager = fs.existsSync(path.join(root, 'bun.lock')) || fs.existsSync(path.join(root, 'bun.lockb')) ? 'bun'
    : fs.existsSync(path.join(root, 'pnpm-lock.yaml')) ? 'pnpm'
      : fs.existsSync(path.join(root, 'yarn.lock')) ? 'yarn' : 'npm'
  const checks = []
  for (const name of names) {
    const args = manager === 'yarn' ? [name] : ['run', name]
    checks.push(await runCommand(manager, args, root))
  }
  const attempted = checks.filter((item) => !item.skipped)
  return { passed: attempted.every((item) => item.ok), status: attempted.length ? 'completed' : 'not-run', checks }
}

async function editWithModel({ task, root, plan, files, mark3Url, reviewIssues = null }) {
  const context = buildContext(root, files)
  const response = await infer(mark3Url, 'editor', [
    { role: 'system', content: 'You are ULTRON Coding Brain Editor. Return JSON only. Make the smallest safe code changes that complete the task. Use existing project conventions. Schema: {"summary":"...","changes":[{"path":"relative/path","type":"replace","replacements":[{"oldString":"exact existing text","newString":"replacement"}]} OR {"path":"relative/path","type":"write","content":"complete file"}]}. Never use placeholders, ellipses, markdown fences, shell commands, or paths outside the repository. For replacements, oldString must be exact and uniquely identifying.' },
    { role: 'user', content: `TASK:\n${task}\n\nPLAN:\n${JSON.stringify(plan)}${reviewIssues ? `\n\nREVIEW ISSUES TO REPAIR:\n${JSON.stringify(reviewIssues)}` : ''}\n\nCURRENT FILE CONTENT:\n${context}` },
  ])
  return { payload: extractJson(response.text), model: response.model, provider: response.provider }
}

async function reviewWithModel({ task, root, plan, changedFiles, validation, mark3Url }) {
  const context = buildContext(root, changedFiles)
  const response = await infer(mark3Url, 'reviewer', [
    { role: 'system', content: 'You are ULTRON Coding Brain Reviewer. Review the implementation independently. Return JSON only with schema: {"verdict":"pass"|"needs_changes","summary":"...","issues":[{"severity":"high"|"medium"|"low","path":"relative/path","message":"specific issue"}]}. Judge correctness, regressions, task completion, maintainability, and validation evidence. Do not invent failures.' },
    { role: 'user', content: `TASK:\n${task}\n\nPLAN:\n${JSON.stringify(plan)}\n\nVALIDATION:\n${JSON.stringify(validation).slice(0, 18000)}\n\nCHANGED FILES:\n${context}` },
  ])
  return { review: extractJson(response.text), model: response.model, provider: response.provider }
}

export async function runCodingTask({ task, workspace, mode = 'apply', mark3Url = process.env.ULTRON_MARK3_URL || 'http://127.0.0.1:8790' }) {
  const prompt = String(task || '').trim()
  if (!prompt) throw new Error('Coding task is required.')
  const root = resolveWorkspace(workspace)
  const trace = []
  const planned = await createPlan({ task: prompt, workspace: root, mark3Url })
  trace.push({ stage: 'discover', files: planned.discovered.files.length, selected: planned.files })
  trace.push({ stage: 'plan', model: planned.planner.model, summary: planned.plan?.summary || '' })
  if (mode === 'inspect' || mode === 'plan') {
    return { ok: true, mode, workspace: root, plan: planned.plan, selectedFiles: planned.files, trace }
  }

  const editor = await editWithModel({ task: prompt, root, plan: planned.plan, files: planned.files, mark3Url })
  const changes = normalizeChanges(editor.payload)
  if (!changes.length) throw new Error('Coding editor proposed no file changes.')
  const applied = applyChanges(root, changes)
  trace.push({ stage: 'edit', model: editor.model, changedFiles: applied.changedFiles, summary: editor.payload?.summary || '' })

  let validation = await validateWorkspace(root)
  trace.push({ stage: 'validate', passed: validation.passed, status: validation.status })
  let reviewed = await reviewWithModel({ task: prompt, root, plan: planned.plan, changedFiles: applied.changedFiles, validation, mark3Url })
  trace.push({ stage: 'review', model: reviewed.model, verdict: reviewed.review?.verdict || 'unknown', summary: reviewed.review?.summary || '' })

  let repaired = false
  if (reviewed.review?.verdict === 'needs_changes' && Array.isArray(reviewed.review?.issues) && reviewed.review.issues.length) {
    const repairFiles = [...new Set([...applied.changedFiles, ...planned.files])].slice(0, MAX_CONTEXT_FILES)
    const repair = await editWithModel({ task: prompt, root, plan: planned.plan, files: repairFiles, mark3Url, reviewIssues: reviewed.review.issues })
    const repairChanges = normalizeChanges(repair.payload)
    if (repairChanges.length) {
      const repairedApply = applyChanges(root, repairChanges)
      for (const file of repairedApply.changedFiles) if (!applied.changedFiles.includes(file)) applied.changedFiles.push(file)
      repaired = true
      trace.push({ stage: 'repair', model: repair.model, changedFiles: repairedApply.changedFiles, summary: repair.payload?.summary || '' })
      validation = await validateWorkspace(root)
      trace.push({ stage: 'revalidate', passed: validation.passed, status: validation.status })
      reviewed = await reviewWithModel({ task: prompt, root, plan: planned.plan, changedFiles: applied.changedFiles, validation, mark3Url })
      trace.push({ stage: 'final-review', model: reviewed.model, verdict: reviewed.review?.verdict || 'unknown', summary: reviewed.review?.summary || '' })
    }
  }

  return {
    ok: validation.passed && reviewed.review?.verdict !== 'needs_changes',
    mode: 'apply',
    workspace: root,
    summary: editor.payload?.summary || planned.plan?.summary || 'Coding task completed.',
    plan: planned.plan,
    selectedFiles: planned.files,
    changedFiles: applied.changedFiles,
    validation,
    review: reviewed.review,
    repaired,
    models: { planner: planned.planner, editor: { model: editor.model, provider: editor.provider }, reviewer: { model: reviewed.model, provider: reviewed.provider } },
    trace,
  }
}

export function createSelfTestWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ultron-cortex-'))
}
