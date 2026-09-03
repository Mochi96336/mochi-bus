import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const DEFAULT_LEDGER = join('.transit-snapshot', 'd1-write-budget.json')
const DEFAULT_GROWTH_FACTOR = 1.10
const FIXED_RESERVE_ROWS = 64

// D1 rows_written counts table rows plus index rows. These weights mirror
// migrations/0001_transit_snapshot.sql: each row has the table write, the
// PRIMARY KEY autoindex write, and the listed secondary indexes.
const STAGE_WRITE_WEIGHTS = Object.freeze({
  routes: 3,
  patterns: 3,
  stops: 4,
  places: 3,
  patternStops: 3,
})

export function logicalSnapshotRows(counts) {
  const normalized = normalizeCounts(counts)
  return Object.values(normalized).reduce((sum, value) => sum + value, 0)
}

export function estimateStageRowsWritten(counts) {
  const normalized = normalizeCounts(counts)
  return Object.entries(STAGE_WRITE_WEIGHTS)
    .reduce((sum, [name, weight]) => sum + normalized[name] * weight, 0)
}

export function estimateScheduledPublishRowsWritten(counts, options = {}) {
  const growthFactor = positiveNumber(options.growthFactor, DEFAULT_GROWTH_FACTOR)
  const stageRows = estimateStageRowsWritten(counts)
  const cleanupRows = logicalSnapshotRows(counts)
  return Object.freeze({
    stageRows,
    cleanupRows,
    growthFactor,
    // The next source snapshot may be larger than the currently published one.
    // Cleanup is charged approximately one rows_written per deleted logical row
    // in current D1 execution metadata. Keep a small fixed reserve for pointer /
    // window-record writes around the publication.
    estimatedRows: Math.ceil(stageRows * growthFactor) + cleanupRows + FIXED_RESERVE_ROWS,
    fixedReserveRows: FIXED_RESERVE_ROWS,
  })
}

export function budgetDecision({ budgetRows, reservedRows, estimatedRows }) {
  const budget = nonNegativeInteger(budgetRows, 'budgetRows')
  const reserved = nonNegativeInteger(reservedRows, 'reservedRows')
  const estimate = nonNegativeInteger(estimatedRows, 'estimatedRows')
  return Object.freeze({
    allowed: reserved + estimate <= budget,
    budgetRows: budget,
    reservedRows: reserved,
    estimatedRows: estimate,
    remainingRows: Math.max(0, budget - reserved),
    projectedRows: reserved + estimate,
  })
}

export async function reserveScheduledD1Budget({
  city,
  env = process.env,
  readState = (targetCity) => readPublishedState(targetCity, env),
  now = () => new Date(),
}) {
  const budgetRows = parseOptionalPositiveInteger(env.SNAPSHOT_D1_WRITE_BUDGET)
  if (budgetRows === null) return Object.freeze({ enabled: false, allowed: true })

  const state = await readState(city)
  if (!state?.counts) throw new Error(`D1 write budget requires published snapshot counts for ${city}`)
  const estimate = estimateScheduledPublishRowsWritten(state.counts, {
    growthFactor: env.SNAPSHOT_D1_ESTIMATE_GROWTH_FACTOR,
  })
  const ledgerPath = env.SNAPSHOT_D1_WRITE_BUDGET_FILE || DEFAULT_LEDGER
  const ledger = await readLedger(ledgerPath, budgetRows)
  const existing = ledger.reservations.find((item) => item.city === city && item.status === 'reserved')
  if (existing) {
    const decision = budgetDecision({ budgetRows, reservedRows: ledger.reservedRows - existing.estimatedRows, estimatedRows: existing.estimatedRows })
    return Object.freeze({ enabled: true, allowed: true, city, estimate, decision, reused: true })
  }

  const decision = budgetDecision({
    budgetRows,
    reservedRows: ledger.reservedRows,
    estimatedRows: estimate.estimatedRows,
  })
  if (!decision.allowed) {
    return Object.freeze({ enabled: true, allowed: false, city, estimate, decision, reused: false })
  }

  const next = {
    schemaVersion: 1,
    budgetRows,
    reservedRows: ledger.reservedRows + estimate.estimatedRows,
    reservations: [...ledger.reservations, {
      city,
      estimatedRows: estimate.estimatedRows,
      fixedReserveRows: estimate.fixedReserveRows,
      status: 'reserved',
      reservedAt: now().toISOString(),
    }],
  }
  await writeLedger(ledgerPath, next)
  return Object.freeze({ enabled: true, allowed: true, city, estimate, decision, reused: false })
}

export async function settleScheduledD1Budget({ city, result, env = process.env, now = () => new Date() }) {
  const budgetRows = parseOptionalPositiveInteger(env.SNAPSHOT_D1_WRITE_BUDGET)
  if (budgetRows === null) return Object.freeze({ enabled: false })
  const ledgerPath = env.SNAPSHOT_D1_WRITE_BUDGET_FILE || DEFAULT_LEDGER
  const ledger = await readLedger(ledgerPath, budgetRows)
  const index = ledger.reservations.findIndex((item) => item.city === city && item.status === 'reserved')
  if (index < 0) throw new Error(`Missing D1 write budget reservation for ${city}`)
  const reservation = ledger.reservations[index]
  const releaseRows = result === 'unchanged'
    ? Math.max(0, reservation.estimatedRows - reservation.fixedReserveRows)
    : 0
  const reservations = ledger.reservations.slice()
  reservations[index] = {
    ...reservation,
    status: result === 'unchanged' ? 'released-unchanged' : 'consumed',
    result,
    settledAt: now().toISOString(),
    releasedRows: releaseRows,
  }
  const next = {
    ...ledger,
    reservedRows: Math.max(0, ledger.reservedRows - releaseRows),
    reservations,
  }
  await writeLedger(ledgerPath, next)
  return Object.freeze({ enabled: true, city, result, releaseRows, reservedRows: next.reservedRows })
}

async function readPublishedState(city, env) {
  const accountId = required(env.CLOUDFLARE_ACCOUNT_ID, 'CLOUDFLARE_ACCOUNT_ID')
  const accessKeyId = required(env.R2_ACCESS_KEY_ID, 'R2_ACCESS_KEY_ID')
  const secretAccessKey = required(env.R2_SECRET_ACCESS_KEY, 'R2_SECRET_ACCESS_KEY')
  const bucket = required(env.TRANSIT_R2_BUCKET_NAME, 'TRANSIT_R2_BUCKET_NAME')
  const { AwsClient } = await import('aws4fetch')
  const client = new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' })
  const key = `snapshots/state/${city}.json`
  const response = await client.fetch(`https://${accountId}.r2.cloudflarestorage.com/${bucket}/${key}`)
  if (!response.ok) {
    await response.arrayBuffer()
    throw new Error(`R2 snapshot state read failed for ${city} (${response.status})`)
  }
  return await response.json()
}

async function readLedger(path, budgetRows) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    if (parsed?.schemaVersion !== 1 || parsed?.budgetRows !== budgetRows
      || !Number.isSafeInteger(parsed?.reservedRows) || parsed.reservedRows < 0
      || !Array.isArray(parsed?.reservations)) {
      throw new Error('Invalid D1 write budget ledger')
    }
    return parsed
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return { schemaVersion: 1, budgetRows, reservedRows: 0, reservations: [] }
    }
    throw error
  }
}

async function writeLedger(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(value)}\n`)
  await rename(temporary, path)
}

function normalizeCounts(counts) {
  return {
    routes: nonNegativeInteger(counts?.routes, 'counts.routes'),
    patterns: nonNegativeInteger(counts?.patterns, 'counts.patterns'),
    stops: nonNegativeInteger(counts?.stops, 'counts.stops'),
    places: nonNegativeInteger(counts?.places, 'counts.places'),
    patternStops: nonNegativeInteger(counts?.patternStops, 'counts.patternStops'),
  }
}

function nonNegativeInteger(value, name) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${name} must be a non-negative integer`)
  return number
}

function positiveNumber(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback
  const number = Number(value)
  if (!Number.isFinite(number) || number < 1) throw new Error('SNAPSHOT_D1_ESTIMATE_GROWTH_FACTOR must be >= 1')
  return number
}

function parseOptionalPositiveInteger(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error('SNAPSHOT_D1_WRITE_BUDGET must be a positive integer')
  return number
}

function required(value, name) {
  if (!value) throw new Error(`${name} is required for D1 write budget preflight`)
  return value
}

async function main() {
  const command = process.argv[2]
  const city = process.argv[3]
  if (!city || !['reserve', 'settle'].includes(command)) {
    throw new Error('Usage: node scripts/transit-snapshot/d1-write-budget.mjs <reserve|settle> <city> [result]')
  }
  if (command === 'reserve') {
    const result = await reserveScheduledD1Budget({ city })
    console.log(JSON.stringify({ event: 'snapshot_d1_write_budget', action: 'reserve', ...result }))
    if (!result.allowed) process.exitCode = 2
    return
  }
  const outcome = process.argv[4]
  if (!['published', 'unchanged', 'failed'].includes(outcome)) throw new Error('settle result must be published, unchanged, or failed')
  const result = await settleScheduledD1Budget({ city, result: outcome })
  console.log(JSON.stringify({ event: 'snapshot_d1_write_budget', action: 'settle', ...result }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify({ event: 'snapshot_d1_write_budget_error', message: error instanceof Error ? error.message : String(error) }))
    process.exitCode = 1
  })
}
