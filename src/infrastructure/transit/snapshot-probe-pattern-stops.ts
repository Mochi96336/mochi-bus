import type { TransitBindings } from './snapshot-repository'

export type PinnedPatternStop = {
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
  stops: PinnedPatternStop[]
}

export function pinnedPatternStopArtifactKey(
  version: string,
  city: string,
  patternId: string,
): string {
  return `snapshots/${version}/cities/${city}/patterns/${patternId}/stops.json`
}

/**
 * Publisher probes must validate the requested immutable version itself. Unlike
 * ordinary runtime reads, this path intentionally has no D1 high-cardinality
 * fallback: a missing or malformed R2 artifact makes the candidate probe fail
 * closed instead of proving a different storage path.
 */
export async function readPinnedPatternStops(
  env: TransitBindings,
  city: string,
  version: string,
  patternId: string,
): Promise<PinnedPatternStop[] | null> {
  try {
    const object = await env.TRANSIT_SHAPES.get(pinnedPatternStopArtifactKey(version, city, patternId))
    if (!object) return null
    return parsePinnedPatternStopArtifact(await object.json<unknown>(), city, version, patternId)?.stops ?? null
  } catch {
    return null
  }
}

export function parsePinnedPatternStopArtifact(
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

  const stops: PinnedPatternStop[] = []
  let previousSequence = -1
  for (const rawStop of candidate.stops) {
    if (!rawStop || typeof rawStop !== 'object') return null
    const stop = rawStop as Partial<PinnedPatternStop>
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
