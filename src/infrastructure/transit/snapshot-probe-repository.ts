import type { RouteMapVariant } from '../../domain/map/map-model'
import { classifyRouteName } from '../../domain/route-category'
import { readPinnedPatternStops } from './snapshot-probe-pattern-stops'
import type { StopPlaceBundleRoute, TransitBindings } from './snapshot-repository'

type ActiveVersion = { active_version: string }
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
type ShapeFeature = RouteMapVariant['shape']

// Probe reads must compare against D1 directly. The ordinary repository keeps its
// 60-second isolate-local cache; this path deliberately bypasses it so a publish
// smoke cannot mistake cache propagation for a snapshot data defect.
export async function getAuthoritativeActiveSnapshotVersion(
  env: TransitBindings,
  city: string,
): Promise<string | null> {
  const row = await env.TRANSIT_DB.prepare(
    'SELECT active_version FROM dataset_versions WHERE city_code = ?',
  ).bind(city).first<ActiveVersion>()
  return row?.active_version ?? null
}

export async function getPinnedSnapshotRouteCatalog(
  env: TransitBindings,
  city: string,
  version: string,
) {
  const result = await env.TRANSIT_DB.prepare(`
    SELECT route_uid, route_name, departure_name, destination_name
    FROM routes
    WHERE version = ? AND city_code = ?
    ORDER BY route_name
  `).bind(version, city).all<{
    route_uid: string
    route_name: string
    departure_name: string | null
    destination_name: string | null
  }>()
  return result.results.map((route) => ({
    routeUid: route.route_uid,
    routeName: route.route_name,
    departure: route.departure_name ?? undefined,
    destination: route.destination_name ?? undefined,
    category: classifyRouteName(route.route_name, route.route_uid),
  }))
}

// Snapshot-only publisher smoke keeps the grouped route-name read. The active
// deterministic probe uses getPinnedSnapshotRouteVariant below so unrelated
// same-name variants cannot add R2 reads or fail the exact sample request.
export async function getPinnedSnapshotRouteVariants(
  env: TransitBindings,
  city: string,
  routeName: string,
  version: string,
): Promise<RouteMapVariant[]> {
  const patterns = await env.TRANSIT_DB.prepare(`
    SELECT p.pattern_id, p.route_uid, p.subroute_uid, r.route_name, p.subroute_name, p.direction,
           p.departure_name, p.destination_name, p.shape_key, p.updated_at
    FROM patterns p
    JOIN routes r ON r.version = p.version AND r.city_code = p.city_code AND r.route_uid = p.route_uid
    WHERE p.version = ? AND p.city_code = ? AND r.route_name = ?
    ORDER BY p.direction, p.pattern_id
  `).bind(version, city, routeName).all<PatternRow>()
  if (!patterns.results.length) return []

  const variants = await Promise.all(patterns.results.map((pattern) =>
    readPinnedPatternVariant(env, city, version, pattern)))
  return variants.filter((variant): variant is RouteMapVariant => variant !== null)
}

export async function getPinnedSnapshotRouteVariant(
  env: TransitBindings,
  city: string,
  routeUid: string,
  patternId: string,
  version: string,
): Promise<RouteMapVariant | null> {
  const pattern = await env.TRANSIT_DB.prepare(`
    SELECT p.pattern_id, p.route_uid, p.subroute_uid, r.route_name, p.subroute_name, p.direction,
           p.departure_name, p.destination_name, p.shape_key, p.updated_at
    FROM patterns p
    JOIN routes r ON r.version = p.version AND r.city_code = p.city_code AND r.route_uid = p.route_uid
    WHERE p.version = ? AND p.city_code = ? AND p.route_uid = ? AND p.pattern_id = ?
    LIMIT 1
  `).bind(version, city, routeUid, patternId).first<PatternRow>()
  if (!pattern) return null
  return readPinnedPatternVariant(env, city, version, pattern)
}

async function readPinnedPatternVariant(
  env: TransitBindings,
  city: string,
  version: string,
  pattern: PatternRow,
): Promise<RouteMapVariant | null> {
  const [stops, shapeObject] = await Promise.all([
    readPinnedPatternStops(env, city, version, pattern.pattern_id),
    env.TRANSIT_SHAPES.get(pattern.shape_key),
  ])
  if (!stops || !shapeObject) return null
  const shape = await shapeObject.json<ShapeFeature>()
  return {
    variantKey: pattern.pattern_id,
    routeName: pattern.route_name,
    routeUid: pattern.route_uid,
    ...(pattern.subroute_uid ? { subRouteUid: pattern.subroute_uid } : {}),
    direction: pattern.direction,
    label: `${pattern.departure_name} → ${pattern.destination_name}`,
    subRouteName: pattern.subroute_name,
    shape,
    stops: {
      type: 'FeatureCollection' as const,
      features: stops.map((stop) => ({
        type: 'Feature' as const,
        properties: {
          stopUid: stop.stopUid,
          stopName: stop.name,
          sequence: stop.stopSequence,
        },
        geometry: {
          type: 'Point' as const,
          coordinates: [stop.longitude, stop.latitude] as [number, number],
        },
      })),
    },
    updatedAt: pattern.updated_at,
  }
}

export async function getPinnedStopPlaceBundle(
  env: TransitBindings,
  city: string,
  placeId: string,
  version: string,
) {
  const key = `snapshots/${version}/cities/${city}/places/${placeId}.json`
  const object = await env.TRANSIT_SHAPES.get(key)
  return object ? await object.json<{
    version: string
    placeId: string
    name: string
    routes: StopPlaceBundleRoute[]
  }>() : null
}
