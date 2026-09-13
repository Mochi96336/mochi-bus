import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadOperationalResources } from '../instance/operational-resources.mjs'
import { queryD1 } from './window-d1.mjs'

export const HIGH_CARD_SCHEMA_INVENTORY_VERSION = 1
const DEFAULT_REPORT_PATH = join('.transit-snapshot', 'high-card-retirement-schema-inventory.json')
const TARGET_TABLES = Object.freeze(['pattern_stops', 'stops'])
const EXPECTED_EXPLICIT_OBJECTS = new Map([
  ['pattern_stops', Object.freeze({ type: 'table', table: 'pattern_stops' })],
  ['pattern_stops_place_idx', Object.freeze({ type: 'index', table: 'pattern_stops' })],
  ['stops', Object.freeze({ type: 'table', table: 'stops' })],
  ['stops_name_idx', Object.freeze({ type: 'index', table: 'stops' })],
  ['stops_place_idx', Object.freeze({ type: 'index', table: 'stops' })],
])
const ALLOWED_TYPES = new Set(['index', 'table', 'trigger', 'view'])
const MAX_SCHEMA_ROWS = 256
const SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

export const HIGH_CARD_SCHEMA_INVENTORY_SQL = `
SELECT type, name, tbl_name, sql
FROM sqlite_schema
WHERE tbl_name IN ('stops', 'pattern_stops')
   OR (type IN ('view', 'trigger')
       AND (lower(COALESCE(sql, '')) LIKE '%stops%'
            OR lower(COALESCE(sql, '')) LIKE '%pattern_stops%'))
ORDER BY type, name
LIMIT ${MAX_SCHEMA_ROWS + 1}
`

export async function collectHighCardSchemaInventory({
  env = process.env,
  now = () => new Date(),
  readSchema = () => readProductionSchema(env),
} = {}) {
  const rows = normalizeSchemaRows(await readSchema())
  const relevant = rows.filter((row) => isOwnedByTarget(row) || referencedTargets(row.sql).length > 0)
  const ownedRows = relevant.filter(isOwnedByTarget)
  const ownedObjects = ownedRows.map(publicObject)
  const externalDependencies = relevant
    .filter((row) => !isOwnedByTarget(row) && referencedTargets(row.sql).length > 0)
    .map((row) => Object.freeze({ ...publicObject(row), references: Object.freeze(referencedTargets(row.sql)) }))
  const ownedNames = new Set(ownedObjects.map((row) => row.name))
  const tablesPresent = TARGET_TABLES.filter((name) => ownedObjects.some((row) => row.type === 'table' && row.name === name))
  const schemaState = tablesPresent.length === TARGET_TABLES.length
    ? 'legacy-present'
    : tablesPresent.length === 0 ? 'retired' : 'partial'

  const missingExpectedObjects = schemaState === 'legacy-present'
    ? [...EXPECTED_EXPLICIT_OBJECTS.keys()].filter((name) => !ownedNames.has(name)).sort()
    : []
  const unexpectedOwnedObjects = ownedRows
    .filter((row) => !isExpectedOwnedObject(row))
    .map(publicObject)

  return Object.freeze({
    schemaVersion: HIGH_CARD_SCHEMA_INVENTORY_VERSION,
    kind: 'snapshot-high-card-d1-schema-inventory',
    sourceCommit: safeText(env.GITHUB_SHA),
    workflowRunId: safeText(env.GITHUB_RUN_ID),
    workflowRunAttempt: safeText(env.GITHUB_RUN_ATTEMPT),
    generatedAt: now().toISOString(),
    schemaState,
    tablesPresent: Object.freeze([...tablesPresent]),
    ownedObjects: Object.freeze(ownedObjects),
    missingExpectedObjects: Object.freeze(missingExpectedObjects),
    unexpectedOwnedObjects: Object.freeze(unexpectedOwnedObjects),
    externalDependencies: Object.freeze(externalDependencies),
    schemaMatchesExpectedLegacyShape: schemaState === 'legacy-present'
      && missingExpectedObjects.length === 0
      && unexpectedOwnedObjects.length === 0
      && externalDependencies.length === 0,
    dependencyClear: schemaState !== 'partial' && externalDependencies.length === 0,
  })
}

export function normalizeSchemaRows(rows) {
  if (!Array.isArray(rows) || rows.length > MAX_SCHEMA_ROWS) {
    throw new Error('High-card schema inventory exceeded its bounded row set')
  }
  return Object.freeze(rows.map((row) => {
    const type = typeof row?.type === 'string' ? row.type.toLowerCase() : null
    const name = safeName(row?.name)
    const table = safeName(row?.tbl_name)
    const sql = row?.sql === null || row?.sql === undefined
      ? null
      : typeof row.sql === 'string' && row.sql.length <= 65_536 ? row.sql : undefined
    if (!ALLOWED_TYPES.has(type) || !name || !table || sql === undefined) {
      throw new Error('High-card schema inventory returned invalid schema metadata')
    }
    return Object.freeze({ type, name, table, sql })
  }))
}

export function referencedTargets(sql) {
  if (typeof sql !== 'string') return Object.freeze([])
  const matches = TARGET_TABLES.filter((name) => identifierPattern(name).test(sql))
  return Object.freeze(matches)
}

function isOwnedByTarget(row) {
  return TARGET_TABLES.includes(row.table)
}

function isExpectedOwnedObject(row) {
  const expected = EXPECTED_EXPLICIT_OBJECTS.get(row.name)
  if (expected) return row.type === expected.type && row.table === expected.table
  return row.type === 'index'
    && row.sql === null
    && TARGET_TABLES.includes(row.table)
    && new RegExp(`^sqlite_autoindex_${row.table}_[1-9][0-9]*$`).test(row.name)
}

function publicObject(row) {
  return Object.freeze({ type: row.type, name: row.name, table: row.table })
}

function identifierPattern(name) {
  return new RegExp(`(?:^|[^A-Za-z0-9_])${name}(?:$|[^A-Za-z0-9_])`, 'i')
}

async function readProductionSchema(env) {
  const resources = loadOperationalResources()
  return queryD1({
    accountId: required(env.CLOUDFLARE_ACCOUNT_ID, 'CLOUDFLARE_ACCOUNT_ID'),
    apiToken: required(env.CLOUDFLARE_API_TOKEN, 'CLOUDFLARE_API_TOKEN'),
    databaseId: required(env.TRANSIT_DATABASE_ID ?? resources.d1DatabaseId, 'TRANSIT_DATABASE_ID'),
    fetchImpl: fetch,
    sql: HIGH_CARD_SCHEMA_INVENTORY_SQL,
    params: [],
  })
}

async function writeReport(report, env) {
  const path = env.SNAPSHOT_HIGH_CARD_SCHEMA_INVENTORY_REPORT || DEFAULT_REPORT_PATH
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  if (env.GITHUB_STEP_SUMMARY) {
    await appendFile(env.GITHUB_STEP_SUMMARY, [
      '## Legacy high-card D1 schema inventory',
      '',
      `Schema state: ${report.schemaState}; dependency clear: ${report.dependencyClear}; expected legacy shape: ${report.schemaMatchesExpectedLegacyShape}.`,
      `Owned objects: ${report.ownedObjects.length}; external dependencies: ${report.externalDependencies.length}; unexpected owned objects: ${report.unexpectedOwnedObjects.length}.`,
      '',
      '> This is read-only schema evidence. It does not prove #249 acceptance and does not authorize destructive retirement.',
      '',
    ].join('\n'))
  }
  return path
}

function safeName(value) {
  return typeof value === 'string' && SAFE_NAME.test(value) ? value : null
}

function safeText(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,160}$/.test(value) ? value : null
}

function required(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`)
  return value.trim()
}

async function main(env = process.env) {
  const report = await collectHighCardSchemaInventory({ env })
  const reportPath = await writeReport(report, env)
  console.log(JSON.stringify({
    event: 'snapshot_high_card_schema_inventory',
    reportPath,
    schemaState: report.schemaState,
    schemaMatchesExpectedLegacyShape: report.schemaMatchesExpectedLegacyShape,
    dependencyClear: report.dependencyClear,
    ownedObjectCount: report.ownedObjects.length,
    unexpectedOwnedObjectCount: report.unexpectedOwnedObjects.length,
    externalDependencyCount: report.externalDependencies.length,
  }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify({
      event: 'snapshot_high_card_schema_inventory_failed',
      message: error instanceof Error ? error.message : String(error),
    }))
    process.exitCode = 1
  })
}
