import { mkdir, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  createSnapshotWindowEvent,
  createSnapshotProbeEvent,
  parsePublisherMarker,
  safeWindowSummary,
  snapshotAttemptId,
  snapshotFailureClass,
  snapshotWindowIdentity,
  validateWindowOutcome,
} from './window-contract.mjs'
import { createD1WindowStore } from './window-d1.mjs'
import { validateProbeResult } from './active-probe.mjs'

const SUMMARY_ROOT = join('.transit-snapshot', 'window-results')

export async function runSnapshotWindow({
  city,
  env = process.env,
  now = () => new Date(),
  store,
  publisher,
  emitter = (event) => console.log(JSON.stringify(event)),
  summaryWriter = writeWindowSummary,
  activeReadRetryDelayMs = 250,
}) {
  const startedAt = now().toISOString()
  const workflowRunId = nullableString(env.GITHUB_RUN_ID)
  const workflowRunAttempt = positiveInteger(env.GITHUB_RUN_ATTEMPT ?? 1)
  const scriptGitSha = fullGitSha(env.GITHUB_SHA)
  const forcePublish = env.SNAPSHOT_FORCE === '1'
  let identity
  try {
    identity = workflowRunId ? await store.findWindowForWorkflowRun(city, workflowRunId) : null
  } catch {
    identity = null
  }
  identity ??= snapshotWindowIdentity({
    city,
    now: new Date(startedAt),
    windowType: env.SNAPSHOT_WINDOW_TYPE === 'manual' ? 'manual' : 'scheduled',
    windowDate: nullableString(env.SNAPSHOT_WINDOW_DATE) ?? undefined,
  })
  const attempt = {
    city,
    ...identity,
    attemptId: snapshotAttemptId({ city, workflowRunId, workflowRunAttempt, startedAt }),
    startedAt,
    workflowRunId,
    workflowRunAttempt,
    scriptGitSha,
    runKind: identity.runKind,
    forcePublish,
  }

  let startRecordWrite = 'success'
  try {
    await store.recordStart(attempt)
  } catch {
    startRecordWrite = 'failed'
    safeErrorLog('snapshot_window_start_write_failed', city, identity.windowId)
  }

  let publication
  try {
    publication = publisher
      ? await publisher()
      : await runPublisherProcess(city, { ...env, SNAPSHOT_WINDOW_ID: identity.windowId })
  } catch {
    publication = {
      exitCode: 1,
      lastPhase: 'source_fetch',
      lastSourceCheckAt: null,
      lastPublishedAt: null,
      probe: null,
      terminal: null,
    }
  }

  let active = { activeVersion: null, lastPublishedAt: null }
  let activeReadFailed = false
  try {
    active = await retryActiveRead(() => store.readActiveSnapshot(city), activeReadRetryDelayMs)
  } catch {
    activeReadFailed = true
    safeErrorLog('snapshot_window_active_pointer_read_failed', city, identity.windowId)
  }

  const observedProbe = publication.probe ?? null
  let probe = observedProbe
  let probeForTelemetry = observedProbe
  let rolledBackProbeFailureClass = null
  if (probe && (activeReadFailed || active.activeVersion !== probe.activeVersion)) {
    if (!activeReadFailed && probe.activeProbeResult === 'error') {
      // A published target can fail its active probe and then be rolled back by
      // publishWithRollback. Keep the failed target in telemetry, but do not
      // persist it as evidence about the restored D1 active version.
      rolledBackProbeFailureClass = probe.probeFailureClass
      probe = null
    } else {
      probe = validateProbeResult({
        ...probe,
        activeVersion: active.activeVersion,
        activeProbeResult: 'error',
        probeFailureClass: 'active_pointer_invalid',
        rollbackAvailable: false,
        diagnosticWarnings: [],
      })
      probeForTelemetry = probe
    }
  }
  const successfulTerminal = publication.exitCode === 0
    && (publication.terminal?.result === 'published' || publication.terminal?.result === 'unchanged')
    && probe !== null
    && probe.activeProbeResult !== 'error'
  const result = activeReadFailed ? 'failed'
    : successfulTerminal ? publication.terminal.result
      : 'failed'
  // Rollback success and rollback failure both end with exit 1 in the rollback
  // phase; only the re-read D1 pointer tells them apart. When the pointer still
  // names the rejected target, the rollback itself failed.
  const rollbackFailed = publication.lastPhase === 'rollback'
    && probe !== null
    && probe === observedProbe
    && probe.activeProbeResult === 'error'
  const failureClass = result !== 'failed' ? 'none'
    : rollbackFailed ? 'snapshot_rollback'
      : probe?.activeProbeResult === 'error' ? probe.probeFailureClass
        : rolledBackProbeFailureClass ?? (activeReadFailed
          ? 'snapshot_active_pointer_read'
          : snapshotFailureClass(publication.lastPhase))
  const completedAt = now().toISOString()
  const retainedPreviousActive = publication.previousVersion !== null
    && publication.previousVersion !== undefined
    && active.activeVersion === publication.previousVersion
  const lastPublishedAt = retainedPreviousActive
    ? publication.lastPublishedAt ?? active.lastPublishedAt
    : active.lastPublishedAt
  const outcome = validateWindowOutcome({
    ...attempt,
    completedAt,
    result,
    lastSourceCheckAt: publication.lastSourceCheckAt ?? publication.terminal?.lastSourceCheckAt ?? null,
    lastPublishedAt,
    activeVersion: active.activeVersion,
    previousVersion: probe?.previousVersion
      ?? publication.terminal?.previousVersion
      ?? publication.previousVersion
      ?? null,
    failureClass,
    probe,
  })

  let durableRecordWrite = 'success'
  try {
    await store.complete(outcome)
  } catch {
    durableRecordWrite = 'failed'
    safeErrorLog('snapshot_window_terminal_write_failed', city, identity.windowId)
    try {
      await store.recordWriteFailure?.({
        city,
        windowId: identity.windowId,
        attemptId: attempt.attemptId,
        recordedAt: completedAt,
      })
    } catch {
      safeErrorLog('snapshot_window_record_failure_marker_failed', city, identity.windowId)
    }
  }

  emitFailOpen(createSnapshotWindowEvent(outcome, scriptGitSha), emitter)
  if (probeForTelemetry) emitFailOpen(createSnapshotProbeEvent(probeForTelemetry, scriptGitSha), emitter)
  const summary = safeWindowSummary(outcome, durableRecordWrite)
  try {
    await summaryWriter(summary)
  } catch {
    safeErrorLog('snapshot_window_summary_write_failed', city, identity.windowId)
  }

  return Object.freeze({
    outcome,
    summary,
    startRecordWrite,
    durableRecordWrite,
    ok: result !== 'failed' && durableRecordWrite === 'success',
  })
}

export async function runPublisherProcess(city, env = process.env) {
  return await new Promise((resolve) => {
    let lastPhase = 'source_fetch'
    let lastSourceCheckAt = null
    let lastPublishedAt = null
    let previousVersion = null
    let terminal = null
    let probe = null
    let settled = false
    const child = spawn(process.execPath, ['scripts/sync-transit-snapshot-cached.mjs', city], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => {
      process.stdout.write(`${line}\n`)
      try {
        const marker = parsePublisherMarker(JSON.parse(line), city)
        if (!marker) return
        if (marker.event === 'snapshot_window_progress') {
          lastPhase = marker.phase
          lastSourceCheckAt = marker.lastSourceCheckAt ?? lastSourceCheckAt
          lastPublishedAt = marker.lastPublishedAt ?? lastPublishedAt
          previousVersion = marker.previousVersion ?? previousVersion
        } else if (marker.event === 'snapshot_window_terminal') {
          terminal = marker
          lastSourceCheckAt = marker.lastSourceCheckAt ?? lastSourceCheckAt
          lastPublishedAt = marker.lastPublishedAt ?? lastPublishedAt
          previousVersion = marker.previousVersion ?? previousVersion
        } else {
          probe = marker
        }
      } catch {
        // Publisher diagnostics are forwarded, but only strict markers affect durable state.
      }
    })
    child.stderr.on('data', (chunk) => process.stderr.write(chunk))
    child.on('error', () => finish(1))
    // `close` fires after stdout/stderr have closed, so the final terminal
    // marker cannot race the process exit notification.
    child.on('close', (code) => finish(code ?? 1))

    function finish(exitCode) {
      if (settled) return
      settled = true
      resolve({ exitCode, lastPhase, lastSourceCheckAt, lastPublishedAt, previousVersion, terminal, probe })
    }
  })
}

export function emitFailOpen(event, emitter) {
  try {
    emitter(event)
    return true
  } catch {
    return false
  }
}

export async function writeWindowSummary(summary, root = SUMMARY_ROOT) {
  await mkdir(root, { recursive: true })
  await writeFile(join(root, `${summary.city}.json`), JSON.stringify(summary))
}

async function retryActiveRead(read, delayMs) {
  let lastError
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await read()
    } catch (error) {
      lastError = error
      if (attempt < 3 && delayMs > 0) await new Promise((resolve) => setTimeout(resolve, attempt * delayMs))
    }
  }
  throw lastError
}

function unavailableStore() {
  const fail = async () => { throw new Error('Snapshot window store unavailable') }
  return { findWindowForWorkflowRun: fail, recordStart: fail, readActiveSnapshot: fail, complete: fail }
}

function storeFromEnvironment(env) {
  try {
    return createD1WindowStore({
      accountId: env.CLOUDFLARE_ACCOUNT_ID,
      apiToken: env.CLOUDFLARE_API_TOKEN,
      databaseId: env.TRANSIT_DATABASE_ID,
    })
  } catch {
    return unavailableStore()
  }
}

function nullableString(value) {
  return value === undefined || value === null || String(value).trim() === '' ? null : String(value).trim()
}

function positiveInteger(value) {
  const number = Number(value)
  return Number.isInteger(number) && number >= 1 ? number : 1
}

function fullGitSha(value) {
  const text = nullableString(value)
  return text && /^[a-f0-9]{40}$/.test(text) ? text : null
}

function safeErrorLog(message, city, windowId) {
  console.error(JSON.stringify({ message, city, windowId }))
}

async function main() {
  const city = process.argv[2]
  const result = await runSnapshotWindow({ city, store: storeFromEnvironment(process.env) })
  process.exitCode = result.ok ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
