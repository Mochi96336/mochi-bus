import { memoryCacheGet, memoryCacheSet } from '../../lib/memory-cache'
import {
  getActiveSnapshotVersion,
  getStopPlaceByStopUid as getStopPlaceByStopUidFromD1,
  searchStopPlaces as searchStopPlacesFromD1,
  type TransitBindings,
} from './snapshot-repository'

const EXPORT_STATUS_TTL_SECONDS = 60
const SHA256_PATTERN = /^[a-f0-9]{64}$/

type StopLookupShardDescriptor = {
  shard: number
  key: string
  stops: number
  bytes: number
  sha256: string
}

type StopLookupManifest = {
  shardCount: number
  places: number
  stops: number
  occurrences: number
  shards: Map<number, StopLookupShardDescriptor>
}

type StopLookupRecord = {
  stopUid: string
  stopName: string
  normalizedName: string
  placeId: string
  placeName: string
  latitude: number
  longitude: number
}

type StopLookupShard = {
  shard: number
  stops: StopLookupRecord[]
}

export type StopLookupPlace = {
  placeId: string
  name: string
  latitude: number
  longitude: number
  distanceMeters?: number
}

function placeRoutingExportManifestKey(version: string, city: string): string {
  return `snapshots/${version}/cities/${city}/place-routing-export.json`
}

function stopLookupExportManifestKey(version: string, city: string): string {
  return `snapshots/${version}/cities/${city}/stop-lookup-export.json`
}

function stopLookupShardKey(version: string, city: string, shard: number): string {
  return `snapshots/${version}/cities/${city}/routing/stops/shards/${String(shard).padStart(2, '0')}.json`
}

function hasSnapshotBindings(env: TransitBindings): boolean {
  const bindings = env as Partial<TransitBindings>
  return Boolean(bindings.TRANSIT_DB && bindings.TRANSIT_SHAPES
    && typeof bindings.TRANSIT_SHAPES.get === 'function')
}

async function readStopLookupManifest(
  env: TransitBindings,
  city: string,
  version: string,
): Promise<StopLookupManifest | null> {
  const memoryKey = `transit/stop-lookup-export/${city}/${version}`
  const cached = memoryCacheGet<StopLookupManifest | 'missing'>(memoryKey)
  if (cached) return cached === 'missing' ? null : cached

  try {
    const object = await env.TRANSIT_SHAPES.get(stopLookupExportManifestKey(version, city))
    if (!object) {
      memoryCacheSet(memoryKey, 'missing', EXPORT_STATUS_TTL_SECONDS)
      return null
    }
    const parsed = parseStopLookupManifest(await object.json<unknown>(), city, version)
    if (parsed) memoryCacheSet(memoryKey, parsed, EXPORT_STATUS_TTL_SECONDS)
    return parsed
  } catch {
    // Migration reads remain fail-soft. Do not cache transient R2 failures.
    return null
  }
}

function parseStopLookupManifest(
  value: unknown,
  city: string,
  version: string,
): StopLookupManifest | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Record<string, unknown>
  const shardCount = Number(candidate.shardCount)
  const places = Number(candidate.places)
  const stops = Number(candidate.stops)
  const occurrences = Number(candidate.occurrences)
  if (candidate.schemaVersion !== 1
    || candidate.kind !== 'stop-lookup-export'
    || candidate.city !== city
    || candidate.version !== version
    || candidate.upstreamPlaceRoutingManifest !== placeRoutingExportManifestKey(version, city)
    || !Number.isSafeInteger(shardCount) || shardCount < 1 || shardCount > 32
    || !Number.isSafeInteger(places) || places <= 0
    || !Number.isSafeInteger(stops) || stops <= 0
    || !Number.isSafeInteger(occurrences) || occurrences < stops
    || !Array.isArray(candidate.shards) || candidate.shards.length !== shardCount) return null

  const shards = new Map<number, StopLookupShardDescriptor>()
  let shardStops = 0
  for (const raw of candidate.shards) {
    if (!raw || typeof raw !== 'object') return null
    const entry = raw as Record<string, unknown>
    const shard = Number(entry.shard)
    const entryStops = Number(entry.stops)
    const bytes = Number(entry.bytes)
    const sha256 = entry.sha256
    if (!Number.isSafeInteger(shard) || shard < 0 || shard >= shardCount
      || shards.has(shard)
      || entry.key !== stopLookupShardKey(version, city, shard)
      || !Number.isSafeInteger(entryStops) || entryStops < 0
      || !Number.isSafeInteger(bytes) || bytes <= 0
      || typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256)) return null
    shards.set(shard, {
      shard,
      key: entry.key as string,
      stops: entryStops,
      bytes,
      sha256,
    })
    shardStops += entryStops
  }
  if (shards.size !== shardCount || shardStops !== stops) return null

  return { shardCount, places, stops, occurrences, shards }
}

async function readStopLookupShard(
  env: TransitBindings,
  city: string,
  version: string,
  manifest: StopLookupManifest,
  descriptor: StopLookupShardDescriptor,
): Promise<StopLookupShard | null> {
  try {
    const object = await env.TRANSIT_SHAPES.get(descriptor.key)
    if (!object) return null
    const bytes = new Uint8Array(await object.arrayBuffer())
    if (bytes.byteLength !== descriptor.bytes) return null
    if (await sha256Hex(bytes) !== descriptor.sha256) return null
    const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown
    return parseStopLookupShard(value, city, version, manifest, descriptor)
  } catch {
    return null
  }
}

function parseStopLookupShard(
  value: unknown,
  city: string,
  version: string,
  manifest: StopLookupManifest,
  descriptor: StopLookupShardDescriptor,
): StopLookupShard | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Record<string, unknown>
  if (candidate.schemaVersion !== 1
    || candidate.kind !== 'stop-lookup-shard'
    || candidate.city !== city
    || candidate.version !== version
    || Number(candidate.shard) !== descriptor.shard
    || Number(candidate.shardCount) !== manifest.shardCount
    || !Array.isArray(candidate.stops)
    || candidate.stops.length !== descriptor.stops) return null

  const stops: StopLookupRecord[] = []
  let previousStopUid: string | null = null
  for (const raw of candidate.stops) {
    if (!raw || typeof raw !== 'object') return null
    const stop = raw as Record<string, unknown>
    const latitude = Number(stop.latitude)
    const longitude = Number(stop.longitude)
    if (typeof stop.stopUid !== 'string' || !stop.stopUid
      || typeof stop.stopName !== 'string' || !stop.stopName
      || typeof stop.normalizedName !== 'string'
      || typeof stop.placeId !== 'string' || !stop.placeId
      || typeof stop.placeName !== 'string' || !stop.placeName
      || !Number.isFinite(latitude) || !Number.isFinite(longitude)
      || stopLookupShardForUid(stop.stopUid, manifest.shardCount) !== descriptor.shard
      || (previousStopUid !== null && compareBinary(previousStopUid, stop.stopUid) >= 0)) return null
    previousStopUid = stop.stopUid
    stops.push({
      stopUid: stop.stopUid,
      stopName: stop.stopName,
      normalizedName: stop.normalizedName,
      placeId: stop.placeId,
      placeName: stop.placeName,
      latitude,
      longitude,
    })
  }

  return { shard: descriptor.shard, stops }
}

// Keep byte-for-byte equivalent to scripts/transit-snapshot/export-stop-lookup.mjs.
function normalizeStopName(value: string): string {
  return value.normalize('NFKC').replace(/[\s()（）]/g, '').toLowerCase()
    .replaceAll('臺', '台')
    .replace(/火車站|車站/g, '站')
    .replace(/站$/, '')
}

// Keep byte-for-byte equivalent to scripts/transit-snapshot/export-stop-lookup.mjs.
function stopLookupShardForUid(stopUid: string, shardCount: number): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < stopUid.length; index += 1) {
    hash ^= stopUid.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) % shardCount
}

function toSearchPlace(stop: StopLookupRecord): StopLookupPlace {
  return {
    placeId: stop.placeId,
    name: stop.placeName,
    latitude: stop.latitude,
    longitude: stop.longitude,
  }
}

function toExactPlace(stop: StopLookupRecord): StopLookupPlace {
  return { ...toSearchPlace(stop), distanceMeters: 0 }
}

function collectSearchPlaces(
  shards: StopLookupShard[],
  normalized: string,
  limit: number,
): StopLookupPlace[] {
  const prefixByPlace = new Map<string, StopLookupRecord>()
  for (const shard of shards) {
    for (const stop of shard.stops) {
      if (stop.normalizedName.startsWith(normalized) && !prefixByPlace.has(stop.placeId)) {
        prefixByPlace.set(stop.placeId, stop)
      }
    }
  }
  const prefix = [...prefixByPlace.values()]
    .sort(comparePlaceRecords)
    .slice(0, limit)
  if (prefix.length >= limit) return prefix.map(toSearchPlace)

  const seen = new Set(prefix.map((stop) => stop.placeId))
  const substringByPlace = new Map<string, StopLookupRecord>()
  for (const shard of shards) {
    for (const stop of shard.stops) {
      if (!seen.has(stop.placeId)
        && stop.normalizedName.includes(normalized)
        && !substringByPlace.has(stop.placeId)) {
        substringByPlace.set(stop.placeId, stop)
      }
    }
  }
  const substring = [...substringByPlace.values()]
    .sort(comparePlaceRecords)
    .slice(0, Math.max(0, limit - prefix.length))
  return [...prefix, ...substring].map(toSearchPlace)
}

function comparePlaceRecords(left: StopLookupRecord, right: StopLookupRecord): number {
  return compareBinary(left.placeName, right.placeName)
    || compareBinary(left.placeId, right.placeId)
}

function compareBinary(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digestInput = new Uint8Array(bytes.byteLength)
  digestInput.set(bytes)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', digestInput.buffer)
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * R2-first StopUID -> place lookup. The completed same-version manifest is the
 * gate. Exact lookups hash to one shard; unavailable or corrupt R2 authority
 * falls back as one complete operation to the legacy D1 join.
 */
export async function getStopPlaceByStopUid(
  env: TransitBindings,
  city: string,
  stopUid: string,
): Promise<StopLookupPlace | null> {
  if (!hasSnapshotBindings(env)) return getStopPlaceByStopUidFromD1(env, city, stopUid)

  const version = await getActiveSnapshotVersion(env, city)
  if (!version) return null
  const fallback = () => getStopPlaceByStopUidFromD1(env, city, stopUid)
  const manifest = await readStopLookupManifest(env, city, version)
  if (!manifest) return fallback()

  const shard = stopLookupShardForUid(stopUid, manifest.shardCount)
  const descriptor = manifest.shards.get(shard)
  if (!descriptor) return fallback()
  const artifact = await readStopLookupShard(env, city, version, manifest, descriptor)
  if (!artifact) return fallback()

  const stop = artifact.stops.find((candidate) => candidate.stopUid === stopUid)
  return stop ? toExactPlace(stop) : null
}

/**
 * R2-first stop search. Every fixed shard is fingerprinted and parsed before a
 * response is produced, then the legacy prefix-first / substring-fill behavior
 * is reconstructed in memory. Any incomplete shard set falls back wholesale to
 * the D1 implementation rather than returning partial search results.
 */
export async function searchStopPlaces(
  env: TransitBindings,
  city: string,
  query: string,
  limit = 10,
): Promise<StopLookupPlace[]> {
  if (!hasSnapshotBindings(env)) return searchStopPlacesFromD1(env, city, query, limit)

  const version = await getActiveSnapshotVersion(env, city)
  if (!version) return []
  const normalized = normalizeStopName(query)
  if (!normalized) return []
  const fallback = () => searchStopPlacesFromD1(env, city, query, limit)

  const manifest = await readStopLookupManifest(env, city, version)
  if (!manifest) return fallback()
  const descriptors = [...manifest.shards.values()]
    .sort((left, right) => left.shard - right.shard)
  const shards = await Promise.all(descriptors.map((descriptor) =>
    readStopLookupShard(env, city, version, manifest, descriptor)))
  if (shards.some((shard) => shard === null)) return fallback()

  return collectSearchPlaces(shards as StopLookupShard[], normalized, limit)
}

export type { TransitBindings }
