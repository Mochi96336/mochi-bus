import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { AwsClient } from 'aws4fetch'
import { loadOperationalResources } from '../instance/operational-resources.mjs'
import {
  patternStopArtifactKey,
  patternStopExportManifestKey,
} from './export-pattern-stops.mjs'
import { queryD1 } from './window-d1.mjs'

const DEFAULT_READ_CONCURRENCY = 8
const DEFAULT_WRITE_CONCURRENCY = 8
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
// Keep this identical to src/domain/map/journey-segment.ts. The exporter stores
// the result so request-time direct routing never needs an extra shape R2 read.
const CIRCULAR_SHAPE_MAX_GAP_METERS = 500

export function placeRoutingArtifactKey(version, city, placeId) {
  return `snapshots/${version}/cities/${city}/routing/places/${placeId}.json`
}

export function placeRoutingExportManifestKey(version, city) {
  return `snapshots/${version}/cities/${city}/place-routing-export.json`
}

export function isCircularRouteShape(coordinates) {
  if (!Array.isArray(coordinates) || coordinates.length < 4) return false
  const first = coordinates[0]
  const last = coordinates.at(-1)
  if (!isCoordinate(first) || !isCoordinate(last)) return false
  const latitude = (first[1] + last[1]) * Math.PI / 360
  const longitudeMeters = (first[0] - last[0]) * Math.cos(latitude) * 111_320
  const latitudeMeters = (first[1] - last[1]) * 110_574
  return Math.hypot(longitudeMeters, latitudeMeters) <= CIRCULAR_SHAPE_MAX_GAP_METERS
}

export function buildPlaceRoutingArtifacts({ city, version, patterns, places, resolvedPatterns }) {
  if (!city || !version) throw new Error('Place routing artifact metadata is required')
  if (!Array.isArray(patterns) || patterns.length === 0) throw new Error('Pattern metadata is required')
  if (!Array.isArray(places) || places.length === 0) throw new Error('Stop place metadata is required')
  if (!Array.isArray(resolvedPatterns) || resolvedPatterns.length !== patterns.length) {
    throw new Error('Resolved pattern metadata is incomplete')
  }

  const patternById = new Map()
  for (const row of patterns) {
    if (!row.pattern_id || !row.route_uid || !row.route_name || !row.subroute_name
      || !row.departure_name || !row.destination_name || !row.shape_key
      || ![0, 1, 2].includes(Number(row.direction))) {
      throw new Error(`Incomplete pattern metadata for ${row.pattern_id ?? 'unknown'}`)
    }
    if (patternById.has(row.pattern_id)) throw new Error(`Duplicate pattern metadata ${row.pattern_id}`)
    patternById.set(row.pattern_id, Object.freeze({
      patternId: row.pattern_id,
      routeUid: row.route_uid,
      routeName: row.route_name,
      direction: Number(row.direction),
      label: `${row.departure_name} → ${row.destination_name}`,
      subRouteUid: row.subroute_uid || undefined,
      subRouteName: row.subroute_name,
      shapeKey: row.shape_key,
    }))
  }

  const placeById = new Map()
  for (const row of places) {
    const latitude = Number(row.latitude)
    const longitude = Number(row.longitude)
    if (!row.place_id || !row.place_name || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      throw new Error(`Incomplete stop place metadata for ${row.place_id ?? 'unknown'}`)
    }
    if (placeById.has(row.place_id)) throw new Error(`Duplicate stop place metadata ${row.place_id}`)
    placeById.set(row.place_id, Object.freeze({
      placeId: row.place_id,
      name: row.place_name,
      latitude,
      longitude,
    }))
  }

  const builders = new Map([...placeById.entries()].map(([placeId, place]) => [placeId, {
    place,
    patterns: new Map(),
    occurrences: [],
  }]))
  const resolvedIds = new Set()
  let occurrences = 0

  for (const resolved of resolvedPatterns) {
    if (!resolved?.patternId || resolvedIds.has(resolved.patternId)) {
      throw new Error(`Duplicate or invalid resolved pattern ${resolved?.patternId ?? 'unknown'}`)
    }
    resolvedIds.add(resolved.patternId)
    const metadata = patternById.get(resolved.patternId)
    if (!metadata) throw new Error(`Pattern artifact ${resolved.patternId} has no D1 metadata`)
    if (resolved.shapeKey !== metadata.shapeKey) throw new Error(`Pattern ${resolved.patternId} shape key mismatch`)
    const stops = parsePatternStops(resolved.artifact, city, version, resolved.patternId)
    const minSequence = stops[0].stopSequence
    const maxSequence = stops.at(-1).stopSequence
    const pattern = Object.freeze({
      ...metadata,
      circular: Boolean(resolved.circular),
      minSequence,
      maxSequence,
    })

    for (const stop of stops) {
      const builder = builders.get(stop.placeId)
      if (!builder) throw new Error(`Pattern ${resolved.patternId} references unknown place ${stop.placeId}`)
      builder.patterns.set(resolved.patternId, pattern)
      // Do not deduplicate by StopUID: a circular pattern can visit the same stop
      // more than once at different sequences, and direct routing needs both.
      builder.occurrences.push(Object.freeze({
        patternId: resolved.patternId,
        stopUid: stop.stopUid,
        stopSequence: stop.stopSequence,
        stopName: stop.name,
      }))
      occurrences += 1
    }
  }
  if (resolvedIds.size !== patternById.size
    || [...patternById.keys()].some((patternId) => !resolvedIds.has(patternId))) {
    throw new Error('Resolved pattern metadata is incomplete')
  }

  const artifacts = []
  for (const [placeId, builder] of builders) {
    if (builder.occurrences.length === 0) throw new Error(`Stop place ${placeId} has no pattern occurrence`)
    const patternList = [...builder.patterns.values()]
      .sort((a, b) => a.patternId.localeCompare(b.patternId))
    const occurrenceList = [...builder.occurrences]
      .sort((a, b) => a.patternId.localeCompare(b.patternId)
        || a.stopSequence - b.stopSequence
        || a.stopUid.localeCompare(b.stopUid))
    artifacts.push(Object.freeze({
      placeId,
      key: placeRoutingArtifactKey(version, city, placeId),
      artifact: Object.freeze({
        schemaVersion: 1,
        kind: 'place-routing',
        city,
        version,
        place: builder.place,
        patterns: patternList,
        occurrences: occurrenceList,
      }),
      patterns: patternList.length,
      occurrences: occurrenceList.length,
    }))
  }
  artifacts.sort((a, b) => a.placeId.localeCompare(b.placeId))
  return Object.freeze({ artifacts, occurrences })
}

export async function exportPlaceRouting({
  city,
  target = 'active',
  env = process.env,
  fetchImpl = fetch,
  readConcurrency = DEFAULT_READ_CONCURRENCY,
  writeConcurrency = DEFAULT_WRITE_CONCURRENCY,
  now = () => new Date(),
}) {
  if (!city) throw new Error('City is required')
  validateConcurrency(readConcurrency, 'R2 read concurrency')
  validateConcurrency(writeConcurrency, 'R2 write concurrency')

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
  const readR2Json = async (key) => {
    const response = await r2.fetch(objectUrl(baseUrl, key))
    const body = await response.text()
    if (!response.ok) throw new Error(`R2 GET ${key} failed (${response.status})`)
    let value
    try {
      value = JSON.parse(body)
    } catch {
      throw new Error(`R2 GET ${key} returned invalid JSON`)
    }
    return Object.freeze({
      value,
      bytes: new TextEncoder().encode(body).byteLength,
      sha256: createHash('sha256').update(body).digest('hex'),
    })
  }
  const getR2Json = async (key) => (await readR2Json(key)).value
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
  const upstreamManifestKey = patternStopExportManifestKey(version, city)
  const upstreamManifest = await getR2Json(upstreamManifestKey)
  const upstreamEntries = parsePatternExportManifest(upstreamManifest, city, version)

  const [patterns, places] = await Promise.all([
    query(`
      SELECT p.pattern_id, p.route_uid, p.subroute_uid, p.subroute_name, p.direction,
        p.departure_name, p.destination_name, p.shape_key, r.route_name
      FROM patterns p
      JOIN routes r ON r.version = p.version AND r.route_uid = p.route_uid
      WHERE p.version = ? AND p.city_code = ?
      ORDER BY p.pattern_id
    `, [version, city]),
    query(`
      SELECT place_id, place_name, latitude, longitude
      FROM stop_places
      WHERE version = ? AND city_code = ?
      ORDER BY place_id
    `, [version, city]),
  ])
  if (patterns.length !== upstreamEntries.length) {
    throw new Error(`Place routing pattern parity failed: ${patterns.length} != ${upstreamEntries.length}`)
  }
  if (!places.length) throw new Error(`No stop places found for ${city} ${version}`)

  // Resolve every upstream pattern and its route shape before issuing any R2 PUT.
  const metadataByPattern = new Map(patterns.map((row) => [row.pattern_id, row]))
  if (metadataByPattern.size !== patterns.length) throw new Error('Duplicate D1 pattern metadata')
  const resolvedPatterns = await mapParallel(upstreamEntries, readConcurrency, async (entry) => {
    const metadata = metadataByPattern.get(entry.patternId)
    if (!metadata) throw new Error(`Pattern export ${entry.patternId} has no D1 metadata`)
    const [artifactRead, shape] = await Promise.all([
      readR2Json(entry.key),
      getR2Json(metadata.shape_key),
    ])
    if (artifactRead.bytes !== entry.bytes || artifactRead.sha256 !== entry.sha256) {
      throw new Error(`Pattern ${entry.patternId} artifact fingerprint mismatch`)
    }
    const artifact = artifactRead.value
    const stops = parsePatternStops(artifact, city, version, entry.patternId)
    if (stops.length !== entry.stops) {
      throw new Error(`Pattern ${entry.patternId} stop count mismatch: ${stops.length} != ${entry.stops}`)
    }
    const coordinates = shape?.geometry?.coordinates
    if (shape?.type !== 'Feature' || shape?.geometry?.type !== 'LineString'
      || !Array.isArray(coordinates) || coordinates.length < 2
      || coordinates.some((point) => !isCoordinate(point))) {
      throw new Error(`Pattern ${entry.patternId} has invalid route shape`)
    }
    return Object.freeze({
      patternId: entry.patternId,
      shapeKey: metadata.shape_key,
      circular: isCircularRouteShape(coordinates),
      artifact,
    })
  })

  const staged = buildPlaceRoutingArtifacts({ city, version, patterns, places, resolvedPatterns })
  const expectedOccurrences = Number(upstreamManifest.patternStops)
  if (!Number.isSafeInteger(expectedOccurrences) || expectedOccurrences <= 0
    || staged.occurrences !== expectedOccurrences) {
    throw new Error(`Place routing occurrence parity failed: ${staged.occurrences} != ${expectedOccurrences}`)
  }
  if (staged.artifacts.length !== places.length) {
    throw new Error(`Place routing place parity failed: ${staged.artifacts.length} != ${places.length}`)
  }

  const artifacts = await mapParallel(staged.artifacts, writeConcurrency, async (item) => {
    const fingerprint = await putR2Json(item.key, item.artifact)
    return Object.freeze({
      placeId: item.placeId,
      key: item.key,
      patterns: item.patterns,
      occurrences: item.occurrences,
      ...fingerprint,
    })
  })

  const manifest = Object.freeze({
    schemaVersion: 1,
    kind: 'place-routing-export',
    city,
    version,
    generatedAt: now().toISOString(),
    upstreamPatternStopManifest: upstreamManifestKey,
    places: artifacts.length,
    patterns: upstreamEntries.length,
    occurrences: staged.occurrences,
    artifacts,
  })
  const manifestKey = placeRoutingExportManifestKey(version, city)
  await putR2Json(manifestKey, manifest)
  return Object.freeze({
    city,
    version,
    manifestKey,
    places: artifacts.length,
    patterns: upstreamEntries.length,
    occurrences: staged.occurrences,
  })
}

function parsePatternExportManifest(value, city, version) {
  if (!value || typeof value !== 'object'
    || value.schemaVersion !== 1
    || value.kind !== 'pattern-stop-export'
    || value.city !== city
    || value.version !== version
    || !Number.isSafeInteger(Number(value.patterns))
    || Number(value.patterns) <= 0
    || !Number.isSafeInteger(Number(value.patternStops))
    || Number(value.patternStops) <= 0
    || !Array.isArray(value.artifacts)
    || value.artifacts.length !== Number(value.patterns)) {
    throw new Error(`Invalid pattern stop export manifest for ${city} ${version}`)
  }
  const seen = new Set()
  let entryStops = 0
  const entries = value.artifacts.map((entry, index) => {
    const stops = Number(entry?.stops)
    const bytes = Number(entry?.bytes)
    const sha256 = entry?.sha256
    if (!entry?.patternId || !entry?.key || !Number.isSafeInteger(stops) || stops < 2
      || !Number.isSafeInteger(bytes) || bytes <= 0
      || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) {
      throw new Error(`Invalid pattern stop export manifest entry ${index}`)
    }
    if (seen.has(entry.patternId)) throw new Error(`Duplicate pattern stop export ${entry.patternId}`)
    seen.add(entry.patternId)
    const expectedKey = patternStopArtifactKey(version, city, entry.patternId)
    if (entry.key !== expectedKey) {
      throw new Error(`Pattern stop export key mismatch for ${entry.patternId}`)
    }
    entryStops += stops
    return Object.freeze({ patternId: entry.patternId, key: entry.key, stops, bytes, sha256 })
  })
  if (entryStops !== Number(value.patternStops)) {
    throw new Error(`Pattern stop export occurrence parity failed: ${entryStops} != ${value.patternStops}`)
  }
  return entries
}

function parsePatternStops(value, city, version, patternId) {
  if (!value || typeof value !== 'object'
    || value.schemaVersion !== 1
    || value.city !== city
    || value.version !== version
    || value.patternId !== patternId
    || !Array.isArray(value.stops)
    || value.stops.length < 2) {
    throw new Error(`Invalid pattern stop artifact ${patternId}`)
  }
  let previousSequence = -1
  return value.stops.map((stop, index) => {
    const stopSequence = Number(stop?.stopSequence)
    const latitude = Number(stop?.latitude)
    const longitude = Number(stop?.longitude)
    if (!stop?.stopUid || !stop?.placeId || !stop?.name
      || !Number.isSafeInteger(stopSequence) || stopSequence < 0 || stopSequence <= previousSequence
      || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      throw new Error(`Invalid pattern stop artifact ${patternId} row ${index}`)
    }
    previousSequence = stopSequence
    return Object.freeze({
      stopUid: stop.stopUid,
      placeId: stop.placeId,
      stopSequence,
      name: stop.name,
      latitude,
      longitude,
    })
  })
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

function validateConcurrency(value, name) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 32) throw new Error(`Invalid ${name}`)
}

function isCoordinate(value) {
  return Array.isArray(value) && value.length >= 2
    && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]))
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
  const result = await exportPlaceRouting({ city, target })
  console.log(JSON.stringify({ event: 'place_routing_export_completed', ...result }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify({
      event: 'place_routing_export_failed',
      message: error instanceof Error ? error.message : String(error),
    }))
    process.exitCode = 1
  })
}
