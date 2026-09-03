import http from 'node:http'
import { runCodingTask } from './orchestrator.mjs'
import { loadCheckpoint } from './reliability.mjs'

const host = process.env.ULTRON_CODING_BRAIN_HOST || '127.0.0.1'
const port = Number(process.env.ULTRON_CODING_BRAIN_PORT || 8791)
let active = null

function send(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 1_000_000) reject(new Error('Request too large.'))
    })
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')) } catch { reject(new Error('Invalid JSON request.')) }
    })
    req.on('error', reject)
  })
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return send(res, 204, {})
    if (req.method === 'GET' && req.url === '/health') {
      return send(res, 200, {
        ok: true,
        service: 'ULTRON Coding Brain',
        version: '0.2.0',
        architecture: 'investigate-or-council -> planner -> editor -> validation evidence -> reviewer',
        active: Boolean(active),
        activeTask: active ? { startedAt: active.startedAt, mode: active.mode, workspace: active.workspace } : null,
        mark3Url: process.env.ULTRON_MARK3_URL || 'http://127.0.0.1:8790',
      })
    }
    if (req.method === 'GET' && req.url === '/status') {
      return send(res, 200, { ok: true, active })
    }
    if (req.method === 'POST' && req.url === '/checkpoint') {
      const data = await readBody(req)
      const workspace = String(data.workspace || '').trim()
      if (!workspace) return send(res, 400, { ok: false, error: 'workspace is required.' })
      return send(res, 200, { ok: true, checkpoint: loadCheckpoint(workspace) })
    }
    if (req.method === 'POST' && req.url === '/run') {
      if (active) return send(res, 409, { ok: false, error: 'Coding Brain is already working on another repository task.', active })
      const data = await readBody(req)
      const task = String(data.task || '').trim()
      const workspace = String(data.workspace || '').trim()
      const mode = ['inspect', 'plan', 'apply'].includes(String(data.mode || '').toLowerCase()) ? String(data.mode).toLowerCase() : 'apply'
      if (!task) return send(res, 400, { ok: false, error: 'task is required.' })
      if (!workspace) return send(res, 400, { ok: false, error: 'workspace is required.' })
      active = { task: task.slice(0, 500), workspace, mode, startedAt: new Date().toISOString() }
      try {
        const result = await runCodingTask({ task, workspace, mode, mark3Url: String(data.mark3Url || process.env.ULTRON_MARK3_URL || 'http://127.0.0.1:8790') })
        return send(res, result.ok ? 200 : 422, result)
      } finally { active = null }
    }
    return send(res, 404, { ok: false, error: 'Not found.' })
  } catch (error) {
    active = null
    return send(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
  }
})

server.listen(port, host, () => {
  console.log(`ULTRON Coding Brain listening at http://${host}:${port}`)
  console.log('[Coding Brain] investigate/council -> planner -> editor -> evidence -> reviewer -> checkpoint')
})
