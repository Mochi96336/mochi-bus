import type { RouteMapVariant } from '../../domain/map/map-model'
import { memoryCacheGet, memoryCacheSet } from '../../lib/memory-cache'
import {
  getActiveSnapshotVersion,
  getJourneyLegStopRefs as getJourneyLegStopRefsFromD1,
  getSnapshotRouteVariants as getSnapshotRouteVariantsFromD1,
  type TransitBindings,
} from './snapshot-repository'

const EXPORT_STATUS_TTL_SECONDS = 60
// Keep route-name fan-out below the Workers per-invocation outgoing connection
// ceiling and leave headroom for other bindings used by the same request.
const ROUTE_R2_READ_CONCURRENCY = 4

type PatternRow = {
  pattern_id: string
  route_uid: string
  subroute_uid: string | null
  route_name: string
  subroute_name: string
  direction: 0 | 1 | 2
  departure_name: string
  destination_name: string
  shape_key: string
  updated_at: string | null
}

type PatternStop = {
  stopUid: string
  placeId: string
  stopSequence: number
  name: string
  latitude: number
  longitude: number
}

type PatternStopArtifact = {
  schemaVersion: 1
  city: string
  version: string
  patternId: string
  stops: PatternStop[]
}

type JourneyPatternRow = {
  pattern_id: string
  route_uid: string
  subroute_uid: string | null
  direction: 0 | 1 | 2
  route_name: string
}

type ShapeFeature = RouteMapVariant['shape']

export type PatternStopFallbackReason =
  | 'manifest_missing'
  | 'manifest_read_failed'
  | 'routing_authority_incomplete'
  | 'routing_authority_invalid'
  | 'r2'

export type PatternStopFallbackObservation = Readonly<{
  city: string
  snapshotVersion: string
  reason: PatternStopFallbackReason
}>

export type PatternStopFallbackObserver = (observation: PatternStopFallbackObservation) => void

type PatternStopReadResult = Readonly<{
  stops: PatternStop[] | null
  reason: PatternStopFallbackReason | null
}>

function patternStopArtifactKey(version: string, city: string, patternId: string): string {
  return `snapshots/${version}/cities/${city}/patterns/${patternId}/stops.json`
}

function patternStopExportManifestKey(version: string, city: string): string {
  return `snapshots/${version}/cities/${city}/pattern-stops-export.json`
}

function createFallbackReporter(
  observer: PatternStopFallbackObserver | undefined,
  city: string,
  version: string,
): (reason: PatternStopFallbackReason) => void {
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

function preferredFallbackReason(
  ...reasons: Array<PatternStopFallbackReason | null>
): PatternStopFallbackReason | null {
  for (const reason of [
    'routing_authority_invalid',
    'routing_authority_incomplete',
    'r2',
    'manifest_read_failed',
    'manifest_missing',
  ] as const) {
    if (reasons.includes(reason)) return reason
  }
  return null
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let nextIndex = 0
  const workerCount = Math.min(Math.max(1, concurrency), values.length)
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await mapper(values[index], index)
    }
  }))
  return results
}

async function hasPatternStopExport(
  env: TransitBindings,
  city: string,
  version: string,
  reportFallback: (reason: PatternStopFallbackReason) => void,
): Promise<boolean> {
  const memoryKey = `transit/pattern-stop-export/${city}/${version}`
  const cached = memoryCacheGet<'ready' | 'missing'>(memoryKey)
  if (cached) {
    if (cached === 'missing') reportFallback('manifest_missing')
    return cached === 'ready'
  }

  try {
    const manifest = await env.TRANSIT_SHAPES.head(patternStopExportManifestKey(version, city))
    const state = manifest ? 'ready' : 'missing'
    memoryCacheSet(memoryKey, state, EXPORT_STATUS_TTL_SECONDS)
    if (state === 'missing') reportFallback('manifest_missing')
    return state === 'ready'
  } catch {
    // R2 availability must never make the migration path less reliable than D1.
    // Do not cache transient errors; the next request may retry the R2 gate.
    reportFallback('manifest_read_failed')
    return false
  }
}

async function readPatternStops(
  env: TransitBindings,
  city: string,
  version: string,
  patternId: string,
): Promise<PatternStopReadResult> {
  try {
    const object = await env.TRANSIT_SHAPES.get(patternStopArtifactKey(version, city, patternId))
    if (!object) return { stops: null, reason: 'routing_authority_incomplete' }
    const artifact = parsePatternStopArtifact(await object.json<unknown>(), city, version, patternId)
    if (!artifact) return { stops: null, reason: 'routing_authority_invalid' }
    return { stops: artifact.stops, reason: null }
  } catch {
    return { stops: null, reason: 'r2' }
  }
}

function parsePatternStopArtifact(
  value: unknown,
  city: string,
  version: string,
  patternId: string,
): PatternStopArtifact | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<PatternStopArtifact>
  if (candidate.schemaVersion !== 1
    || candidate.city !== city
    || candidate.version !== version
    || candidate.patternId !== patternId
    || !Array.isArray(candidate.stops)
    || candidate.stops.length < 2) return null

  const stops: PatternStop[] = []
  let previousSequence = -1
  for (const valueStop of candidate.stops) {
    if (!valueStop || typeof valueStop !== 'object') return null
    const stop = valueStop as Partial<PatternStop>
    if (typeof stop.stopUid !== 'string' || !stop.stopUid
      || typeof stop.placeId !== 'string' || !stop.placeId
      || typeof stop.name !== 'string' || !stop.name
      || !Number.isSafeInteger(stop.stopSequence)
      || (stop.stopSequence as number) < 0
      || (stop.stopSequence as number) <= previousSequence
      || !Number.isFinite(stop.latitude)
      || !Number.isFinite(stop.longitude)) return null
    previousSequence = stop.stopSequence as number
    stops.push({
      stopUid: stop.stopUid,
      placeId: stop.placeId,
      stopSequence: stop.stopSequence as number,
      name: stop.name,
      latitude: stop.latitude as number,
      longitude: stop.longitude as number,
    })
  }

  return { schemaVersion: 1, city, version, patternId, stops }
}

/**
 * R2-first route variants for versions whose pattern-stop export manifest exists.
 * Missing/invalid artifacts fall back to the existing D1 implementation as one
 * complete route read, so callers never receive a mix of R2 and D1 directions.
 */
export async function getSnapshotRouteVariants(
  env: TransitBindings,
  city: string,
  routeName: string,
  observeFallback?: PatternStopFallbackObserver,
): Promise<RouteMapVariant[]> {
  const version = await getActiveSnapshotVersion(env, city)
  if (!version) return []
  const reportFallback = createFallbackReporter(observeFallback, city, version)
  if (!await hasPatternStopExport(env, city, version, reportFallback)) {
    return getSnapshotRouteVariantsFromD1(env, city, routeName)
  }

  const patterns = await env.TRANSIT_DB.prepare(`
    SELECT p.pattern_id, p.route_uid, p.subroute_uid, r.route_name, p.subroute_name, p.direction,
           p.departure_name, p.destination_name, p.shape_key, p.updated_at
    FROM patterns p
    JOIN routes r ON r.version = p.version AND r.route_uid = p.route_uid
    WHERE p.version = ? AND p.city_code = ? AND r.route_name = ?
    ORDER BY p.direction, p.pattern_id
  `).bind(version, city, routeName).all<PatternRow>()
  if (!patterns.results.length) return []

  const stopResults = await mapWithConcurrency(
    patterns.results,
    ROUTE_R2_READ_CONCURRENCY,
    (pattern) => readPatternStops(env, city, version, pattern.pattern_id),
  )
  const fallbackReason = preferredFallbackReason(...stopResults.map((result) => result.reason))
  if (fallbackReason) {
    reportFallback(fallbackReason)
    return getSnapshotRouteVariantsFromD1(env, city, routeName)
  }
  const stopSets = stopResults.map((result) => result.stops)

  const shapes = await mapWithConcurrency(
    patterns.results,
    ROUTE_R2_READ_CONCURRENCY,
    async (pattern) => {
      const object = await env.TRANSIT_SHAPES.get(pattern.shape_key)
      return object ? await object.json<ShapeFeature>() : null
    },
  )

  const variants: RouteMapVariant[] = []
  for (let index = 0; index < patterns.results.length; index += 1) {
    const pattern = patterns.results[index]
    const stops = stopSets[index]
    const shape = shapes[index]
    if (!stops || !shape) continue
    variants.push({
      variantKey: pattern.pattern_id,
      routeName: pattern.route_name,
      routeUid: pattern.route_uid,
      subRouteUid: pattern.subroute_uid ?? undefined,
      direction: pattern.direction,
      label: `${pattern.departure_name} → ${pattern.destination_name}`,
      subRouteName: pattern.subroute_name,
      shape,
      stops: {
        type: 'FeatureCollection',
        features: stops.map((stop) => ({
          type: 'Feature',
          properties: {
            stopUid: stop.stopUid,
            stopName: stop.name,
            sequence: stop.stopSequence,
          },
          geometry: {
            type: 'Point',
            coordinates: [stop.longitude, stop.latitude] as [number, number],
          },
        })),
      },
      updatedAt: pattern.updated_at,
    })
  }
  return variants
}

/**
 * R2-first journey stop resolution. Pattern/route metadata remains in D1, while
 * stop UID + sequence comes from the version-addressed pattern artifact. If the
 * export is unavailable or incomplete, use the legacy D1 join unchanged.
 */
export async function getJourneyLegStopRefs(
  env: TransitBindings,
  city: string,
  legs: Array<{ key: string; patternId: string; sequence: number }>,
  observeFallback?: PatternStopFallbackObserver,
) {
  if (!legs.length) return []
  const version = await getActiveSnapshotVersion(env, city)
  if (!version) return []
  const reportFallback = createFallbackReporter(observeFallback, city, version)
  if (!await hasPatternStopExport(env, city, version, reportFallback)) {
    return getJourneyLegStopRefsFromD1(env, city, legs)
  }

  const patternIds = [...new Set(legs.map((leg) => leg.patternId))]
  const stopResults = await Promise.all(patternIds.map((patternId) =>
    readPatternStops(env, city, version, patternId)))
  const fallbackReason = preferredFallbackReason(...stopResults.map((result) => result.reason))
  if (fallbackReason) {
    reportFallback(fallbackReason)
    return getJourneyLegStopRefsFromD1(env, city, legs)
  }
  const stopSets = stopResults.map((result) => result.stops)

  const placeholders = patternIds.map(() => '?').join(', ')
  const metadata = await env.TRANSIT_DB.prepare(`
    SELECT p.pattern_id, p.route_uid, p.subroute_uid, p.direction, r.route_name
    FROM patterns p
    JOIN routes r ON r.version = p.version AND r.route_uid = p.route_uid
    WHERE p.version = ? AND p.city_code = ? AND p.pattern_id IN (${placeholders})
  `).bind(version, city, ...patternIds).all<JourneyPatternRow>()

  const metadataByPattern = new Map(metadata.results.map((row) => [row.pattern_id, row]))
  const stopByPatternAndSequence = new Map<string, Map<number, PatternStop>>()
  patternIds.forEach((patternId, index) => {
    const stops = stopSets[index]
    if (stops) stopByPatternAndSequence.set(
      patternId,
      new Map(stops.map((stop) => [stop.stopSequence, stop])),
    )
  })

  return legs.flatMap((leg) => {
    const row = metadataByPattern.get(leg.patternId)
    const stop = stopByPatternAndSequence.get(leg.patternId)?.get(leg.sequence)
    return row && stop ? [{
      key: leg.key,
      patternId: leg.patternId,
      routeUid: row.route_uid,
      subRouteUid: row.subroute_uid ?? undefined,
      direction: row.direction,
      routeName: row.route_name,
      stopUid: stop.stopUid,
    }] : []
  })
}

export type { TransitBindings }
