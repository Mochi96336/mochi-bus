import type { RouteMapVariant } from '../../domain/map/map-model'
import { polylineToGeoJSONCoordinates } from '../../domain/map/polyline'
import {
  fetchTDXJson,
  getRouteStopGroups,
  type TDXEnv,
} from '../../lib/tdx'

type ShapeItem = {
  RouteUID?: string
  Direction?: number
  EncodedPolyline?: string
  UpdateTime?: string
}

const SHAPE_CACHE_SECONDS = 6 * 60 * 60
const SHAPE_SELECT = 'RouteUID,Direction,EncodedPolyline,UpdateTime'

export async function getRouteMapVariants(
  env: TDXEnv,
  city: string,
  routeName: string,
): Promise<RouteMapVariant[]> {
  const shapeUrl = (scope: string) => {
    const url = new URL(
      `https://tdx.transportdata.tw/api/basic/v2/Bus/Shape/${scope}/${encodeURIComponent(routeName)}`,
    )
    // Snapshot reads are preferred by the route API; this direct TDX path is a fallback.
    // Even there, only request fields consumed by variant matching and presentation.
    url.searchParams.set('$select', SHAPE_SELECT)
    url.searchParams.set('$format', 'JSON')
    return url
  }

  const [groups, cityShapes] = await Promise.all([
    getRouteStopGroups(env, city, routeName),
    fetchTDXJson<ShapeItem[]>(env, shapeUrl(`City/${encodeURIComponent(city)}`), SHAPE_CACHE_SECONDS),
  ])
  // getRouteStopGroups 在市區查不到時會退去公路客運端點;站序來自 THB 路線的話,線形也要跟著換。
  const shapes = !cityShapes.length && groups.some((group) => group.routeUid?.startsWith('THB'))
    ? await fetchTDXJson<ShapeItem[]>(env, shapeUrl('InterCity'), SHAPE_CACHE_SECONDS)
    : cityShapes

  const usedShapes = new Map<string, number>()
  const variants: RouteMapVariant[] = []

  for (const group of groups) {
    if (!group.routeUid) continue
    const identity = `${group.routeUid}:${group.direction}`
    const candidates = shapes.filter((shape) =>
      shape.RouteUID === group.routeUid
      && shape.Direction === group.direction
      && shape.EncodedPolyline,
    )
    const candidateIndex = usedShapes.get(identity) ?? 0
    const shape = candidates[candidateIndex] ?? candidates[0]
    usedShapes.set(identity, candidateIndex + 1)
    if (!shape?.EncodedPolyline) continue

    const positionedStops = group.stops.filter((stop) => stop.position)
    variants.push({
      variantKey: `${group.subRouteUid ?? group.routeUid}:${group.direction}:${candidateIndex}`,
      routeName,
      routeUid: group.routeUid,
      subRouteUid: group.subRouteUid,
      direction: group.direction,
      label: group.label,
      subRouteName: group.subRouteName,
      shape: {
        type: 'Feature',
        properties: { routeUid: group.routeUid, direction: group.direction },
        geometry: {
          type: 'LineString',
          coordinates: polylineToGeoJSONCoordinates(shape.EncodedPolyline),
        },
      },
      stops: {
        type: 'FeatureCollection',
        features: positionedStops.map((stop) => ({
          type: 'Feature',
          properties: {
            stopUid: stop.stopUid,
            stopName: stop.stopName,
            sequence: stop.sequence,
          },
          geometry: {
            type: 'Point',
            coordinates: [stop.position!.longitude, stop.position!.latitude],
          },
        })),
      },
      updatedAt: shape.UpdateTime ?? null,
    })
  }

  return variants
}
