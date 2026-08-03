import { appendFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { loadOperationsPlan } from '../instance/operations-plan.mjs'
import { latestClosedSnapshotScheduleDate, scheduledCitiesForTaipeiDate, scheduledSnapshotWindow } from './snapshot-schedule.mjs'
import {
  createWindowWatchdogEvent,
  evaluateWindowWatchdog,
  watchdogFailureResult,
  withWatchdogLatency,
} from './watchdog-contract.mjs'
import { createD1WatchdogStore, watchdogRunId } from './watchdog-d1.mjs'

const HEALTHY_STATUSES = new Set(['published', 'unchanged_healthy'])

export async function runWindowWatchdog({
  env = process.env,
  now = () => new Date(),
  monotonic = () => performance.now(),
  store,
  emitter = (event) => console.log(JSON.stringify(event)),
  summaryWriter = writeWatchdogSummary,
}) {
  const evaluatedAt = now().toISOString()
  const scheduleDate = latestClosedSnapshotScheduleDate(new Date(evaluatedAt))
  const cities = [...scheduledCitiesForTaipeiDate(scheduleDate)]
  const runId = watchdogRunId({
    workflowRunId: nullableString(env.GITHUB_RUN_ID),
    workflowRunAttempt: env.GITHUB_RUN_ATTEMPT ?? 1,
    evaluatedAt,
  })
  let infrastructureFailed = false
  try {
    await store.startRun({ watchdogRunId: runId, evaluatedAt, scheduleDate })
  } catch {
    infrastructureFailed = true
    safeLog('watchdog_run_start_write_failed', null, runId)
  }

  const results = []
  for (const city of cities) {
    const started = monotonic()
    const expected = scheduledSnapshotWindow(city, scheduleDate)
    let result
    try {
      const evidence = await store.readEvidence(city, expected.windowId)
      result = evaluateWindowWatchdog({ city, scheduleDate, evaluatedAt, ...evidence })
    } catch {
      result = watchdogFailureResult({ city, scheduleDate, evaluatedAt, diagnosticClass: 'watchdog_query_failed' })
    }
    result = withWatchdogLatency(result, monotonic() - started)
    try {
      await store.completeCity(runId, result)
    } catch {
      infrastructureFailed = true
      result = withWatchdogLatency(watchdogFailureResult({
        city, scheduleDate, evaluatedAt, diagnosticClass: 'record_write_failed',
      }), monotonic() - started)
      safeLog('watchdog_city_write_failed', city, runId)
    }
    emitFailOpen(createWindowWatchdogEvent(result, fullGitSha(env.GITHUB_SHA)), emitter)
    results.push(result)
  }

  const failed = results.filter((result) => !HEALTHY_STATUSES.has(result.status))
  const completedAt = now().toISOString()
  try {
    await store.completeRun({
      watchdogRunId: runId,
      evaluatedAt,
      completedAt,
      result: failed.length || infrastructureFailed ? 'failed' : 'success',
      failureCount: Math.max(failed.length, infrastructureFailed ? 1 : 0),
    })
  } catch {
    infrastructureFailed = true
    safeLog('watchdog_run_complete_write_failed', null, runId)
  }

  const summary = Object.freeze({
    watchdogSchemaVersion: 1,
    watchdogRunId: runId,
    evaluatedAt,
    scheduleDate,
    results: Object.freeze([...results]),
  })
  try {
    await summaryWriter(summary)
  } catch {
    infrastructureFailed = true
    safeLog('watchdog_summary_write_failed', null, runId)
  }
  return Object.freeze({
    summary,
    ok: !infrastructureFailed && failed.length === 0,
    failedCities: Object.freeze(failed.map((result) => result.city)),
  })
}

export function watchdogSummaryMarkdown(summary) {
  const groups = [
    ['Healthy published', 'published'],
    ['Published rollback degraded', 'published_rollback_degraded'],
    ['Healthy unchanged', 'unchanged_healthy'],
    ['Unchanged rollback degraded', 'unchanged_rollback_degraded'],
    ['Window failed but active healthy', 'failed_active_healthy'],
    ['Active unhealthy', 'failed_active_unhealthy'],
    ['Missing window', 'missing'],
    ['Record write failed', 'record_write_failed'],
    ['Unknown', 'unknown'],
  ]
  return [
    '## Snapshot window watchdog',
    '',
    `- Schedule date: ${summary.scheduleDate} (Asia/Taipei)`,
    `- Evaluated at: ${summary.evaluatedAt}`,
    '',
    '| City | Expected window | Status | Active | Source age | Probe age | Rollback | Diagnostic |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...summary.results.map((item) => `| ${item.city} | ${item.windowId} | ${item.status} | ${item.activeVersion ?? 'none'} | ${item.sourceCheckAgeBucket} | ${item.signalAgeBucket} | ${item.rollbackAvailable === null ? 'unknown' : item.rollbackAvailable ? 'available' : 'degraded'} | ${item.diagnosticClass} |`),
    '',
    ...groups.map(([label, status]) => `- ${label}: ${summary.results.filter((item) => item.status === status).map((item) => item.city).join(', ') || 'none'}`),
    '',
  ].join('\n')
}

export function emitFailOpen(event, emitter) {
  try {
    emitter(event)
    return true
  } catch {
    return false
  }
}

async function writeWatchdogSummary(summary) {
  const markdown = watchdogSummaryMarkdown(summary)
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown)
  console.log(JSON.stringify({
    message: 'snapshot_window_watchdog_batch_completed',
    scheduleDate: summary.scheduleDate,
    groups: Object.fromEntries(summary.results.map((item) => [item.city, item.status])),
  }))
}

function storeFromEnvironment(env) {
  return createD1WatchdogStore({
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: env.CLOUDFLARE_API_TOKEN,
    databaseId: env.TRANSIT_DATABASE_ID,
  })
}

function nullableString(value) {
  return value === undefined || value === null || String(value).trim() === '' ? null : String(value).trim()
}

function fullGitSha(value) {
  const text = nullableString(value)
  return text && /^[a-f0-9]{40}$/.test(text) ? text : null
}

function safeLog(message, city, watchdogRunIdValue) {
  console.error(JSON.stringify({ message, city, watchdogRunId: watchdogRunIdValue }))
}

async function main() {
  const plan = loadOperationsPlan()
  if (!plan.checks.windowWatchdog) {
    console.log(JSON.stringify({ message: 'instance_operation_disabled', operation: 'windowWatchdog' }))
    return
  }
  const result = await runWindowWatchdog({ store: storeFromEnvironment(process.env) })
  process.exitCode = result.ok ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
