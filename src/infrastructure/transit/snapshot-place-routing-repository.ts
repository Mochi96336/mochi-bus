import { memoryCacheGet, memoryCacheSet } from '../../lib/memory-cache'
import {
  getActiveSnapshotVersion,
  getDirectRoutes as getDirectRoutesFromD1,
  getStopPlaceRoutes as getStopPlaceRoutesFromD1,
  type TransitBindings,
} from './snapshot-repository'

const EXPORT_STATUS_TTL_SECONDS = 60

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
  schemaVersion: 1
  kind: 'place-routing'
  city: string
  version: string
  place: {
    placeId: string
    name: string
    latitude: number
    longitude: number
  }
  patterns: PlaceRoutingPattern[]
  occurrences: PlaceRoutingOccurrence[]
}

export type PlaceRoutingFallbackReason =
  | 'manifest_missing'
  | 'manifest_read_failed'
  | 'routing_authority_incomplete'
  | 'routing_authority_invalid'
  | 'r2'

export type PlaceRoutingFallbackObservation = Readonly<{
  city: string
  snapshotVersion: string
  reason: PlaceRoutingFallbackReason
}>

export type PlaceRoutingFallbackObserver = (observation: PlaceRoutingFallbackObservation) => void

export type StopPlaceRoute = {
  routeUid: string
  routeName: string
  variantKey: string
  direction: 0 | 1 | 2
  label: string
  subRouteUid?: string
  subRouteName: string
  stopUid: string
  stopSequence: number
  stopName: string
}

export type DirectRoute = {
  routeName: string
  variantKey: string
  direction: 0 | 1 | 2
  label: string
  subRouteName: string
  boardSequence: number
  alightSequence: number
  stopCount: number
}

function placeRoutingArtifactKey(version: string, city: string, placeId: string): string {
  return `snapshots/${version}/cities/${city}/routing/places/${placeId}.json`
}

function placeRoutingExportManifestKey(version: string, city: string): string {
  return `snapshots/${version}/cities/${city}/place-routing-export.json`
}

function hasSnapshotBindings(env: TransitBindings): boolean {
  const bindings = env as Partial<TransitBindings>
  return Boolean(bindings.TRANSIT_DB && bindings.TRANSIT_SHAPES
    && typeof bindings.TRANSIT_SHAPES.head === 'function'
    && typeof bindings.TRANSIT_SHAPES.get === 'function')
}

function createFallbackReporter(
  observer: PlaceRoutingFallbackObserver | undefined,
  city: string,
  version: string,
): (reason: PlaceRoutingFallbackReason) => void {
  let reported = false
  return (reason) => {
    if (reported || !observer) return
    reported = true
    try {
      observer({ city, snapshotVersion: version, reason })
    } catch {
      // Observability must never make the compatibility fallback unavailable.
    }
  }
}

function preferredArtifactFallbackReason(
  ...reasons: Array<PlaceRoutingFallbackReason | null>
): PlaceRoutingFallbackReason | null {
  for (const reason of [
    'routing_authority_invalid',
    'routing_authority_incomplete',
    'r2',
  ] as const) {
    if (reasons.includes(reason)) return reason
  }
  return null
}

async function hasPlaceRoutingExport(
  env: TransitBindings,
  city: string,
  version: string,
  reportFallback: (reason: PlaceRoutingFallbackReason) => void,
): Promise<boolean> {
  const memoryKey = `transit/place-routing-export/${city}/${version}`
  const cached = memoryCacheGet<'ready' | 'missing'>(memoryKey)
  if (cached) {
    if (cached === 'missing') reportFallback('manifest_missing')
    return cached === 'ready'
  }

  try {
    const manifest = await env.TRANSIT_SHAPES.head(placeRoutingExportManifestKey(version, city))
    const state = manifest ? 'ready' : 'missing'
    memoryCacheSet(memoryKey, state, EXPORT_STATUS_TTL_SECONDS)
    if (state === 'missing') reportFallback('manifest_missing')
    return state === 'ready'
  } catch {
    // Migration reads must remain fail-soft. Do not cache transient R2 errors.
    reportFallback('manifest_read_failed')
    return false
  }
}

async function readPlaceRoutingArtifact(
  env: TransitBindings,
  city: string,
  version: string,
  placeId: string,
  reportFallback: (reason: PlaceRoutingFallbackReason) => void,
): Promise<PlaceRoutingArtifact | null> {
  let object: R2ObjectBody | null
  try {
    object = await env.TRANSIT_SHAPES.get(placeRoutingArtifactKey(version, city, placeId))
  } catch {
    reportFallback('r2')
    return null
  }
  if (!object) {
    reportFallback('routing_authority_incomplete')
    return null
  }

  let value: unknown
  try {
    value = await object.json<unknown>()
  } catch (error) {
    reportFallback(error instanceof SyntaxError ? 'routing_authority_invalid' : 'r2')
    return null
  }

  const parsed = parsePlaceRoutingArtifact(value, city, version, placeId)
  if (!parsed) reportFallback('routing_authority_invalid')
  return parsed
}

function parsePlaceRoutingArtifact(
  value: unknown,
  city: string,
  version: string,
  placeId: string,
): PlaceRoutingArtifact | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<PlaceRoutingArtifact>
  const place = candidate.place
  if (candidate.schemaVersion !== 1
    || candidate.kind !== 'place-routing'
    || candidate.city !== city
    || candidate.version !== version
    || !place || typeof place !== 'object'
    || place.placeId !== placeId
    || typeof place.name !== 'string' || !place.name
    || !Number.isFinite(place.latitude) || !Number.isFinite(place.longitude)
    || !Array.isArray(candidate.patterns) || candidate.patterns.length === 0
    || !Array.isArray(candidate.occurrences) || candidate.occurrences.length === 0) return null

  const patterns: PlaceRoutingPattern[] = []
  const patternById = new Map<string, PlaceRoutingPattern>()
  for (const valuePattern of candidate.patterns) {
    if (!valuePattern || typeof valuePattern !== 'object') return null
    const pattern = valuePattern as Partial<PlaceRoutingPattern>
    if (typeof pattern.patternId !== 'string' || !pattern.patternId
      || typeof pattern.routeUid !== 'string' || !pattern.routeUid
      || typeof pattern.routeName !== 'string' || !pattern.routeName
      || !isDirection(pattern.direction)
      || typeof pattern.label !== 'string' || !pattern.label
      || (pattern.subRouteUid !== undefined
        && (typeof pattern.subRouteUid !== 'string' || !pattern.subRouteUid))
      || typeof pattern.subRouteName !== 'string' || !pattern.subRouteName
      || typeof pattern.shapeKey !== 'string' || !pattern.shapeKey
      || typeof pattern.circular !== 'boolean'
      || !Number.isSafeInteger(pattern.minSequence) || (pattern.minSequence as number) < 0
      || !Number.isSafeInteger(pattern.maxSequence)
      || (pattern.maxSequence as number) < (pattern.minSequence as number)
      || patternById.has(pattern.patternId)) return null

    const parsed: PlaceRoutingPattern = {
      patternId: pattern.patternId,
      routeUid: pattern.routeUid,
      routeName: pattern.routeName,
      direction: pattern.direction,
      label: pattern.label,
      ...(pattern.subRouteUid ? { subRouteUid: pattern.subRouteUid } : {}),
      subRouteName: pattern.subRouteName,
      shapeKey: pattern.shapeKey,
      circular: pattern.circular,
      minSequence: pattern.minSequence as number,
      maxSequence: pattern.maxSequence as number,
    }
    patterns.push(parsed)
    patternById.set(parsed.patternId, parsed)
  }

  const occurrences: PlaceRoutingOccurrence[] = []
  const occurrenceKeys = new Set<string>()
  const usedPatterns = new Set<string>()
  for (const valueOccurrence of candidate.occurrences) {
    if (!valueOccurrence || typeof valueOccurrence !== 'object') return null
    const occurrence = valueOccurrence as Partial<PlaceRoutingOccurrence>
    const pattern = typeof occurrence.patternId === 'string'
      ? patternById.get(occurrence.patternId)
      : undefined
    if (!pattern
      || typeof occurrence.stopUid !== 'string' || !occurrence.stopUid
      || !Number.isSafeInteger(occurrence.stopSequence)
      || (occurrence.stopSequence as number) < pattern.minSequence
      || (occurrence.stopSequence as number) > pattern.maxSequence
      || typeof occurrence.stopName !== 'string' || !occurrence.stopName) return null

    const key = `${pattern.patternId}\u0000${occurrence.stopSequence}`
    if (occurrenceKeys.has(key)) return null
    occurrenceKeys.add(key)
    usedPatterns.add(pattern.patternId)
    occurrences.push({
      patternId: pattern.patternId,
      stopUid: occurrence.stopUid,
      stopSequence: occurrence.stopSequence as number,
      stopName: occurrence.stopName,
    })
  }
  if (usedPatterns.size !== patternById.size) return null

  return {
    schemaVersion: 1,
    kind: 'place-routing',
    city,
    version,
    place: {
      placeId,
      name: place.name,
      latitude: place.latitude as number,
      longitude: place.longitude as number,
    },
    patterns,
    occurrences,
  }
}

function isDirection(value: unknown): value is 0 | 1 | 2 {
  return value === 0 || value === 1 || value === 2
}

function compareBinary(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function samePatternMetadata(left: PlaceRoutingPattern, right: PlaceRoutingPattern): boolean {
  return left.patternId === right.patternId
    && left.routeUid === right.routeUid
    && left.routeName === right.routeName
    && left.direction === right.direction
    && left.label === right.label
    && left.subRouteUid === right.subRouteUid
    && left.subRouteName === right.subRouteName
    && left.shapeKey === right.shapeKey
    && left.circular === right.circular
    && left.minSequence === right.minSequence
    && left.maxSequence === right.maxSequence
}

function directStopCount(
  pattern: PlaceRoutingPattern,
  boardSequence: number,
  alightSequence: number,
): number | null {
  if (boardSequence === alightSequence) return null
  if (alightSequence > boardSequence) return alightSequence - boardSequence
  if (!pattern.circular) return null
  return pattern.maxSequence - boardSequence
    + alightSequence - pattern.minSequence + 1
}

/**
 * R2-first stop-place route list. A completed place-routing manifest is the
 * version-level gate; an unavailable or invalid place artifact falls back as
 * one complete operation to the legacy D1 join.
 */
export async function getStopPlaceRoutes(
  env: TransitBindings,
  city: string,
  placeId: string,
  observeFallback?: PlaceRoutingFallbackObserver,
): Promise<StopPlaceRoute[]> {
  // Route unit tests and non-snapshot callers can supply partial bindings. Keep
  // those paths on the existing implementation instead of making migration
  // plumbing a new runtime requirement.
  if (!hasSnapshotBindings(env)) return getStopPlaceRoutesFromD1(env, city, placeId)

  const version = await getActiveSnapshotVersion(env, city)
  if (!version) return []
  const reportFallback = createFallbackReporter(observeFallback, city, version)
  const fallback = () => getStopPlaceRoutesFromD1(env, city, placeId)
  if (!await hasPlaceRoutingExport(env, city, version, reportFallback)) return fallback()

  const artifact = await readPlaceRoutingArtifact(env, city, version, placeId, reportFallback)
  if (!artifact) return fallback()

  const patternById = new Map(artifact.patterns.map((pattern) => [pattern.patternId, pattern]))
  return artifact.occurrences.map((occurrence): StopPlaceRoute => {
    const pattern = patternById.get(occurrence.patternId) as PlaceRoutingPattern
    return {
      routeUid: pattern.routeUid,
      routeName: pattern.routeName,
      variantKey: pattern.patternId,
      direction: pattern.direction,
      label: pattern.label,
      ...(pattern.subRouteUid ? { subRouteUid: pattern.subRouteUid } : {}),
      subRouteName: pattern.subRouteName,
      stopUid: occurrence.stopUid,
      stopSequence: occurrence.stopSequence,
      stopName: occurrence.stopName,
    }
  }).sort((left, right) => compareBinary(left.routeName, right.routeName)
    || left.direction - right.direction)
}

/**
 * R2-first direct routing. Each endpoint is one per-place R2 object, and all
 * occurrence pairs for a shared pattern are evaluated in memory. This preserves
 * circular seam crossings and repeated-stop semantics without N-per-pattern R2
 * reads. Any incomplete pair falls back to the legacy D1 implementation.
 */
export async function getDirectRoutes(
  env: TransitBindings,
  city: string,
  fromPlaceId: string,
  toPlaceId: string,
  observeFallback?: PlaceRoutingFallbackObserver,
): Promise<DirectRoute[]> {
  if (!hasSnapshotBindings(env)) return getDirectRoutesFromD1(env, city, fromPlaceId, toPlaceId)

  const version = await getActiveSnapshotVersion(env, city)
  if (!version || fromPlaceId === toPlaceId) return []
  const reportFallback = createFallbackReporter(observeFallback, city, version)
  const fallback = () => getDirectRoutesFromD1(env, city, fromPlaceId, toPlaceId)
  if (!await hasPlaceRoutingExport(env, city, version, reportFallback)) return fallback()

  let fromFallbackReason: PlaceRoutingFallbackReason | null = null
  let toFallbackReason: PlaceRoutingFallbackReason | null = null
  const [fromArtifact, toArtifact] = await Promise.all([
    readPlaceRoutingArtifact(env, city, version, fromPlaceId, (reason) => {
      fromFallbackReason ??= reason
    }),
    readPlaceRoutingArtifact(env, city, version, toPlaceId, (reason) => {
      toFallbackReason ??= reason
    }),
  ])
  if (!fromArtifact || !toArtifact) {
    const reason = preferredArtifactFallbackReason(fromFallbackReason, toFallbackReason)
    if (reason) reportFallback(reason)
    return fallback()
  }

  const fromPatterns = new Map(fromArtifact.patterns.map((pattern) => [pattern.patternId, pattern]))
  const toPatterns = new Map(toArtifact.patterns.map((pattern) => [pattern.patternId, pattern]))
  for (const [patternId, fromPattern] of fromPatterns) {
    const toPattern = toPatterns.get(patternId)
    if (toPattern && !samePatternMetadata(fromPattern, toPattern)) {
      reportFallback('routing_authority_invalid')
      return fallback()
    }
  }

  const fromOccurrences = new Map<string, PlaceRoutingOccurrence[]>()
  for (const occurrence of fromArtifact.occurrences) {
    const rows = fromOccurrences.get(occurrence.patternId) ?? []
    rows.push(occurrence)
    fromOccurrences.set(occurrence.patternId, rows)
  }
  const toOccurrences = new Map<string, PlaceRoutingOccurrence[]>()
  for (const occurrence of toArtifact.occurrences) {
    const rows = toOccurrences.get(occurrence.patternId) ?? []
    rows.push(occurrence)
    toOccurrences.set(occurrence.patternId, rows)
  }

  const routes: DirectRoute[] = []
  for (const [patternId, boards] of fromOccurrences) {
    const pattern = fromPatterns.get(patternId)
    const alights = toOccurrences.get(patternId)
    if (!pattern || !alights?.length) continue

    let best: DirectRoute | null = null
    for (const board of boards) {
      for (const alight of alights) {
        const stopCount = directStopCount(pattern, board.stopSequence, alight.stopSequence)
        if (stopCount === null) continue
        const candidate: DirectRoute = {
          routeName: pattern.routeName,
          variantKey: pattern.patternId,
          direction: pattern.direction,
          label: pattern.label,
          subRouteName: pattern.subRouteName,
          boardSequence: board.stopSequence,
          alightSequence: alight.stopSequence,
          stopCount,
        }
        if (!best || candidate.stopCount < best.stopCount) best = candidate
      }
    }
    if (best) routes.push(best)
  }

  return routes
    .sort((left, right) => left.stopCount - right.stopCount
      || left.routeName.localeCompare(right.routeName, 'zh-Hant', { numeric: true }))
    .slice(0, 24)
}

export type { TransitBindings }
