import { spawnSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AwsClient } from 'aws4fetch'
import { loadOperationalResources } from '../instance/operational-resources.mjs'
import { queryD1 } from './window-d1.mjs'

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const STATE_MAX_BYTES = 64 * 1024
const CHILD_MAX_BUFFER = 4 * 1024 * 1024

export function parseRollbackRecord(output) {
  const lines = String(output ?? '').split(/\r?\n/)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim()
    if (!line) continue
    try {
      const value = JSON.parse(line)
      if (value?.event === 'snapshot_authority_operation' && value.operation === 'rollback') {
        return value
      }
    } catch {
      // npm/child output can contain non-JSON lines.
    }
  }
  return null
}

export function sameHighCardCounts(left, right) {
  return JSON.stringify(normalizeHighCardCounts(left)) === JSON.stringify(normalizeHighCardCounts(right))
}

export function assertRollbackSequence({ before, afterRollback, afterRestore, firstRollback, restoreRollback }) {
  const originalActive = before?.authority?.activeVersion
  const originalPrevious = before?.state?.previousVersion
  if (!safeId(originalActive) || !safeId(originalPrevious) || originalActive === originalPrevious) {
    throw new Error('Rollback drill requires distinct safe active and previous versions')
  }
  if (before?.state?.activeVersion !== originalActive) {
    throw new Error('Rollback drill authority/state mismatch before mutation')
  }
  if (firstRollback?.outcome !== 'rolled_back'
    || firstRollback.activeVersion !== originalPrevious
    || firstRollback.previousVersion !== originalActive) {
    throw new Error('First rollback outcome did not swap active/previous as expected')
  }
  if (afterRollback?.authority?.activeVersion !== originalPrevious
    || afterRollback?.state?.activeVersion !== originalPrevious
    || afterRollback?.state?.previousVersion !== originalActive) {
    throw new Error('Production authority did not reflect the rollback target')
  }
  if (restoreRollback?.outcome !== 'rolled_back'
    || restoreRollback.activeVersion !== originalActive
    || restoreRollback.previousVersion !== originalPrevious) {
    throw new Error('Restore rollback outcome did not return to the original active version')
  }
  if (afterRestore?.authority?.activeVersion !== originalActive
    || afterRestore?.state?.activeVersion !== originalActive
    || afterRestore?.state?.previousVersion !== originalPrevious) {
    throw new Error('Production authority was not restored to the original active/previous pair')
  }
  return true
}

export async function runRollbackDrill({
  city = 'Taichung',
  env = process.env,
  now = () => new Date(),
  runRollback = (targetVersion) => runRollbackCli(city, targetVersion, env),
  readSnapshot = () => createSnapshotReader({ city, env })(),
  reportPath = env.ROLLBACK_DRILL_REPORT ?? 'rollback-drill-report.json',
} = {}) {
  if (city !== 'Taichung') throw new Error('Rollback drill is intentionally restricted to Taichung')
  const startedAt = now().toISOString()
  const report = {
    schemaVersion: 1,
    kind: 'snapshot-rollback-drill',
    city,
    sourceCommit: safeText(env.GITHUB_SHA),
    workflowRunId: safeText(env.GITHUB_RUN_ID),
    workflowRunAttempt: safeText(env.GITHUB_RUN_ATTEMPT),
    startedAt,
    completedAt: null,
    outcome: 'error',
    before: null,
    firstRollback: null,
    afterRollback: null,
    restoreRollback: null,
    afterRestore: null,
    recoveryRollback: null,
    finalSnapshot: null,
    highCardUnchanged: false,
    restoredOriginalAuthority: false,
    errorCode: null,
  }

  let originalActive = null
  let primaryError = null
  try {
    report.before = await readSnapshot()
    originalActive = report.before?.authority?.activeVersion ?? null
    const originalPrevious = report.before?.state?.previousVersion
    if (!safeId(originalActive) || !safeId(originalPrevious) || originalActive === originalPrevious
      || report.before?.state?.activeVersion !== originalActive) {
      throw codedError('invalid_initial_authority')
    }

    report.firstRollback = await runRollback(undefined)
    if (report.firstRollback?.outcome !== 'rolled_back') throw codedError('first_rollback_failed')
    report.afterRollback = await readSnapshot()

    report.restoreRollback = await runRollback(originalActive)
    if (report.restoreRollback?.outcome !== 'rolled_back') throw codedError('restore_rollback_failed')
    report.afterRestore = await readSnapshot()

    assertRollbackSequence(report)
    report.highCardUnchanged = sameHighCardCounts(report.before.highCard, report.afterRestore.highCard)
    if (!report.highCardUnchanged) throw codedError('high_card_rows_changed')
    report.restoredOriginalAuthority = true
    report.outcome = 'success'
  } catch (error) {
    primaryError = error
    report.errorCode = safeErrorCode(error)
  }

  if (report.outcome !== 'success' && safeId(originalActive)) {
    try {
      const current = await readSnapshot()
      if (current?.authority?.activeVersion !== originalActive) {
        report.recoveryRollback = await runRollback(originalActive)
      }
    } catch (error) {
      report.recoveryRollback = {
        event: 'snapshot_authority_operation',
        operation: 'rollback',
        outcome: 'recovery_failed',
        errorCode: safeErrorCode(error),
      }
    }
  }

  try {
    report.finalSnapshot = await readSnapshot()
    report.restoredOriginalAuthority = safeId(originalActive)
      && report.finalSnapshot?.authority?.activeVersion === originalActive
      && report.finalSnapshot?.state?.activeVersion === originalActive
    if (report.before?.highCard && report.finalSnapshot?.highCard) {
      report.highCardUnchanged = sameHighCardCounts(report.before.highCard, report.finalSnapshot.highCard)
    }
  } catch {
    // Preserve the primary failure; missing final evidence remains a failed drill.
  }

  report.completedAt = now().toISOString()
  await writeReport(reportPath, report)

  if (report.outcome !== 'success') {
    const error = primaryError instanceof Error ? primaryError : codedError(report.errorCode ?? 'rollback_drill_failed')
    throw error
  }
  return Object.freeze(report)
}

function createSnapshotReader({ city, env }) {
  const resources = loadOperationalResources()
  const accountId = required(env.CLOUDFLARE_ACCOUNT_ID, 'CLOUDFLARE_ACCOUNT_ID')
  const apiToken = required(env.CLOUDFLARE_API_TOKEN, 'CLOUDFLARE_API_TOKEN')
  const databaseId = required(env.TRANSIT_DATABASE_ID ?? resources.d1DatabaseId, 'TRANSIT_DATABASE_ID')
  const bucket = required(env.TRANSIT_R2_BUCKET_NAME ?? resources.r2BucketName, 'TRANSIT_R2_BUCKET_NAME')
  const accessKeyId = required(env.R2_ACCESS_KEY_ID, 'R2_ACCESS_KEY_ID')
  const secretAccessKey = required(env.R2_SECRET_ACCESS_KEY, 'R2_SECRET_ACCESS_KEY')
  const r2 = new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' })
  const baseUrl = `https://${accountId}.r2.cloudflarestorage.com/${bucket}`
  const query = (sql, params = []) => queryD1({ accountId, apiToken, databaseId, fetchImpl: fetch, sql, params })

  return async function readSnapshot() {
    const [authorityRows, highCard] = await Promise.all([
      query('SELECT active_version, imported_at FROM dataset_versions WHERE city_code = ? LIMIT 1', [city]),
      readHighCardCounts(query, city),
    ])
    const authorityRow = authorityRows[0]
    const activeVersion = safeId(authorityRow?.active_version) ? authorityRow.active_version : null
    const state = await readR2State(r2, baseUrl, city)
    return Object.freeze({
      authority: Object.freeze({
        activeVersion,
        importedAt: typeof authorityRow?.imported_at === 'string' ? authorityRow.imported_at : null,
      }),
      state,
      highCard,
    })
  }
}

async function readHighCardCounts(query, city) {
  const [globalStops, globalPatternStops, cityStops, cityPatternStops, stopVersions, patternStopVersions] = await Promise.all([
    query('SELECT COUNT(*) AS count FROM stops'),
    query('SELECT COUNT(*) AS count FROM pattern_stops'),
    query('SELECT COUNT(*) AS count FROM stops WHERE city_code = ?', [city]),
    query(`SELECT COUNT(*) AS count FROM pattern_stops ps
      JOIN patterns p ON p.version = ps.version AND p.pattern_id = ps.pattern_id
      WHERE p.city_code = ?`, [city]),
    query(`SELECT version, COUNT(*) AS count FROM stops
      WHERE city_code = ? GROUP BY version ORDER BY version`, [city]),
    query(`SELECT ps.version AS version, COUNT(*) AS count FROM pattern_stops ps
      JOIN patterns p ON p.version = ps.version AND p.pattern_id = ps.pattern_id
      WHERE p.city_code = ? GROUP BY ps.version ORDER BY ps.version`, [city]),
  ])
  return normalizeHighCardCounts({
    globalStops: integerCount(globalStops[0]?.count),
    globalPatternStops: integerCount(globalPatternStops[0]?.count),
    cityStops: integerCount(cityStops[0]?.count),
    cityPatternStops: integerCount(cityPatternStops[0]?.count),
    stopVersions: normalizeVersionCounts(stopVersions),
    patternStopVersions: normalizeVersionCounts(patternStopVersions),
  })
}

function normalizeHighCardCounts(value) {
  return Object.freeze({
    globalStops: integerCount(value?.globalStops),
    globalPatternStops: integerCount(value?.globalPatternStops),
    cityStops: integerCount(value?.cityStops),
    cityPatternStops: integerCount(value?.cityPatternStops),
    stopVersions: normalizeVersionCounts(value?.stopVersions),
    patternStopVersions: normalizeVersionCounts(value?.patternStopVersions),
  })
}

function normalizeVersionCounts(rows) {
  if (!Array.isArray(rows)) return Object.freeze([])
  const normalized = rows.map((row) => Object.freeze({
    version: safeId(row?.version) ? row.version : null,
    count: integerCount(row?.count),
  }))
  if (normalized.some((row) => row.version === null)) throw new Error('Invalid high-card version count evidence')
  normalized.sort((a, b) => a.version.localeCompare(b.version))
  return Object.freeze(normalized)
}

async function readR2State(client, baseUrl, city) {
  const key = `snapshots/state/${city}.json`
  const url = `${baseUrl}/${key.split('/').map(encodeURIComponent).join('/')}`
  const response = await client.fetch(url)
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error('Rollback drill R2 state read failed')
  }
  const declared = Number(response.headers.get('Content-Length'))
  if (Number.isFinite(declared) && declared > STATE_MAX_BYTES) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error('Rollback drill R2 state exceeded byte limit')
  }
  const text = await response.text()
  if (new TextEncoder().encode(text).byteLength > STATE_MAX_BYTES) {
    throw new Error('Rollback drill R2 state exceeded byte limit')
  }
  let value
  try { value = JSON.parse(text) } catch { throw new Error('Rollback drill R2 state returned invalid JSON') }
  const activeVersion = safeId(value?.activeVersion) ? value.activeVersion : null
  const previousVersion = safeId(value?.previousVersion) ? value.previousVersion : null
  if (!activeVersion || !previousVersion) throw new Error('Rollback drill R2 state is incomplete')
  return Object.freeze({ activeVersion, previousVersion })
}

function runRollbackCli(city, targetVersion, env) {
  const args = ['scripts/transit-snapshot/rollback.mjs', city]
  if (targetVersion !== undefined) args.push(targetVersion)
  const child = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
    maxBuffer: CHILD_MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const record = parseRollbackRecord(`${child.stdout ?? ''}\n${child.stderr ?? ''}`)
  if (child.error) throw codedError('rollback_process_error')
  if (child.status !== 0 || !record) {
    const error = codedError(record?.outcome ?? 'rollback_command_failed')
    error.record = record
    throw error
  }
  return record
}

async function writeReport(path, report) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
}

function integerCount(value) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('Invalid high-card row count evidence')
  return parsed
}

function safeId(value) {
  return typeof value === 'string' && SAFE_ID.test(value) ? value : null
}

function safeText(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,160}$/.test(value) ? value : null
}

function safeErrorCode(error) {
  const value = typeof error?.code === 'string' ? error.code : error instanceof Error ? error.message : ''
  const normalized = value.toLowerCase().replace(/[^a-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '')
  return normalized.slice(0, 80) || 'rollback_drill_failed'
}

function codedError(code) {
  const error = new Error('Snapshot rollback drill failed')
  error.code = safeText(String(code).toLowerCase()) ?? 'rollback_drill_failed'
  return error
}

function required(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`)
  return value.trim()
}

async function main() {
  const city = process.argv[2] ?? 'Taichung'
  try {
    const report = await runRollbackDrill({ city })
    console.log(JSON.stringify({
      event: 'snapshot_rollback_drill_completed',
      outcome: report.outcome,
      city: report.city,
      originalActive: report.before?.authority?.activeVersion ?? null,
      rollbackTarget: report.before?.state?.previousVersion ?? null,
      restoredOriginalAuthority: report.restoredOriginalAuthority,
      highCardUnchanged: report.highCardUnchanged,
    }))
  } catch (error) {
    console.error(JSON.stringify({
      event: 'snapshot_rollback_drill_failed',
      city: city === 'Taichung' ? city : null,
      errorCode: safeErrorCode(error),
    }))
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
