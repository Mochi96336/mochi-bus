import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { AwsClient } from 'aws4fetch'
import { loadOperationalResources } from '../instance/operational-resources.mjs'
import {
  placeRoutingArtifactKey,
  placeRoutingExportManifestKey,
} from './export-place-routing.mjs'
import { patternStopExportManifestKey } from './export-pattern-stops.mjs'
import { queryD1 } from './window-d1.mjs'

export const DEFAULT_STOP_LOOKUP_SHARD_COUNT = 16
const DEFAULT_READ_CONCURRENCY = 8
const DEFAULT_WRITE_CONCURRENCY = 8
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export function stopLookupShardKey(version, city, shardIndex) {
  return `snapshots/${version}/cities/${city}/routing/stops/shards/${String(shardIndex).padStart(2, '0')}.json`
}

export function stopLookupExportManifestKey(version, city) {
  return `snapshots/${version}/cities/${city}/stop-lookup-export.json`
}

export function normalizeStopName(value) {
  return String(value ?? '').normalize('NFKC').replace(/[\s()（）]/g, '').toLowerCase()
    .replaceAll('臺', '台')
    .replace(/火車站|車站/g, '站')
    .replace(/站$/, '')
}

// FNV-1a gives the Worker a cheap deterministic StopUID -> shard mapping, so an
// exact lookup only needs one shard object. Search can scan the fixed shard set.
export function stopLookupShardForUid(stopUid, shardCount = DEFAULT_STOP_LOOKUP_SHARD_COUNT) {
  validateShardCount(shardCount)
  if (typeof stopUid !== 'string' || !stopUid) throw new Error('Stop UID is required')
  let hash = 0x811c9dc5
  for (let index = 0; index < stopUid.length; index += 1) {
    hash ^= stopUid.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) % shardCount
}

export function buildStopLookupShards({
  city,
  version,
  placeArtifacts,
  shardCount = DEFAULT_STOP_LOOKUP_SHARD_COUNT,
}) {
  if (!city || !version) throw new Error('Stop lookup artifact metadata is required')
  validateShardCount(shardCount)
  if (!Array.isArray(placeArtifacts) || placeArtifacts.length === 0) {
    throw new Error('Place routing artifacts are required')
  }

  const stops = new Map()
  const seenPlaces = new Set()
  let occurrences = 0

  for (const artifact of placeArtifacts) {
    const place = artifact?.place
    if (!place?.placeId || seenPlaces.has(place.placeId)) {
      throw new Error(`Duplicate or invalid place routing artifact ${place?.placeId ?? 'unknown'}`)
    }
    seenPlaces.add(place.placeId)

    for (const occurrence of artifact.occurrences) {
      occurrences += 1
      const normalizedName = normalizeStopName(occurrence.stopName)
      const candidate = Object.freeze({
        stopUid: occurrence.stopUid,
        stopName: occurrence.stopName,
        normalizedName,
        placeId: place.placeId,
        placeName: place.name,
        latitude: place.latitude,
        longitude: place.longitude,
      })
      const existing = stops.get(candidate.stopUid)
      if (existing) {
        if (!sameStopMetadata(existing, candidate)) {
          throw new Error(`Stop UID ${candidate.stopUid} metadata mismatch across place artifacts`)
        }
        continue
      }
      stops.set(candidate.stopUid, candidate)
    }
  }

  if (stops.size === 0) throw new Error('No StopUID records found in place routing artifacts')

  const shardStops = Array.from({ length: shardCount }, () => [])
  for (const stop of [...stops.values()].sort((left, right) => compareBinary(left.stopUid, right.stopUid))) {
    const shard = stopLookupShardForUid(stop.stopUid, shardCount)
    shardStops[shard].push(stop)
  }

  const shards = shardStops.map((items, shardIndex) => Object.freeze({
    shard: shardIndex,
    key: stopLookupShardKey(version, city, shardIndex),
    stops: items.length,
    artifact: Object.freeze({
      schemaVersion: 1,
      kind: 'stop-lookup-shard',
      city,
      version,
      shard: shardIndex,
      shardCount,
      stops: items,
    }),
  }))

  return Object.freeze({
    shards,
    places: seenPlaces.size,
    stops: stops.size,
    occurrences,
  })
}

export async function exportStopLookup({
  city,
  target = 'active',
  env = process.env,
  fetchImpl = fetch,
  shardCount = DEFAULT_STOP_LOOKUP_SHARD_COUNT,
  readConcurrency = DEFAULT_READ_CONCURRENCY,
  writeConcurrency = DEFAULT_WRITE_CONCURRENCY,
  now = () => new Date(),
}) {
  if (!city) throw new Error('City is required')
  validateShardCount(shardCount)
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
  const upstreamManifestKey = placeRoutingExportManifestKey(version, city)
  const upstreamManifest = await getR2Json(upstreamManifestKey)
  const upstream = parsePlaceRoutingExportManifest(upstreamManifest, city, version)

  // Fingerprint and validate every place-routing artifact before issuing any PUT.
  // This makes the stop index fail closed if its upstream authority drifted.
  const placeArtifacts = await mapParallel(upstream.entries, readConcurrency, async (entry) => {
    const artifactRead = await readR2Json(entry.key)
    if (artifactRead.bytes !== entry.bytes || artifactRead.sha256 !== entry.sha256) {
      throw new Error(`Place ${entry.placeId} artifact fingerprint mismatch`)
    }
    const artifact = parsePlaceRoutingArtifact(artifactRead.value, city, version, entry.placeId)
    if (!artifact) throw new Error(`Invalid place routing artifact ${entry.placeId}`)
    if (artifact.patterns.length !== entry.patterns || artifact.occurrences.length !== entry.occurrences) {
      throw new Error(`Place ${entry.placeId} artifact count mismatch`)
    }
    return artifact
  })

  const staged = buildStopLookupShards({ city, version, placeArtifacts, shardCount })
  if (staged.places !== upstream.places) {
    throw new Error(`Stop lookup place parity failed: ${staged.places} != ${upstream.places}`)
  }
  if (staged.occurrences !== upstream.occurrences) {
    throw new Error(`Stop lookup occurrence parity failed: ${staged.occurrences} != ${upstream.occurrences}`)
  }

  const shards = await mapParallel(staged.shards, writeConcurrency, async (item) => {
    const fingerprint = await putR2Json(item.key, item.artifact)
    return Object.freeze({
      shard: item.shard,
      key: item.key,
      stops: item.stops,
      ...fingerprint,
    })
  })

  const manifest = Object.freeze({
    schemaVersion: 1,
    kind: 'stop-lookup-export',
    city,
    version,
    generatedAt: now().toISOString(),
    upstreamPlaceRoutingManifest: upstreamManifestKey,
    shardCount,
    places: staged.places,
    stops: staged.stops,
    occurrences: staged.occurrences,
    shards,
  })
  const manifestKey = stopLookupExportManifestKey(version, city)
  await putR2Json(manifestKey, manifest)

  return Object.freeze({
    city,
    version,
    manifestKey,
    shardCount,
    places: staged.places,
    stops: staged.stops,
    occurrences: staged.occurrences,
    shardBytes: shards.map((item) => item.bytes),
    shardStops: shards.map((item) => item.stops),
  })
}

function parsePlaceRoutingExportManifest(value, city, version) {
  if (!value || typeof value !== 'object'
    || value.schemaVersion !== 1
    || value.kind !== 'place-routing-export'
    || value.city !== city
    || value.version !== version
    || value.upstreamPatternStopManifest !== patternStopExportManifestKey(version, city)
    || !Number.isSafeInteger(Number(value.places)) || Number(value.places) <= 0
    || !Number.isSafeInteger(Number(value.patterns)) || Number(value.patterns) <= 0
    || !Number.isSafeInteger(Number(value.occurrences)) || Number(value.occurrences) <= 0
    || !Array.isArray(value.artifacts)
    || value.artifacts.length !== Number(value.places)) {
    throw new Error(`Invalid place routing export manifest for ${city} ${version}`)
  }

  const seen = new Set()
  let entryOccurrences = 0
  const entries = value.artifacts.map((entry, index) => {
    const patterns = Number(entry?.patterns)
    const occurrences = Number(entry?.occurrences)
    const bytes = Number(entry?.bytes)
    const sha256 = entry?.sha256
    if (!entry?.placeId || !entry?.key
      || !Number.isSafeInteger(patterns) || patterns <= 0
      || !Number.isSafeInteger(occurrences) || occurrences <= 0
      || !Number.isSafeInteger(bytes) || bytes <= 0
      || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) {
      throw new Error(`Invalid place routing export manifest entry ${index}`)
    }
    if (seen.has(entry.placeId)) throw new Error(`Duplicate place routing export ${entry.placeId}`)
    seen.add(entry.placeId)
    if (entry.key !== placeRoutingArtifactKey(version, city, entry.placeId)) {
      throw new Error(`Place routing export key mismatch for ${entry.placeId}`)
    }
    entryOccurrences += occurrences
    return Object.freeze({ placeId: entry.placeId, key: entry.key, patterns, occurrences, bytes, sha256 })
  })
  if (entryOccurrences !== Number(value.occurrences)) {
    throw new Error(`Place routing export occurrence parity failed: ${entryOccurrences} != ${value.occurrences}`)
  }
  return Object.freeze({
    entries,
    places: Number(value.places),
    patterns: Number(value.patterns),
    occurrences: Number(value.occurrences),
  })
}

function parsePlaceRoutingArtifact(value, city, version, placeId) {
  if (!value || typeof value !== 'object'
    || value.schemaVersion !== 1
    || value.kind !== 'place-routing'
    || value.city !== city
    || value.version !== version
    || !value.place || typeof value.place !== 'object'
    || value.place.placeId !== placeId
    || typeof value.place.name !== 'string' || !value.place.name
    || !Number.isFinite(Number(value.place.latitude))
    || !Number.isFinite(Number(value.place.longitude))
    || !Array.isArray(value.patterns) || value.patterns.length === 0
    || !Array.isArray(value.occurrences) || value.occurrences.length === 0) return null

  const patternIds = new Set()
  const patterns = []
  for (const raw of value.patterns) {
    if (!raw || typeof raw !== 'object'
      || typeof raw.patternId !== 'string' || !raw.patternId
      || patternIds.has(raw.patternId)) return null
    patternIds.add(raw.patternId)
    patterns.push(raw)
  }

  const occurrences = []
  for (const raw of value.occurrences) {
    if (!raw || typeof raw !== 'object'
      || typeof raw.patternId !== 'string' || !patternIds.has(raw.patternId)
      || typeof raw.stopUid !== 'string' || !raw.stopUid
      || typeof raw.stopName !== 'string' || !raw.stopName
      || !Number.isSafeInteger(Number(raw.stopSequence)) || Number(raw.stopSequence) < 0) return null
    occurrences.push(Object.freeze({
      patternId: raw.patternId,
      stopUid: raw.stopUid,
      stopSequence: Number(raw.stopSequence),
      stopName: raw.stopName,
    }))
  }

  return Object.freeze({
    place: Object.freeze({
      placeId,
      name: value.place.name,
      latitude: Number(value.place.latitude),
      longitude: Number(value.place.longitude),
    }),
    patterns,
    occurrences,
  })
}

function sameStopMetadata(left, right) {
  return left.stopUid === right.stopUid
    && left.stopName === right.stopName
    && left.normalizedName === right.normalizedName
    && left.placeId === right.placeId
    && left.placeName === right.placeName
    && left.latitude === right.latitude
    && left.longitude === right.longitude
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

function validateShardCount(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 32) {
    throw new Error('Invalid stop lookup shard count')
  }
}

function validateConcurrency(value, name) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 32) throw new Error(`Invalid ${name}`)
}

function compareBinary(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
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
  const result = await exportStopLookup({ city, target })
  console.log(JSON.stringify({ event: 'stop_lookup_export_completed', ...result }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify({
      event: 'stop_lookup_export_failed',
      message: error instanceof Error ? error.message : String(error),
    }))
    process.exitCode = 1
  })
}
