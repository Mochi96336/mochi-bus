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

export const DEFAULT_TRANSFER_SHARD_COUNT = 16
const DEFAULT_READ_CONCURRENCY = 8
const DEFAULT_WRITE_CONCURRENCY = 8
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export function transferRoutingShardKey(version, city, shardIndex) {
  return `snapshots/${version}/cities/${city}/routing/transfers/shards/${String(shardIndex).padStart(2, '0')}.json`
}

export function transferRoutingExportManifestKey(version, city) {
  return `snapshots/${version}/cities/${city}/transfer-routing-export.json`
}

// FNV-1a keeps assignment deterministic without depending on locale or object order.
// The manifest also records every pattern -> shard mapping, so the Worker read path
// does not need to duplicate this hash implementation.
export function transferShardForPattern(patternId, shardCount = DEFAULT_TRANSFER_SHARD_COUNT) {
  validateShardCount(shardCount)
  if (typeof patternId !== 'string' || !patternId) throw new Error('Pattern ID is required')
  let hash = 0x811c9dc5
  for (let index = 0; index < patternId.length; index += 1) {
    hash ^= patternId.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) % shardCount
}

export function buildTransferRoutingShards({
  city,
  version,
  placeArtifacts,
  shardCount = DEFAULT_TRANSFER_SHARD_COUNT,
}) {
  if (!city || !version) throw new Error('Transfer routing artifact metadata is required')
  validateShardCount(shardCount)
  if (!Array.isArray(placeArtifacts) || placeArtifacts.length === 0) {
    throw new Error('Place routing artifacts are required')
  }

  const patterns = new Map()
  const occurrencesByPattern = new Map()
  const occurrenceKeys = new Set()
  const seenPlaces = new Set()
  let occurrences = 0

  for (const artifact of placeArtifacts) {
    if (!artifact?.place?.placeId || seenPlaces.has(artifact.place.placeId)) {
      throw new Error(`Duplicate or invalid place routing artifact ${artifact?.place?.placeId ?? 'unknown'}`)
    }
    seenPlaces.add(artifact.place.placeId)
    const localPatterns = new Map(artifact.patterns.map((pattern) => [pattern.patternId, pattern]))

    for (const pattern of artifact.patterns) {
      const existing = patterns.get(pattern.patternId)
      if (existing && !samePatternMetadata(existing, pattern)) {
        throw new Error(`Pattern ${pattern.patternId} metadata mismatch across place artifacts`)
      }
      if (!existing) patterns.set(pattern.patternId, pattern)
    }

    for (const occurrence of artifact.occurrences) {
      const pattern = localPatterns.get(occurrence.patternId)
      if (!pattern) throw new Error(`Place ${artifact.place.placeId} has unknown pattern occurrence ${occurrence.patternId}`)
      const key = `${occurrence.patternId}\u0000${occurrence.stopSequence}`
      if (occurrenceKeys.has(key)) {
        throw new Error(`Duplicate transfer occurrence ${occurrence.patternId} sequence ${occurrence.stopSequence}`)
      }
      occurrenceKeys.add(key)
      const rows = occurrencesByPattern.get(occurrence.patternId) ?? []
      rows.push(Object.freeze({
        placeId: artifact.place.placeId,
        placeName: artifact.place.name,
        latitude: artifact.place.latitude,
        longitude: artifact.place.longitude,
        stopSequence: occurrence.stopSequence,
      }))
      occurrencesByPattern.set(occurrence.patternId, rows)
      occurrences += 1
    }
  }

  const shardPatterns = Array.from({ length: shardCount }, () => [])
  const patternShards = []
  const sortedPatterns = [...patterns.values()].sort((left, right) => compareBinary(left.patternId, right.patternId))
  for (const pattern of sortedPatterns) {
    const patternOccurrences = occurrencesByPattern.get(pattern.patternId)
    if (!patternOccurrences?.length) throw new Error(`Pattern ${pattern.patternId} has no transfer occurrence`)
    patternOccurrences.sort((left, right) => left.stopSequence - right.stopSequence
      || compareBinary(left.placeId, right.placeId))
    const minSequence = patternOccurrences[0].stopSequence
    const maxSequence = patternOccurrences.at(-1).stopSequence
    if (minSequence !== pattern.minSequence || maxSequence !== pattern.maxSequence) {
      throw new Error(`Pattern ${pattern.patternId} sequence bounds mismatch`)
    }

    const shard = transferShardForPattern(pattern.patternId, shardCount)
    patternShards.push(Object.freeze({ patternId: pattern.patternId, shard }))
    shardPatterns[shard].push(Object.freeze({
      patternId: pattern.patternId,
      routeUid: pattern.routeUid,
      routeName: pattern.routeName,
      direction: pattern.direction,
      label: pattern.label,
      ...(pattern.subRouteUid ? { subRouteUid: pattern.subRouteUid } : {}),
      subRouteName: pattern.subRouteName,
      circular: pattern.circular,
      minSequence: pattern.minSequence,
      maxSequence: pattern.maxSequence,
      occurrences: patternOccurrences,
    }))
  }

  const shards = shardPatterns.map((shardPatternList, shardIndex) => Object.freeze({
    shard: shardIndex,
    key: transferRoutingShardKey(version, city, shardIndex),
    patterns: shardPatternList.length,
    occurrences: shardPatternList.reduce((sum, pattern) => sum + pattern.occurrences.length, 0),
    artifact: Object.freeze({
      schemaVersion: 1,
      kind: 'transfer-routing-shard',
      city,
      version,
      shard: shardIndex,
      shardCount,
      patterns: shardPatternList,
    }),
  }))

  return Object.freeze({
    shards,
    patternShards,
    places: seenPlaces.size,
    patterns: patterns.size,
    occurrences,
  })
}

export async function exportTransferRouting({
  city,
  target = 'active',
  env = process.env,
  fetchImpl = fetch,
  shardCount = DEFAULT_TRANSFER_SHARD_COUNT,
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

  // Read and fingerprint every place artifact before issuing any transfer-index PUT.
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

  const staged = buildTransferRoutingShards({ city, version, placeArtifacts, shardCount })
  if (staged.places !== upstream.places) {
    throw new Error(`Transfer routing place parity failed: ${staged.places} != ${upstream.places}`)
  }
  if (staged.patterns !== upstream.patterns) {
    throw new Error(`Transfer routing pattern parity failed: ${staged.patterns} != ${upstream.patterns}`)
  }
  if (staged.occurrences !== upstream.occurrences) {
    throw new Error(`Transfer routing occurrence parity failed: ${staged.occurrences} != ${upstream.occurrences}`)
  }

  const shards = await mapParallel(staged.shards, writeConcurrency, async (item) => {
    const fingerprint = await putR2Json(item.key, item.artifact)
    return Object.freeze({
      shard: item.shard,
      key: item.key,
      patterns: item.patterns,
      occurrences: item.occurrences,
      ...fingerprint,
    })
  })

  const manifest = Object.freeze({
    schemaVersion: 1,
    kind: 'transfer-routing-export',
    city,
    version,
    generatedAt: now().toISOString(),
    upstreamPlaceRoutingManifest: upstreamManifestKey,
    shardCount,
    places: staged.places,
    patterns: staged.patterns,
    occurrences: staged.occurrences,
    patternShards: staged.patternShards,
    shards,
  })
  const manifestKey = transferRoutingExportManifestKey(version, city)
  await putR2Json(manifestKey, manifest)

  return Object.freeze({
    city,
    version,
    manifestKey,
    shardCount,
    places: staged.places,
    patterns: staged.patterns,
    occurrences: staged.occurrences,
    shardBytes: shards.map((item) => item.bytes),
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

  const patternById = new Map()
  const patterns = []
  for (const raw of value.patterns) {
    if (!raw || typeof raw !== 'object'
      || typeof raw.patternId !== 'string' || !raw.patternId
      || typeof raw.routeUid !== 'string' || !raw.routeUid
      || typeof raw.routeName !== 'string' || !raw.routeName
      || ![0, 1, 2].includes(Number(raw.direction))
      || typeof raw.label !== 'string' || !raw.label
      || (raw.subRouteUid !== undefined && (typeof raw.subRouteUid !== 'string' || !raw.subRouteUid))
      || typeof raw.subRouteName !== 'string' || !raw.subRouteName
      || typeof raw.circular !== 'boolean'
      || !Number.isSafeInteger(Number(raw.minSequence)) || Number(raw.minSequence) < 0
      || !Number.isSafeInteger(Number(raw.maxSequence)) || Number(raw.maxSequence) < Number(raw.minSequence)
      || patternById.has(raw.patternId)) return null
    const pattern = Object.freeze({
      patternId: raw.patternId,
      routeUid: raw.routeUid,
      routeName: raw.routeName,
      direction: Number(raw.direction),
      label: raw.label,
      ...(raw.subRouteUid ? { subRouteUid: raw.subRouteUid } : {}),
      subRouteName: raw.subRouteName,
      circular: raw.circular,
      minSequence: Number(raw.minSequence),
      maxSequence: Number(raw.maxSequence),
    })
    patternById.set(pattern.patternId, pattern)
    patterns.push(pattern)
  }

  const occurrences = []
  const localKeys = new Set()
  const usedPatterns = new Set()
  for (const raw of value.occurrences) {
    const pattern = raw && typeof raw === 'object' && typeof raw.patternId === 'string'
      ? patternById.get(raw.patternId)
      : undefined
    const stopSequence = Number(raw?.stopSequence)
    if (!pattern
      || typeof raw.stopUid !== 'string' || !raw.stopUid
      || typeof raw.stopName !== 'string' || !raw.stopName
      || !Number.isSafeInteger(stopSequence)
      || stopSequence < pattern.minSequence || stopSequence > pattern.maxSequence) return null
    const key = `${pattern.patternId}\u0000${stopSequence}`
    if (localKeys.has(key)) return null
    localKeys.add(key)
    usedPatterns.add(pattern.patternId)
    occurrences.push(Object.freeze({
      patternId: pattern.patternId,
      stopSequence,
    }))
  }
  if (usedPatterns.size !== patternById.size) return null

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

function samePatternMetadata(left, right) {
  return left.patternId === right.patternId
    && left.routeUid === right.routeUid
    && left.routeName === right.routeName
    && left.direction === right.direction
    && left.label === right.label
    && left.subRouteUid === right.subRouteUid
    && left.subRouteName === right.subRouteName
    && left.circular === right.circular
    && left.minSequence === right.minSequence
    && left.maxSequence === right.maxSequence
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
  if (!Number.isSafeInteger(value) || value < 1 || value > 64) throw new Error('Invalid transfer shard count')
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
  const result = await exportTransferRouting({ city, target })
  console.log(JSON.stringify({ event: 'transfer_routing_export_completed', ...result }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify({
      event: 'transfer_routing_export_failed',
      message: error instanceof Error ? error.message : String(error),
    }))
    process.exitCode = 1
  })
}
