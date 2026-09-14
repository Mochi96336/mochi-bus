import { appendFileSync, mkdirSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { parseWranglerD1ImportJson } from './d1-write-telemetry.mjs'

const CAPTURE_MAX_BYTES = 32 * 1024 * 1024
const OBSERVED_EVENT = 'snapshot_d1_observed_write'

export function executePublisherD1File({
  spawnSyncImpl,
  execPath,
  database,
  file,
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  now = () => new Date(),
} = {}) {
  if (typeof spawnSyncImpl !== 'function') throw new TypeError('spawnSyncImpl is required')
  if (!execPath || !database || !file) throw new TypeError('D1 execution configuration is incomplete')

  const baseArgs = [
    'node_modules/wrangler/bin/wrangler.js',
    'd1', 'execute', database, '--remote', '--file', file,
  ]
  if (env.SNAPSHOT_D1_OBSERVED_WRITE !== '1') {
    return spawnSyncImpl(execPath, baseArgs, { stdio: 'inherit' })
  }

  const result = spawnSyncImpl(execPath, [...baseArgs, '--json'], {
    encoding: 'utf8',
    maxBuffer: CAPTURE_MAX_BYTES,
  })
  forward(stderr, result?.stderr)
  if (result?.status !== 0) {
    forward(stdout, result?.stdout)
    return result
  }

  try {
    const outputFile = boundedText(env.SNAPSHOT_D1_OBSERVED_WRITE_FILE, 512)
    if (!outputFile) throw new Error('output_file_missing')
    const metrics = parseWranglerD1ImportJson(result.stdout)
    const sourceFile = basename(file)
    const record = Object.freeze({
      schemaVersion: 1,
      event: OBSERVED_EVENT,
      city: boundedText(env.SNAPSHOT_D1_OBSERVED_WRITE_CITY, 64),
      windowId: boundedText(env.SNAPSHOT_WINDOW_ID, 160),
      workflowRunId: boundedText(env.GITHUB_RUN_ID, 64),
      workflowRunAttempt: positiveIntegerOrNull(env.GITHUB_RUN_ATTEMPT),
      scriptGitSha: fullGitShaOrNull(env.GITHUB_SHA),
      recordedAt: now().toISOString(),
      phase: sourceFile === 'cleanup.sql' ? 'cleanup' : 'stage',
      sourceFile,
      rowsWritten: metrics.rowsWritten,
      rowsRead: metrics.rowsRead,
      queryCount: metrics.queryCount,
      durationMs: metrics.durationMs,
    })
    mkdirSync(dirname(outputFile), { recursive: true })
    appendFileSync(outputFile, `${JSON.stringify(record)}\n`, { mode: 0o600 })
    stdout?.write?.(`${JSON.stringify(record)}\n`)
  } catch {
    // Observation is deliberately fail-open after a successful remote commit.
    // Never convert metrics parsing/persistence trouble into a publisher retry.
    stderr?.write?.(`${JSON.stringify({
      schemaVersion: 1,
      event: 'snapshot_d1_observed_write_unavailable',
      city: boundedText(env.SNAPSHOT_D1_OBSERVED_WRITE_CITY, 64),
      windowId: boundedText(env.SNAPSHOT_WINDOW_ID, 160),
      workflowRunId: boundedText(env.GITHUB_RUN_ID, 64),
    })}\n`)
  }
  return result
}

export function parseObservedD1WriteRecord(value) {
  if (!value || typeof value !== 'object'
    || value.schemaVersion !== 1
    || value.event !== OBSERVED_EVENT
    || !safeText(value.city, 64)
    || !safeText(value.windowId, 160)
    || !safeText(value.workflowRunId, 64)
    || !Number.isSafeInteger(value.workflowRunAttempt) || value.workflowRunAttempt < 1
    || !fullGitShaOrNull(value.scriptGitSha)
    || !validIso(value.recordedAt)
    || !['stage', 'cleanup'].includes(value.phase)
    || !/^(?:import-\d+\.sql|cleanup\.sql)$/.test(String(value.sourceFile ?? ''))
    || !nonNegativeInteger(value.rowsWritten)
    || !nonNegativeInteger(value.rowsRead)
    || !nonNegativeInteger(value.queryCount)
    || !nonNegativeFinite(value.durationMs)) {
    throw new Error('Invalid observed D1 write record')
  }
  return Object.freeze({
    schemaVersion: 1,
    event: OBSERVED_EVENT,
    city: value.city,
    windowId: value.windowId,
    workflowRunId: value.workflowRunId,
    workflowRunAttempt: value.workflowRunAttempt,
    scriptGitSha: value.scriptGitSha,
    recordedAt: value.recordedAt,
    phase: value.phase,
    sourceFile: value.sourceFile,
    rowsWritten: value.rowsWritten,
    rowsRead: value.rowsRead,
    queryCount: value.queryCount,
    durationMs: value.durationMs,
  })
}

function forward(stream, value) {
  if (value === undefined || value === null || value === '') return
  stream?.write?.(Buffer.isBuffer(value) ? value : String(value))
}

function boundedText(value, maxLength) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text && text.length <= maxLength ? text : null
}

function safeText(value, maxLength) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
}

function positiveIntegerOrNull(value) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 1 ? number : null
}

function fullGitShaOrNull(value) {
  return typeof value === 'string' && /^[a-f0-9]{40}$/.test(value) ? value : null
}

function validIso(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function nonNegativeFinite(value) {
  return Number.isFinite(value) && value >= 0
}
