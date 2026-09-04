import { pairTransferLegs, type TransferLegCandidate, type TransferPlanResult } from '../../domain/map/transfer'
import { memoryCacheGet, memoryCacheSet } from '../../lib/memory-cache'
import {
  getActiveSnapshotVersion,
  getOneTransferRoutes as getOneTransferRoutesFromD1,
  type TransitBindings,
} from './snapshot-repository'

const EXPORT_STATUS_TTL_SECONDS = 60
const SHA256_PATTERN = /^[a-f0-9]{64}$/

type PlaceRoutingPattern = {
  patternId: string
  routeUid: string
  routeName: string
  direction: 0 | 1 | 2
  label: string
  subRouteUid?: string
  subRouteName: string
  shapeKey: string
  circular: boolean
  minSequence: number
  maxSequence: number
}

type PlaceRoutingOccurrence = {
  patternId: string
  stopUid: string
  stopSequence: number
  stopName: string
}

type PlaceRoutingArtifact = {
  place: {
    placeId: string
    name: string
    latitude: number
    longitude: number
  }
  patterns: PlaceRoutingPattern[]
  occurrences: PlaceRoutingOccurrence[]
}

type TransferRoutingOccurrence = {
  placeId: string
  placeName: string
  latitude: number
  longitude: number
  stopSequence: number
}

type TransferRoutingPattern = {
  patternId: string
  routeUid: string
  routeName: string
  direction: 0 | 1 | 2
  label: string
  subRouteUid?: string
  subRouteName: string
  circular: boolean
  minSequence: number
  maxSequence: number
  occurrences: TransferRoutingOccurrence[]
}

type TransferShardDescriptor = {
  shard: number
  key: string
  patterns: number
  occurrences: number
  bytes: number
  sha256: string
}

type TransferRoutingManifest = {
  shardCount: number
  places: number
  patterns: number
  occurrences: number
  patternShards: Map<string, number>
  shards: Map<number, TransferShardDescriptor>
}

type TransferRoutingShard = {
  shard: number
  patterns: TransferRoutingPattern[]
}

function placeRoutingArtifactKey(version: string, city: string, placeId: string): string {
  return `snapshots/${version}/cities/${city}/routing/places/${placeId}.json`
}

function placeRoutingExportManifestKey(version: string, city: string): string {
  return `snapshots/${version}/cities/${city}/place-routing-export.json`
}

function transferRoutingExportManifestKey(version: string, city: string): string {
  return `snapshots/${version}/cities/${city}/transfer-routing-export.json`
}

function transferRoutingShardKey(version: string, city: string, shard: number): string {
  return `snapshots/${version}/cities/${city}/routing/transfers/shards/${String(shard).padStart(2, '0')}.json`
}

function hasSnapshotBindings(env: TransitBindings): boolean {
  const bindings = env as Partial<TransitBindings>
  return Boolean(bindings.TRANSIT_DB && bindings.TRANSIT_SHAPES
    && typeof bindings.TRANSIT_SHAPES.get === 'function')
}

async function readTransferRoutingManifest(
  env: TransitBindings,
  city: string,
  version: string,
): Promise<TransferRoutingManifest | null> {
  const memoryKey = `transit/transfer-routing-export/${city}/${version}`
  const cached = memoryCacheGet<TransferRoutingManifest | 'missing'>(memoryKey)
  if (cached) return cached === 'missing' ? null : cached

  try {
    const object = await env.TRANSIT_SHAPES.get(transferRoutingExportManifestKey(version, city))
    if (!object) {
      memoryCacheSet(memoryKey, 'missing', EXPORT_STATUS_TTL_SECONDS)
      return null
    }
    const parsed = parseTransferRoutingManifest(await object.json<unknown>(), city, version)
    if (parsed) memoryCacheSet(memoryKey, parsed, EXPORT_STATUS_TTL_SECONDS)
    return parsed
  } catch {
    // Migration reads must remain fail-soft. Transient R2 failures are not cached.
    return null
  }
}

function parseTransferRoutingManifest(
  value: unknown,
  city: string,
  version: string,
): TransferRoutingManifest | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Record<string, unknown>
  const shardCount = Number(candidate.shardCount)
  const places = Number(candidate.places)
  const patterns = Number(candidate.patterns)
  const occurrences = Number(candidate.occurrences)
  if (candidate.schemaVersion !== 1
    || candidate.kind !== 'transfer-routing-export'
    || candidate.city !== city
    || candidate.version !== version
    || candidate.upstreamPlaceRoutingManifest !== placeRoutingExportManifestKey(version, city)
    || !Number.isSafeInteger(shardCount) || shardCount < 1 || shardCount > 64
    || !Number.isSafeInteger(places) || places <= 0
    || !Number.isSafeInteger(patterns) || patterns <= 0
    || !Number.isSafeInteger(occurrences) || occurrences <= 0
    || !Array.isArray(candidate.patternShards) || candidate.patternShards.length !== patterns
    || !Array.isArray(candidate.shards) || candidate.shards.length !== shardCount) return null

  const patternShards = new Map<string, number>()
  const patternCounts = new Array<number>(shardCount).fill(0)
  for (const raw of candidate.patternShards) {
    if (!raw || typeof raw !== 'object') return null
    const entry = raw as Record<string, unknown>
    const patternId = entry.patternId
    const shard = Number(entry.shard)
    if (typeof patternId !== 'string' || !patternId
      || !Number.isSafeInteger(shard) || shard < 0 || shard >= shardCount
      || patternShards.has(patternId)) return null
    patternShards.set(patternId, shard)
    patternCounts[shard] += 1
  }

  const shards = new Map<number, TransferShardDescriptor>()
  let shardPatterns = 0
  let shardOccurrences = 0
  for (const raw of candidate.shards) {
    if (!raw || typeof raw !== 'object') return null
    const entry = raw as Record<string, unknown>
    const shard = Number(entry.shard)
    const entryPatterns = Number(entry.patterns)
    const entryOccurrences = Number(entry.occurrences)
    const bytes = Number(entry.bytes)
    const sha256 = entry.sha256
    if (!Number.isSafeInteger(shard) || shard < 0 || shard >= shardCount
      || shards.has(shard)
      || entry.key !== transferRoutingShardKey(version, city, shard)
      || !Number.isSafeInteger(entryPatterns) || entryPatterns < 0
      || !Number.isSafeInteger(entryOccurrences) || entryOccurrences < 0
      || (entryPatterns === 0 && entryOccurrences !== 0)
      || (entryPatterns > 0 && entryOccurrences === 0)
      || !Number.isSafeInteger(bytes) || bytes <= 0
      || typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256)) return null
    shards.set(shard, {
      shard,
      key: entry.key as string,
      patterns: entryPatterns,
      occurrences: entryOccurrences,
      bytes,
      sha256,
    })
    shardPatterns += entryPatterns
    shardOccurrences += entryOccurrences
  }

  if (shards.size !== shardCount || shardPatterns !== patterns || shardOccurrences !== occurrences) return null
  for (let shard = 0; shard < shardCount; shard += 1) {
    const descriptor = shards.get(shard)
    if (!descriptor || descriptor.patterns !== patternCounts[shard]) return null
  }

  return { shardCount, places, patterns, occurrences, patternShards, shards }
}

async function readPlaceRoutingArtifact(
  env: TransitBindings,
  city: string,
  version: string,
  placeId: string,
): Promise<PlaceRoutingArtifact | null> {
  try {
    const object = await env.TRANSIT_SHAPES.get(placeRoutingArtifactKey(version, city, placeId))
    if (!object) return null
    return parsePlaceRoutingArtifact(await object.json<unknown>(), city, version, placeId)
  } catch {
    return null
  }
}

function parsePlaceRoutingArtifact(
  value: unknown,
  city: string,
  version: string,
  placeId: string,
): PlaceRoutingArtifact | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Record<string, unknown>
  const place = candidate.place
  if (candidate.schemaVersion !== 1
    || candidate.kind !== 'place-routing'
    || candidate.city !== city
    || candidate.version !== version
    || !place || typeof place !== 'object'
    || !Array.isArray(candidate.patterns) || candidate.patterns.length === 0
    || !Array.isArray(candidate.occurrences) || candidate.occurrences.length === 0) return null

  const rawPlace = place as Record<string, unknown>
  const latitude = Number(rawPlace.latitude)
  const longitude = Number(rawPlace.longitude)
  if (rawPlace.placeId !== placeId
    || typeof rawPlace.name !== 'string' || !rawPlace.name
    || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null

  const patterns: PlaceRoutingPattern[] = []
  const patternById = new Map<string, PlaceRoutingPattern>()
  for (const raw of candidate.patterns) {
    if (!raw || typeof raw !== 'object') return null
    const pattern = raw as Record<string, unknown>
    const minSequence = Number(pattern.minSequence)
    const maxSequence = Number(pattern.maxSequence)
    if (typeof pattern.patternId !== 'string' || !pattern.patternId
      || typeof pattern.routeUid !== 'string' || !pattern.routeUid
      || typeof pattern.routeName !== 'string' || !pattern.routeName
      || !isDirection(pattern.direction)
      || typeof pattern.label !== 'string' || !pattern.label
      || (pattern.subRouteUid !== undefined && (typeof pattern.subRouteUid !== 'string' || !pattern.subRouteUid))
      || typeof pattern.subRouteName !== 'string' || !pattern.subRouteName
      || typeof pattern.shapeKey !== 'string' || !pattern.shapeKey
      || typeof pattern.circular !== 'boolean'
      || !Number.isSafeInteger(minSequence) || minSequence < 0
      || !Number.isSafeInteger(maxSequence) || maxSequence < minSequence
      || patternById.has(pattern.patternId)) return null
    const parsed: PlaceRoutingPattern = {
      patternId: pattern.patternId,
      routeUid: pattern.routeUid,
      routeName: pattern.routeName,
      direction: pattern.direction,
      label: pattern.label,
      ...(pattern.subRouteUid ? { subRouteUid: pattern.subRouteUid as string } : {}),
      subRouteName: pattern.subRouteName,
      shapeKey: pattern.shapeKey,
      circular: pattern.circular,
      minSequence,
      maxSequence,
    }
    patterns.push(parsed)
    patternById.set(parsed.patternId, parsed)
  }

  const occurrences: PlaceRoutingOccurrence[] = []
  const occurrenceKeys = new Set<string>()
  const usedPatterns = new Set<string>()
  for (const raw of candidate.occurrences) {
    if (!raw || typeof raw !== 'object') return null
    const occurrence = raw as Record<string, unknown>
    const pattern = typeof occurrence.patternId === 'string'
      ? patternById.get(occurrence.patternId)
      : undefined
    const stopSequence = Number(occurrence.stopSequence)
    if (!pattern
      || typeof occurrence.stopUid !== 'string' || !occurrence.stopUid
      || typeof occurrence.stopName !== 'string' || !occurrence.stopName
      || !Number.isSafeInteger(stopSequence)
      || stopSequence < pattern.minSequence || stopSequence > pattern.maxSequence) return null
    const key = `${pattern.patternId}\u0000${stopSequence}`
    if (occurrenceKeys.has(key)) return null
    occurrenceKeys.add(key)
    usedPatterns.add(pattern.patternId)
    occurrences.push({
      patternId: pattern.patternId,
      stopUid: occurrence.stopUid,
      stopSequence,
      stopName: occurrence.stopName,
    })
  }
  if (usedPatterns.size !== patternById.size) return null

  return {
    place: { placeId, name: rawPlace.name, latitude, longitude },
    patterns,
    occurrences,
  }
}

async function readTransferRoutingShard(
  env: TransitBindings,
  city: string,
  version: string,
  manifest: TransferRoutingManifest,
  descriptor: TransferShardDescriptor,
): Promise<TransferRoutingShard | null> {
  try {
    const object = await env.TRANSIT_SHAPES.get(descriptor.key)
    if (!object) return null
    const bytes = new Uint8Array(await object.arrayBuffer())
    if (bytes.byteLength !== descriptor.bytes) return null
    if (await sha256Hex(bytes) !== descriptor.sha256) return null
    const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown
    return parseTransferRoutingShard(value, city, version, manifest, descriptor)
  } catch {
    return null
  }
}

function parseTransferRoutingShard(
  value: unknown,
  city: string,
  version: string,
  manifest: TransferRoutingManifest,
  descriptor: TransferShardDescriptor,
): TransferRoutingShard | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Record<string, unknown>
  if (candidate.schemaVersion !== 1
    || candidate.kind !== 'transfer-routing-shard'
    || candidate.city !== city
    || candidate.version !== version
    || Number(candidate.shard) !== descriptor.shard
    || Number(candidate.shardCount) !== manifest.shardCount
    || !Array.isArray(candidate.patterns)
    || candidate.patterns.length !== descriptor.patterns) return null

  const patterns: TransferRoutingPattern[] = []
  const seenPatterns = new Set<string>()
  let occurrences = 0
  for (const raw of candidate.patterns) {
    if (!raw || typeof raw !== 'object') return null
    const pattern = raw as Record<string, unknown>
    const minSequence = Number(pattern.minSequence)
    const maxSequence = Number(pattern.maxSequence)
    if (typeof pattern.patternId !== 'string' || !pattern.patternId
      || typeof pattern.routeUid !== 'string' || !pattern.routeUid
      || typeof pattern.routeName !== 'string' || !pattern.routeName
      || !isDirection(pattern.direction)
      || typeof pattern.label !== 'string' || !pattern.label
      || (pattern.subRouteUid !== undefined && (typeof pattern.subRouteUid !== 'string' || !pattern.subRouteUid))
      || typeof pattern.subRouteName !== 'string' || !pattern.subRouteName
      || typeof pattern.circular !== 'boolean'
      || !Number.isSafeInteger(minSequence) || minSequence < 0
      || !Number.isSafeInteger(maxSequence) || maxSequence < minSequence
      || seenPatterns.has(pattern.patternId)
      || !Array.isArray(pattern.occurrences) || pattern.occurrences.length === 0) return null

    const parsedOccurrences: TransferRoutingOccurrence[] = []
    const sequences = new Set<number>()
    for (const rawOccurrence of pattern.occurrences) {
      if (!rawOccurrence || typeof rawOccurrence !== 'object') return null
      const occurrence = rawOccurrence as Record<string, unknown>
      const stopSequence = Number(occurrence.stopSequence)
      const latitude = Number(occurrence.latitude)
      const longitude = Number(occurrence.longitude)
      if (typeof occurrence.placeId !== 'string' || !occurrence.placeId
        || typeof occurrence.placeName !== 'string' || !occurrence.placeName
        || !Number.isFinite(latitude) || !Number.isFinite(longitude)
        || !Number.isSafeInteger(stopSequence)
        || stopSequence < minSequence || stopSequence > maxSequence
        || sequences.has(stopSequence)) return null
      sequences.add(stopSequence)
      parsedOccurrences.push({
        placeId: occurrence.placeId,
        placeName: occurrence.placeName,
        latitude,
        longitude,
        stopSequence,
      })
    }
    parsedOccurrences.sort((left, right) => left.stopSequence - right.stopSequence)
    if (parsedOccurrences[0].stopSequence !== minSequence
      || parsedOccurrences.at(-1)?.stopSequence !== maxSequence) return null

    seenPatterns.add(pattern.patternId)
    occurrences += parsedOccurrences.length
    patterns.push({
      patternId: pattern.patternId,
      routeUid: pattern.routeUid,
      routeName: pattern.routeName,
      direction: pattern.direction,
      label: pattern.label,
      ...(pattern.subRouteUid ? { subRouteUid: pattern.subRouteUid as string } : {}),
      subRouteName: pattern.subRouteName,
      circular: pattern.circular,
      minSequence,
      maxSequence,
      occurrences: parsedOccurrences,
    })
  }
  if (occurrences !== descriptor.occurrences) return null
  return { shard: descriptor.shard, patterns }
}

function samePatternMetadata(endpoint: PlaceRoutingPattern, shard: TransferRoutingPattern): boolean {
  return endpoint.patternId === shard.patternId
    && endpoint.routeUid === shard.routeUid
    && endpoint.routeName === shard.routeName
    && endpoint.direction === shard.direction
    && endpoint.label === shard.label
    && endpoint.subRouteUid === shard.subRouteUid
    && endpoint.subRouteName === shard.subRouteName
    && endpoint.circular === shard.circular
    && endpoint.minSequence === shard.minSequence
    && endpoint.maxSequence === shard.maxSequence
}

function legStopCount(
  pattern: TransferRoutingPattern,
  boardSequence: number,
  alightSequence: number,
): number | null {
  if (boardSequence === alightSequence) return null
  if (alightSequence > boardSequence) return alightSequence - boardSequence
  if (!pattern.circular) return null
  return pattern.maxSequence - boardSequence
    + alightSequence - pattern.minSequence + 1
}

function groupOccurrences(occurrences: PlaceRoutingOccurrence[]): Map<string, PlaceRoutingOccurrence[]> {
  const grouped = new Map<string, PlaceRoutingOccurrence[]>()
  for (const occurrence of occurrences) {
    const rows = grouped.get(occurrence.patternId) ?? []
    rows.push(occurrence)
    grouped.set(occurrence.patternId, rows)
  }
  return grouped
}

function buildForwardCandidates(
  patterns: Map<string, TransferRoutingPattern>,
  endpointOccurrences: Map<string, PlaceRoutingOccurrence[]>,
): TransferLegCandidate[] {
  const candidates: TransferLegCandidate[] = []
  for (const [patternId, boards] of endpointOccurrences) {
    const pattern = patterns.get(patternId)
    if (!pattern) continue
    for (const board of boards) {
      for (const transfer of pattern.occurrences) {
        const stopCount = legStopCount(pattern, board.stopSequence, transfer.stopSequence)
        if (stopCount === null) continue
        candidates.push({
          patternId,
          routeUid: pattern.routeUid,
          routeName: pattern.routeName,
          label: pattern.label,
          placeId: transfer.placeId,
          placeName: transfer.placeName,
          latitude: transfer.latitude,
          longitude: transfer.longitude,
          boardSequence: board.stopSequence,
          alightSequence: transfer.stopSequence,
          stopCount,
        })
      }
    }
  }
  return candidates
}

function buildBackwardCandidates(
  patterns: Map<string, TransferRoutingPattern>,
  endpointOccurrences: Map<string, PlaceRoutingOccurrence[]>,
): TransferLegCandidate[] {
  const candidates: TransferLegCandidate[] = []
  for (const [patternId, alights] of endpointOccurrences) {
    const pattern = patterns.get(patternId)
    if (!pattern) continue
    for (const transfer of pattern.occurrences) {
      for (const alight of alights) {
        const stopCount = legStopCount(pattern, transfer.stopSequence, alight.stopSequence)
        if (stopCount === null) continue
        candidates.push({
          patternId,
          routeUid: pattern.routeUid,
          routeName: pattern.routeName,
          label: pattern.label,
          placeId: transfer.placeId,
          placeName: transfer.placeName,
          latitude: transfer.latitude,
          longitude: transfer.longitude,
          boardSequence: transfer.stopSequence,
          alightSequence: alight.stopSequence,
          stopCount,
        })
      }
    }
  }
  return candidates
}

function isDirection(value: unknown): value is 0 | 1 | 2 {
  return value === 0 || value === 1 || value === 2
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * R2-first one-transfer routing. The completion manifest is the version-level
 * gate. Endpoint place artifacts select the relevant patterns; the manifest
 * maps those patterns to at most 16 fixed shards. Missing, corrupt, or
 * inconsistent R2 state falls back as one complete operation to the legacy D1
 * expansion instead of mixing authorities inside one response.
 */
export async function getOneTransferRoutes(
  env: TransitBindings,
  city: string,
  fromPlaceId: string,
  toPlaceId: string,
): Promise<TransferPlanResult[]> {
  if (!hasSnapshotBindings(env)) return getOneTransferRoutesFromD1(env, city, fromPlaceId, toPlaceId)

  const version = await getActiveSnapshotVersion(env, city)
  if (!version || fromPlaceId === toPlaceId) return []
  const fallback = () => getOneTransferRoutesFromD1(env, city, fromPlaceId, toPlaceId)

  const manifest = await readTransferRoutingManifest(env, city, version)
  if (!manifest) return fallback()

  const [fromArtifact, toArtifact] = await Promise.all([
    readPlaceRoutingArtifact(env, city, version, fromPlaceId),
    readPlaceRoutingArtifact(env, city, version, toPlaceId),
  ])
  if (!fromArtifact || !toArtifact) return fallback()

  const fromOccurrences = groupOccurrences(fromArtifact.occurrences)
  const toOccurrences = groupOccurrences(toArtifact.occurrences)
  const requiredPatternIds = new Set([...fromOccurrences.keys(), ...toOccurrences.keys()])
  const requiredShardIds = new Set<number>()
  for (const patternId of requiredPatternIds) {
    const shard = manifest.patternShards.get(patternId)
    if (shard === undefined) return fallback()
    requiredShardIds.add(shard)
  }

  const descriptors: TransferShardDescriptor[] = []
  for (const shard of [...requiredShardIds].sort((left, right) => left - right)) {
    const descriptor = manifest.shards.get(shard)
    if (!descriptor) return fallback()
    descriptors.push(descriptor)
  }
  const shards = await Promise.all(descriptors.map((descriptor) =>
    readTransferRoutingShard(env, city, version, manifest, descriptor)))
  if (shards.some((shard) => shard === null)) return fallback()

  const patterns = new Map<string, TransferRoutingPattern>()
  for (const shard of shards as TransferRoutingShard[]) {
    for (const pattern of shard.patterns) {
      if (manifest.patternShards.get(pattern.patternId) !== shard.shard || patterns.has(pattern.patternId)) {
        return fallback()
      }
      patterns.set(pattern.patternId, pattern)
    }
  }

  const fromPatternById = new Map(fromArtifact.patterns.map((pattern) => [pattern.patternId, pattern]))
  const toPatternById = new Map(toArtifact.patterns.map((pattern) => [pattern.patternId, pattern]))
  for (const patternId of requiredPatternIds) {
    const shardPattern = patterns.get(patternId)
    if (!shardPattern) return fallback()
    const fromPattern = fromPatternById.get(patternId)
    const toPattern = toPatternById.get(patternId)
    if ((fromPattern && !samePatternMetadata(fromPattern, shardPattern))
      || (toPattern && !samePatternMetadata(toPattern, shardPattern))) return fallback()
  }

  return pairTransferLegs(
    buildForwardCandidates(patterns, fromOccurrences),
    buildBackwardCandidates(patterns, toOccurrences),
  )
}

export type { TransitBindings }
