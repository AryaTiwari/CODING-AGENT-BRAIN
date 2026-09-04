import { buildContext, discoverWorkspace, rankFiles, runCodingTask as runBaseCodingTask, validateWorkspace } from './core.mjs'
import {
  evidenceFresh,
  isBugTask,
  isComplexFeatureTask,
  isContinuationTask,
  loadCheckpoint,
  recordEvidence,
  saveCheckpoint,
  workingTreeFingerprint,
} from './reliability.mjs'

export function extractJson(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  try {
    const direct = JSON.parse(raw)
    if (direct && typeof direct === 'object' && !Array.isArray(direct)) return direct
  } catch {}

  for (let start = 0; start < raw.length; start += 1) {
    if (raw[start] !== '{') continue
    let depth = 0
    let inString = false
    let escaped = false
    for (let end = start; end < raw.length; end += 1) {
      const ch = raw[end]
      if (inString) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') { inString = true; continue }
      if (ch === '{') depth += 1
      else if (ch === '}') depth -= 1
      if (depth === 0) {
        try {
          const parsed = JSON.parse(raw.slice(start, end + 1))
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
        } catch {}
        break
      }
    }
  }
  throw new Error('Specialist did not return a JSON object.')
}

function recoverInvestigation(text, error) {
  const raw = String(text || '').trim()
  return {
    rootCause: 'Pre-edit investigator returned an unstructured response; no root cause is treated as proven.',
    confidence: 0,
    evidence: raw ? [`Unstructured investigator output: ${raw.slice(0, 2500)}`] : [],
    files: [],
    hypotheses: [],
    fixStrategy: 'Proceed with repository-grounded planning and editing. Treat this preflight formatting failure as non-fatal.',
    avoid: ['Do not treat the unstructured investigator response as verified evidence.'],
    specialistFormatRecovered: true,
    specialistFormatError: String(error?.message || error || 'unknown formatting error'),
  }
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
    if (!response.ok) throw new Error(data?.error || `Mark 3 specialist inference returned HTTP ${response.status}`)
    return data
  } finally { clearTimeout(timer) }
}

async function infer(mark3Url, role, messages, timeoutMs = 120_000) {
  const base = String(mark3Url || 'http://127.0.0.1:8790').replace(/\/$/, '')
  const result = await postJson(`${base}/api/coding/infer`, { role, messages }, timeoutMs)
  if (!result?.text) throw new Error(`Mark 3 returned no ${role} text.`)
  return { text: result.text, model: result.model, provider: result.provider }
}

function repoSnapshot(task, workspace, limit = 14) {
  const discovered = discoverWorkspace(workspace)
  const files = rankFiles(task, discovered.files, limit)
  const context = buildContext(discovered.root, files)
  return { discovered, files, context }
}

async function investigate({ task, workspace, mark3Url }) {
  const snapshot = repoSnapshot(task, workspace, 16)
  const baseline = await validateWorkspace(snapshot.discovered.root)
  const response = await infer(mark3Url, 'investigator', [
    {
      role: 'system',
      content: 'You are ULTRON Coding Brain Investigator. Diagnose before editing. Use only supplied repository evidence and baseline validation. Return JSON only: {"rootCause":"most likely root cause or clearly state unknown","confidence":0.0,"evidence":["specific observations"],"files":["relative paths"],"hypotheses":["ranked alternatives"],"fixStrategy":"smallest evidence-based fix","avoid":["guessy or unrelated changes"]}. Never pretend a hypothesis is proven when evidence is incomplete.',
    },
    {
      role: 'user',
      content: `BUG TASK:\n${task}\n\nBASELINE VALIDATION:\n${JSON.stringify(baseline).slice(0, 16000)}\n\nREPOSITORY FILE LIST:\n${snapshot.discovered.files.slice(0, 1200).join('\n')}\n\nLIKELY RELEVANT CONTENT:\n${snapshot.context}`,
    },
  ], 140_000)
  let parsed
  try { parsed = extractJson(response.text) }
  catch (error) { parsed = recoverInvestigation(response.text, error) }
  return {
    ...parsed,
    baseline,
    model: response.model,
    provider: response.provider,
  }
}

async function planningCouncil({ task, workspace, mark3Url }) {
  const snapshot = repoSnapshot(task, workspace, 14)
  const shared = `FEATURE TASK:\n${task}\n\nREPOSITORY FILE LIST:\n${snapshot.discovered.files.slice(0, 1200).join('\n')}\n\nLIKELY RELEVANT CONTENT:\n${snapshot.context}`
  const jobs = [
    infer(mark3Url, 'scope-planner', [
      { role: 'system', content: 'You are ULTRON Product/Scope Planner. Prevent over-building. Return JSON only: {"goal":"","mustHave":[""],"outOfScope":[""],"risks":[""],"acceptanceCriteria":[""]}. Keep the requested product intent intact while choosing the smallest complete implementation.' },
      { role: 'user', content: shared },
    ], 120_000),
    infer(mark3Url, 'architect', [
      { role: 'system', content: 'You are ULTRON Software Architect. Return JSON only: {"approach":"","dataFlow":[""],"files":["relative paths"],"edgeCases":[""],"validation":[""]}. Prefer existing architecture and minimal new abstractions. Identify failure paths before code is written.' },
      { role: 'user', content: shared },
    ], 120_000),
  ]

  const settled = await Promise.allSettled(jobs)
  const names = ['scope', 'architecture']
  const council = {}
  settled.forEach((result, index) => {
    const name = names[index]
    if (result.status === 'fulfilled') {
      try {
        council[name] = { ...extractJson(result.value.text), model: result.value.model, provider: result.value.provider }
      } catch (error) {
        council[name] = { error: error.message, raw: String(result.value.text || '').slice(0, 2500), nonFatal: true }
      }
    } else {
      council[name] = { error: result.reason instanceof Error ? result.reason.message : String(result.reason), nonFatal: true }
    }
  })
  return council
}

function compactCheckpointResult(result) {
  return {
    ok: Boolean(result?.ok),
    summary: String(result?.summary || result?.response || '').slice(0, 2000),
    changedFiles: Array.isArray(result?.changedFiles) ? result.changedFiles.slice(0, 50) : [],
    plan: result?.plan || null,
    review: result?.review ? {
      verdict: result.review.verdict || null,
      summary: String(result.review.summary || '').slice(0, 1200),
      issues: Array.isArray(result.review.issues) ? result.review.issues.slice(0, 20) : [],
    } : null,
  }
}

function specialistContext(investigation, council) {
  const chunks = []
  if (investigation) {
    chunks.push(`PRE-EDIT ROOT-CAUSE INVESTIGATION (treat as evidence-guided specialist context, not a substitute for inspecting current files):\n${JSON.stringify({
      rootCause: investigation.rootCause,
      confidence: investigation.confidence,
      evidence: investigation.evidence,
      files: investigation.files,
      hypotheses: investigation.hypotheses,
      fixStrategy: investigation.fixStrategy,
      avoid: investigation.avoid,
      specialistFormatRecovered: investigation.specialistFormatRecovered || false,
    }).slice(0, 12000)}`)
  }
  if (council) {
    chunks.push(`PRE-EDIT PLANNING COUNCIL (reconcile this with current source; do not expand beyond the user's request):\n${JSON.stringify(council).slice(0, 16000)}`)
  }
  return chunks.join('\n\n')
}

export async function runCodingTask({ task, workspace, mode = 'apply', mark3Url = process.env.ULTRON_MARK3_URL || 'http://127.0.0.1:8790' }) {
  const incoming = String(task || '').trim()
  if (!incoming) throw new Error('Coding task is required.')

  const prior = loadCheckpoint(workspace)
  const resumed = isContinuationTask(incoming) && prior && ['in-progress', 'failed', 'needs-attention'].includes(String(prior.status || ''))
  const effectiveTask = resumed ? String(prior.task || incoming) : incoming
  const fingerprintBefore = workingTreeFingerprint(workspace)

  saveCheckpoint(workspace, {
    status: 'in-progress',
    stage: 'specialist-preflight',
    task: effectiveTask,
    resumedFromCheckpoint: resumed,
    fingerprintBefore,
  })

  let investigation = null
  let council = null
  try {
    if (isBugTask(effectiveTask)) {
      investigation = await investigate({ task: effectiveTask, workspace, mark3Url })
      saveCheckpoint(workspace, {
        status: 'in-progress',
        stage: 'investigated',
        task: effectiveTask,
        resumedFromCheckpoint: resumed,
        fingerprintBefore,
        investigation: {
          rootCause: investigation.rootCause,
          confidence: investigation.confidence,
          evidence: investigation.evidence,
          files: investigation.files,
          fixStrategy: investigation.fixStrategy,
          specialistFormatRecovered: investigation.specialistFormatRecovered || false,
        },
      })
    } else if (isComplexFeatureTask(effectiveTask)) {
      council = await planningCouncil({ task: effectiveTask, workspace, mark3Url })
      saveCheckpoint(workspace, {
        status: 'in-progress',
        stage: 'planning-council',
        task: effectiveTask,
        resumedFromCheckpoint: resumed,
        fingerprintBefore,
        council,
      })
    }

    const context = specialistContext(investigation, council)
    const augmentedTask = context ? `${effectiveTask}\n\n${context}` : effectiveTask
    saveCheckpoint(workspace, {
      status: 'in-progress',
      stage: mode === 'apply' ? 'implementation' : 'read-only-plan',
      task: effectiveTask,
      resumedFromCheckpoint: resumed,
      fingerprintBefore,
      investigation: investigation ? { rootCause: investigation.rootCause, confidence: investigation.confidence, fixStrategy: investigation.fixStrategy } : null,
      council,
    })

    const result = await runBaseCodingTask({ task: augmentedTask, workspace, mode, mark3Url })

    if (mode === 'inspect' || mode === 'plan') {
      const checkpoint = saveCheckpoint(workspace, {
        status: 'completed',
        stage: 'read-only-complete',
        task: effectiveTask,
        resumedFromCheckpoint: resumed,
        fingerprintBefore,
        result: compactCheckpointResult(result),
      })
      return {
        ...result,
        originalTask: effectiveTask,
        resumedFromCheckpoint: resumed,
        investigation,
        planningCouncil: council,
        reliability: {
          fingerprintBefore,
          fingerprintAfter: workingTreeFingerprint(workspace),
          checkpoint: { status: checkpoint.status, stage: checkpoint.stage, updatedAt: checkpoint.updatedAt },
        },
      }
    }

    const fingerprintAfter = workingTreeFingerprint(workspace)
    const evidence = recordEvidence(workspace, 'final-validation', result.validation, { fingerprint: fingerprintAfter })
    const freshness = evidenceFresh(workspace, evidence)
    const verificationLevel = evidence.verified && freshness.fresh ? 'verified-current-tree'
      : result?.review?.verdict === 'pass' ? 'reviewed-no-executable-proof'
        : 'unverified'

    const finalOk = Boolean(result.ok) && freshness.fresh
    const checkpoint = saveCheckpoint(workspace, {
      status: finalOk ? 'completed' : 'needs-attention',
      stage: 'complete',
      task: effectiveTask,
      resumedFromCheckpoint: resumed,
      fingerprintBefore,
      fingerprintAfter,
      verificationLevel,
      evidence: {
        ts: evidence.ts,
        fingerprint: evidence.fingerprint,
        verified: evidence.verified,
        validationStatus: evidence.validationStatus,
        checks: evidence.checks,
      },
      result: compactCheckpointResult(result),
    })

    return {
      ...result,
      ok: finalOk,
      originalTask: effectiveTask,
      resumedFromCheckpoint: resumed,
      investigation,
      planningCouncil: council,
      reliability: {
        fingerprintBefore,
        fingerprintAfter,
        evidence,
        evidenceFresh: freshness.fresh,
        verificationLevel,
        checkpoint: { status: checkpoint.status, stage: checkpoint.stage, updatedAt: checkpoint.updatedAt },
      },
    }
  } catch (error) {
    try {
      saveCheckpoint(workspace, {
        status: 'failed',
        stage: 'interrupted',
        task: effectiveTask,
        resumedFromCheckpoint: resumed,
        fingerprintBefore,
        fingerprintAfter: workingTreeFingerprint(workspace),
        error: String(error instanceof Error ? error.message : error).slice(0, 2000),
        investigation: investigation ? { rootCause: investigation.rootCause, confidence: investigation.confidence, fixStrategy: investigation.fixStrategy } : null,
        council,
      })
    } catch {}
    throw error
  }
}
