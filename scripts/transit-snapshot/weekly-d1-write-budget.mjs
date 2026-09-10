import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadOperationsPlan } from '../instance/operations-plan.mjs'
import { estimateScheduledD1WriteForCity } from './d1-write-budget.mjs'
import { snapshotCitiesByTaipeiWeekday } from './snapshot-schedule.mjs'

export const WEEKLY_D1_BUDGET_REPORT_SCHEMA_VERSION = 1
const DEFAULT_REPORT_PATH = join('.transit-snapshot', 'weekly-d1-write-budget.json')
const WEEKDAY_NAMES = Object.freeze(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'])
const SAFE_CITY = /^[A-Za-z][A-Za-z0-9]{0,63}$/
const MAX_CLEANUP_CITY_ROWS = 256
const MAX_D1_RESPONSE_BYTES = 128 * 1024

// The scheduled publisher keeps the currently-active version and deletes every
// other low-cardinality D1 version for the city. The old proof asked this same
// question once per enabled city. With indexes led by `version`, each
// `city_code = ? AND version <> active` predicate can scan the whole covering
// index, multiplying one database-wide scan by the number of cities. Aggregate
// all three publisher-owned tables in one query instead: each table is scanned
// at most once and the existing per-city estimator still receives the exact
// cleanup row count it used before.
export const WEEKLY_CLEANUP_ROWS_SQL = `
SELECT city_code, SUM(cleanup_rows) AS cleanup_rows
FROM (
  SELECT r.city_code AS city_code, COUNT(*) AS cleanup_rows
  FROM routes r
  LEFT JOIN dataset_versions d ON d.city_code = r.city_code
  WHERE r.version <> COALESCE(d.active_version, '')
  GROUP BY r.city_code

  UNION ALL

  SELECT p.city_code AS city_code, COUNT(*) AS cleanup_rows
  FROM patterns p
  LEFT JOIN dataset_versions d ON d.city_code = p.city_code
  WHERE p.version <> COALESCE(d.active_version, '')
  GROUP BY p.city_code

  UNION ALL

  SELECT s.city_code AS city_code, COUNT(*) AS cleanup_rows
  FROM stop_places s
  LEFT JOIN dataset_versions d ON d.city_code = s.city_code
  WHERE s.version <> COALESCE(d.active_version, '')
  GROUP BY s.city_code
) AS inactive
GROUP BY city_code
ORDER BY city_code
`

export async function queryD1RowsWithMeta({ accountId, apiToken, databaseId, fetchImpl = fetch, sql, params }) {
  if (!accountId || !apiToken || !databaseId || !sql || !Array.isArray(params)) {
    throw new Error('Weekly D1 cleanup query configuration is invalid')
  }
  const response = await fetchImpl(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/query`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sql, params }),
      signal: AbortSignal.timeout(15_000),
    },
  )
  const text = await response.text()
  if (new TextEncoder().encode(text).byteLength > MAX_D1_RESPONSE_BYTES) {
    throw new Error('Weekly D1 cleanup query response is too large')
  }
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error('Weekly D1 cleanup query returned invalid JSON')
  }
  const item = Array.isArray(payload?.result) && payload.result.length === 1
    ? payload.result[0]
    : null
  if (!response.ok || payload?.success !== true || item?.success !== true || !Array.isArray(item.results)) {
    throw new Error('Weekly D1 cleanup query failed')
  }
  const rowsRead = Number(item.meta?.rows_read)
  return Object.freeze({
    rows: item.results,
    rowsRead: Number.isSafeInteger(rowsRead) && rowsRead >= 0 ? rowsRead : null,
  })
}

export async function readWeeklyCleanupRowsEvidence({ env = process.env, query } = {}) {
  const execute = query ?? ((sql, params) => queryD1RowsWithMeta({
    accountId: required(env.CLOUDFLARE_ACCOUNT_ID, 'CLOUDFLARE_ACCOUNT_ID'),
    apiToken: required(env.CLOUDFLARE_API_TOKEN, 'CLOUDFLARE_API_TOKEN'),
    databaseId: required(env.TRANSIT_DATABASE_ID, 'TRANSIT_DATABASE_ID'),
    fetchImpl: fetch,
    sql,
    params,
  }))
  if (typeof execute !== 'function') throw new Error('Weekly D1 cleanup query is invalid')

  const raw = await execute(WEEKLY_CLEANUP_ROWS_SQL, [])
  const rows = Array.isArray(raw) ? raw : raw?.rows
  const rowsRead = Array.isArray(raw) ? null : normalizeRowsRead(raw?.rowsRead)
  if (!Array.isArray(rows) || rows.length > MAX_CLEANUP_CITY_ROWS) {
    throw new Error('Weekly D1 cleanup rows are invalid')
  }

  const rowsByCity = new Map()
  for (const row of rows) {
    const city = typeof row?.city_code === 'string' && SAFE_CITY.test(row.city_code)
      ? row.city_code
      : null
    const cleanupRows = Number(row?.cleanup_rows)
    if (!city || !Number.isSafeInteger(cleanupRows) || cleanupRows < 0 || rowsByCity.has(city)) {
      throw new Error('Weekly D1 cleanup rows are invalid')
    }
    rowsByCity.set(city, cleanupRows)
  }
  return Object.freeze({ rowsByCity, rowsRead })
}

export async function readWeeklyCleanupRowsByCity(options = {}) {
  return (await readWeeklyCleanupRowsEvidence(options)).rowsByCity
}

export async function buildWeeklyD1WriteBudgetReport({
  plan = loadOperationsPlan(),
  env = process.env,
  now = () => new Date(),
  estimateCity = (city) => estimateScheduledD1WriteForCity({ city, env }),
} = {}) {
  if (plan?.snapshotSchedule !== 'taipei-weekly-sharded') {
    throw new Error('Weekly D1 budget proof requires taipei-weekly-sharded snapshot schedule')
  }
  const budgetRows = positiveInteger(env.SNAPSHOT_D1_WRITE_BUDGET, 'SNAPSHOT_D1_WRITE_BUDGET')
  const weekly = snapshotCitiesByTaipeiWeekday(plan)
  const scheduled = weekly.flat()
  const enabled = Array.isArray(plan.enabledCities) ? plan.enabledCities : []
  if (scheduled.length !== enabled.length || new Set(scheduled).size !== scheduled.length
    || enabled.some((city) => !scheduled.includes(city))) {
    throw new Error('Weekly D1 budget proof must cover every enabled city exactly once')
  }

  const days = []
  let weeklyProjectedRows = 0
  for (let weekday = 0; weekday < weekly.length; weekday += 1) {
    const cityProofs = []
    let projectedRows = 0
    for (const city of weekly[weekday]) {
      const result = await estimateCity(city)
      const proof = normalizeCityProof(city, result)
      cityProofs.push(proof)
      projectedRows += proof.estimatedRows
      if (!Number.isSafeInteger(projectedRows)) throw new Error('Weekly D1 budget projection overflow')
    }
    weeklyProjectedRows += projectedRows
    if (!Number.isSafeInteger(weeklyProjectedRows)) throw new Error('Weekly D1 budget projection overflow')
    days.push(Object.freeze({
      weekday,
      weekdayName: WEEKDAY_NAMES[weekday],
      cities: Object.freeze(cityProofs),
      projectedRows,
      budgetRows,
      headroomRows: budgetRows - projectedRows,
      allowed: projectedRows <= budgetRows,
    }))
  }

  const maxDay = days.reduce((current, day) => day.projectedRows > current.projectedRows ? day : current, days[0])
  return Object.freeze({
    schemaVersion: WEEKLY_D1_BUDGET_REPORT_SCHEMA_VERSION,
    generatedAt: now().toISOString(),
    snapshotSchedule: plan.snapshotSchedule,
    budgetRows,
    enabledCityCount: enabled.length,
    weeklyProjectedRows,
    maxProjectedDay: Object.freeze({
      weekday: maxDay.weekday,
      weekdayName: maxDay.weekdayName,
      projectedRows: maxDay.projectedRows,
      headroomRows: maxDay.headroomRows,
    }),
    allDaysAllowed: days.every((day) => day.allowed),
    days: Object.freeze(days),
  })
}

function normalizeCityProof(city, result) {
  if (result?.city !== city || !result?.counts || !result?.estimate) {
    throw new Error(`Weekly D1 budget estimate is invalid for ${city}`)
  }
  const counts = Object.freeze({
    routes: nonNegativeInteger(result.counts.routes, `${city}.counts.routes`),
    patterns: nonNegativeInteger(result.counts.patterns, `${city}.counts.patterns`),
    stops: nonNegativeInteger(result.counts.stops, `${city}.counts.stops`),
    places: nonNegativeInteger(result.counts.places, `${city}.counts.places`),
    patternStops: nonNegativeInteger(result.counts.patternStops, `${city}.counts.patternStops`),
  })
  const estimatedRows = nonNegativeInteger(result.estimate.estimatedRows, `${city}.estimatedRows`)
  return Object.freeze({
    city,
    counts,
    stageRows: nonNegativeInteger(result.estimate.stageRows, `${city}.stageRows`),
    cleanupRows: nonNegativeInteger(result.estimate.cleanupRows, `${city}.cleanupRows`),
    fixedReserveRows: nonNegativeInteger(result.estimate.fixedReserveRows, `${city}.fixedReserveRows`),
    growthFactor: positiveNumber(result.estimate.growthFactor, `${city}.growthFactor`),
    estimatedRows,
  })
}

function positiveInteger(value, name) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${name} must be a positive integer`)
  return number
}

function nonNegativeInteger(value, name) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${name} must be a non-negative integer`)
  return number
}

function normalizeRowsRead(value) {
  if (value === undefined || value === null) return null
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) throw new Error('Weekly D1 cleanup rows_read is invalid')
  return number
}

function positiveNumber(value, name) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 1) throw new Error(`${name} must be >= 1`)
  return number
}

function required(value, name) {
  if (!value) throw new Error(`${name} is required for weekly D1 cleanup proof`)
  return value
}

async function writeReport(report, env, readEvidence = {}) {
  const path = env.SNAPSHOT_WEEKLY_D1_BUDGET_REPORT || DEFAULT_REPORT_PATH
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`)
  if (env.GITHUB_STEP_SUMMARY) {
    const rows = report.days.map((day) =>
      `| ${day.weekdayName} | ${day.cities.map((item) => item.city).join(', ')} | ${day.projectedRows} | ${day.headroomRows} | ${day.allowed ? 'yes' : 'NO'} |`)
    await appendFile(env.GITHUB_STEP_SUMMARY, [
      '## Weekly D1 snapshot write budget',
      '',
      `Budget: ${report.budgetRows} rows/day; cities: ${report.enabledCityCount}; all days allowed: ${report.allDaysAllowed}.`,
      `Cleanup aggregate rows_read: ${readEvidence.cleanupQueryRowsRead ?? 'unavailable'}.`,
      '',
      '| Day | Cities | Projected rows_written | Headroom | Allowed |',
      '| --- | --- | ---: | ---: | --- |',
      ...rows,
      '',
    ].join('\n'))
  }
  return path
}

async function main(env = process.env) {
  const plan = loadOperationsPlan()
  const cleanupEvidence = await readWeeklyCleanupRowsEvidence({ env })
  const cleanupRowsByCity = cleanupEvidence.rowsByCity
  const report = await buildWeeklyD1WriteBudgetReport({
    plan,
    env,
    estimateCity: (city) => estimateScheduledD1WriteForCity({
      city,
      env,
      readCleanupRows: async () => cleanupRowsByCity.get(city) ?? 0,
    }),
  })
  const readEvidence = Object.freeze({ cleanupQueryRowsRead: cleanupEvidence.rowsRead })
  const reportPath = await writeReport(report, env, readEvidence)
  console.log(JSON.stringify({
    event: 'snapshot_weekly_d1_budget_proof',
    reportPath,
    budgetRows: report.budgetRows,
    enabledCityCount: report.enabledCityCount,
    weeklyProjectedRows: report.weeklyProjectedRows,
    cleanupQueryRowsRead: readEvidence.cleanupQueryRowsRead,
    maxProjectedDay: report.maxProjectedDay,
    allDaysAllowed: report.allDaysAllowed,
    days: report.days.map(({ weekdayName, projectedRows, headroomRows, allowed }) => ({
      weekdayName, projectedRows, headroomRows, allowed,
    })),
  }))
  if (!report.allDaysAllowed) process.exitCode = 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify({
      event: 'snapshot_weekly_d1_budget_proof_error',
      message: error instanceof Error ? error.message : String(error),
    }))
    process.exitCode = 1
  })
}
