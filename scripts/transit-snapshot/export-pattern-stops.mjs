import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { AwsClient } from 'aws4fetch'
import { loadOperationalResources } from '../instance/operational-resources.mjs'
import { queryD1 } from './window-d1.mjs'

const DEFAULT_PAGE_SIZE = 2_000
const DEFAULT_WRITE_CONCURRENCY = 8
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export function buildPatternStopArtifact({ city, version, patternId, rows }) {
  if (!city || !version || !patternId) throw new Error('Pattern stop artifact metadata is required')
  if (!Array.isArray(rows) || rows.length < 2) {
    throw new Error(`Pattern ${patternId} must contain at least two stop occurrences`)
  }
  const stops = rows.map((row, index) => {
    if (row.pattern_id !== patternId) throw new Error(`Pattern stop row ${index} belongs to ${row.pattern_id}`)
    const stopSequence = Number(row.stop_sequence)
    const latitude = Number(row.latitude)
    const longitude = Number(row.longitude)
    if (!row.stop_uid || !row.place_id || !row.stop_name) throw new Error(`Pattern ${patternId} has incomplete stop row ${index}`)
    if (!Number.isSafeInteger(stopSequence) || stopSequence < 0) {
      throw new Error(`Pattern ${patternId} has invalid stop sequence ${row.stop_sequence}`)
    }
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      throw new Error(`Pattern ${patternId} has invalid stop coordinates`)
    }
    return Object.freeze({
      stopUid: row.stop_uid,
      placeId: row.place_id,
      stopSequence,
      name: row.stop_name,
      latitude,
      longitude,
    })
  })
  for (let index = 1; index < stops.length; index += 1) {
    if (stops[index - 1].stopSequence >= stops[index].stopSequence) {
      throw new Error(`Pattern ${patternId} stop sequence is not strictly increasing`)
    }
  }
  return Object.freeze({ schemaVersion: 1, city, version, patternId, stops })
}

export function patternStopArtifactKey(version, city, patternId) {
  return `snapshots/${version}/cities/${city}/patterns/${patternId}/stops.json`
}

export function patternStopExportManifestKey(version, city) {
  return `snapshots/${version}/cities/${city}/pattern-stops-export.json`
}

export function nextPatternStopCursor(rows, previous = { patternId: '', stopSequence: -1 }) {
  if (!Array.isArray(rows) || rows.length === 0) return previous
  const last = rows.at(-1)
  const stopSequence = Number(last.stop_sequence)
  if (!last.pattern_id || !Number.isSafeInteger(stopSequence)) throw new Error('Invalid pattern stop page cursor')
  if (last.pattern_id < previous.patternId
    || (last.pattern_id === previous.patternId && stopSequence <= previous.stopSequence)) {
    throw new Error('Pattern stop page cursor did not advance')
  }
  return Object.freeze({ patternId: last.pattern_id, stopSequence })
}

export async function exportPatternStops({
  city,
  target = 'active',
  env = process.env,
  fetchImpl = fetch,
  pageSize = DEFAULT_PAGE_SIZE,
  writeConcurrency = DEFAULT_WRITE_CONCURRENCY,
  now = () => new Date(),
}) {
  if (!city) throw new Error('City is required')
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 10_000) throw new Error('Invalid page size')
  if (!Number.isSafeInteger(writeConcurrency) || writeConcurrency < 1 || writeConcurrency > 32) {
    throw new Error('Invalid R2 write concurrency')
  }

  const resources = loadOperationalResources()
  const accountId = required(env.CLOUDFLARE_ACCOUNT_ID, 'CLOUDFLARE_ACCOUNT_ID')
  const apiToken = required(env.CLOUDFLARE_API_TOKEN, 'CLOUDFLARE_API_TOKEN')
  const databaseId = required(env.TRANSIT_DATABASE_ID ?? resources.d1DatabaseId, 'TRANSIT_DATABASE_ID')
  const bucket = required(env.TRANSIT_R2_BUCKET_NAME ?? resources.r2BucketName, 'TRANSIT_R2_BUCKET_NAME')
  const accessKeyId = required(env.R2_ACCESS_KEY_ID, 'R2_ACCESS_KEY_ID')
  const secretAccessKey = required(env.R2_SECRET_ACCESS_KEY, 'R2_SECRET_ACCESS_KEY')
  const r2 = new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' })
  const baseUrl = `https://${accountId}.r2.cloudflarestorage.com/${bucket}`
  const query = (sql, params) => queryD1({ accountId, apiToken, databaseId, fetchImpl, sql, params })
  const getR2Json = async (key) => {
    const response = await r2.fetch(objectUrl(baseUrl, key))
    if (!response.ok) {
      await response.arrayBuffer()
      throw new Error(`R2 GET ${key} failed (${response.status})`)
    }
    return response.json()
  }
  const putR2Json = async (key, value) => {
    const body = JSON.stringify(value)
    const response = await r2.fetch(objectUrl(baseUrl, key), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
    await response.arrayBuffer()
    if (!response.ok) throw new Error(`R2 PUT ${key} failed (${response.status})`)
    return Object.freeze({
      bytes: new TextEncoder().encode(body).byteLength,
      sha256: createHash('sha256').update(body).digest('hex'),
    })
  }

  const version = await resolveTargetVersion({ city, target, query, getR2Json })
  const expectedRows = await query(`
    SELECT COUNT(*) AS pattern_stops, COUNT(DISTINCT ps.pattern_id) AS patterns
    FROM pattern_stops ps
    JOIN patterns p ON p.version = ps.version AND p.pattern_id = ps.pattern_id
    WHERE ps.version = ? AND p.city_code = ?
  `, [version, city])
  const expectedPatternStops = Number(expectedRows[0]?.pattern_stops)
  const expectedPatterns = Number(expectedRows[0]?.patterns)
  if (!Number.isSafeInteger(expectedPatternStops) || expectedPatternStops <= 0
    || !Number.isSafeInteger(expectedPatterns) || expectedPatterns <= 0) {
    throw new Error(`No pattern stops found for ${city} ${version}`)
  }

  // Build and parity-check the complete logical export before issuing any R2 PUT.
  // This keeps a count mismatch at zero R2 writes. Pattern-stop payloads are small
  // enough for an Actions runner; R2 writes happen only after this gate passes.
  const stagedArtifacts = []
  let exportedPatternStops = 0
  let cursor = Object.freeze({ patternId: '', stopSequence: -1 })
  let currentPatternId = null
  let currentRows = []
  const flush = () => {
    if (!currentPatternId) return
    const artifact = buildPatternStopArtifact({ city, version, patternId: currentPatternId, rows: currentRows })
    stagedArtifacts.push(Object.freeze({
      patternId: currentPatternId,
      key: patternStopArtifactKey(version, city, currentPatternId),
      stops: artifact.stops.length,
      artifact,
    }))
    exportedPatternStops += artifact.stops.length
    currentPatternId = null
    currentRows = []
  }

  while (true) {
    const rows = await query(`
      SELECT
        ps.pattern_id,
        ps.stop_uid,
        ps.place_id,
        ps.stop_sequence,
        s.stop_name,
        s.latitude,
        s.longitude
      FROM pattern_stops ps
      JOIN patterns p ON p.version = ps.version AND p.pattern_id = ps.pattern_id
      JOIN stops s ON s.version = ps.version AND s.stop_uid = ps.stop_uid
      WHERE ps.version = ?
        AND p.city_code = ?
        AND (ps.pattern_id > ? OR (ps.pattern_id = ? AND ps.stop_sequence > ?))
      ORDER BY ps.pattern_id, ps.stop_sequence
      LIMIT ?
    `, [version, city, cursor.patternId, cursor.patternId, cursor.stopSequence, pageSize])
    if (!rows.length) break

    for (const row of rows) {
      if (currentPatternId !== null && row.pattern_id !== currentPatternId) flush()
      if (currentPatternId === null) currentPatternId = row.pattern_id
      currentRows.push(row)
    }
    cursor = nextPatternStopCursor(rows, cursor)
    if (rows.length < pageSize) break
  }
  flush()

  if (stagedArtifacts.length !== expectedPatterns || exportedPatternStops !== expectedPatternStops) {
    throw new Error(
      `Pattern stop export parity failed: ${stagedArtifacts.length}/${exportedPatternStops}`
      + ` != ${expectedPatterns}/${expectedPatternStops}`,
    )
  }

  const artifacts = await mapParallel(stagedArtifacts, writeConcurrency, async (item) => {
    const fingerprint = await putR2Json(item.key, item.artifact)
    return Object.freeze({
      patternId: item.patternId,
      key: item.key,
      stops: item.stops,
      ...fingerprint,
    })
  })

  const manifest = Object.freeze({
    schemaVersion: 1,
    kind: 'pattern-stop-export',
    city,
    version,
    generatedAt: now().toISOString(),
    patterns: artifacts.length,
    patternStops: exportedPatternStops,
    artifacts,
  })
  const manifestKey = patternStopExportManifestKey(version, city)
  await putR2Json(manifestKey, manifest)
  return Object.freeze({ city, version, manifestKey, patterns: artifacts.length, patternStops: exportedPatternStops })
}

async function resolveTargetVersion({ city, target, query, getR2Json }) {
  if (target === 'active') {
    const rows = await query('SELECT active_version FROM dataset_versions WHERE city_code = ?', [city])
    const version = rows[0]?.active_version
    if (!version) throw new Error(`No active snapshot for ${city}`)
    return version
  }
  if (target === 'previous') {
    const state = await getR2Json(`snapshots/state/${city}.json`)
    if (!state?.previousVersion) throw new Error(`No previous snapshot for ${city}`)
    return state.previousVersion
  }
  if (!SAFE_VERSION.test(target)) throw new Error('Invalid snapshot version')
  return target
}

async function mapParallel(items, concurrency, worker) {
  if (!items.length) return []
  const results = new Array(items.length)
  let nextIndex = 0
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = nextIndex
      nextIndex += 1
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

function objectUrl(baseUrl, key) {
  return `${baseUrl}/${key.split('/').map(encodeURIComponent).join('/')}`
}

function required(value, name) {
  if (!value) throw new Error(`${name} is required`)
  return value
}

async function main() {
  const city = process.argv[2]
  const target = process.argv[3] ?? 'active'
  const result = await exportPatternStops({ city, target })
  console.log(JSON.stringify({ event: 'pattern_stop_export_completed', ...result }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify({
      event: 'pattern_stop_export_failed',
      message: error instanceof Error ? error.message : String(error),
    }))
    process.exitCode = 1
  })
}
