import type { RouteMapVariant } from '../domain/map/map-model'
import {
  getSnapshotRouteVariants,
  type TransitBindings,
} from '../infrastructure/transit/snapshot-pattern-stop-repository'

export type SnapshotRouteStop = {
  routeUid?: string
  subRouteUid?: string
  subRouteName: string
  stopUid: string
  stopName: string
  direction: 0 | 1 | 2
  sequence: number
  position?: {
    latitude: number
    longitude: number
  }
}

export type SnapshotRouteStopGroup = {
  direction: 0 | 1 | 2
  label: string
  routeUid?: string
  subRouteUid?: string
  subRouteName: string
  stops: SnapshotRouteStop[]
}

type RouteVariantLoader = (
  env: TransitBindings,
  city: string,
  routeName: string,
) => Promise<RouteMapVariant[]>

/**
 * Build the setup route-stop contract from the active snapshot. A concrete
 * RouteUID is required so same-name routes cannot bleed into the selection.
 * Any snapshot/R2 failure deliberately returns [] and lets the HTTP layer use
 * the existing TDX StopOfRoute path as a compatibility fallback.
 */
export async function getSnapshotRouteStopGroups(
  env: TransitBindings,
  city: string,
  routeName: string,
  routeUid: string,
  loadVariants: RouteVariantLoader = getSnapshotRouteVariants,
): Promise<SnapshotRouteStopGroup[]> {
  let variants: RouteMapVariant[]
  try {
    variants = await loadVariants(env, city, routeName)
  } catch {
    return []
  }

  const groups = variants
    .filter((variant) => variant.routeUid === routeUid)
    .map((variant): SnapshotRouteStopGroup | null => {
      const stops = variant.stops.features.map((feature): SnapshotRouteStop => ({
        routeUid: variant.routeUid,
        subRouteUid: variant.subRouteUid,
        subRouteName: variant.subRouteName,
        stopUid: feature.properties.stopUid,
        stopName: feature.properties.stopName,
        direction: variant.direction,
        sequence: feature.properties.sequence,
        position: {
          latitude: feature.geometry.coordinates[1],
          longitude: feature.geometry.coordinates[0],
        },
      }))
      if (!stops.length) return null

      return {
        direction: variant.direction,
        label: `${stops[0].stopName} → ${stops.at(-1)?.stopName ?? stops[0].stopName}`,
        routeUid: variant.routeUid,
        subRouteUid: variant.subRouteUid,
        subRouteName: variant.subRouteName,
        stops,
      }
    })
    .filter((group): group is SnapshotRouteStopGroup => group !== null)

  return [...new Map(groups.map((group) => [[
    group.routeUid ?? '',
    group.subRouteUid ?? '',
    group.direction,
    group.stops.map((stop) => stop.stopUid).join('>'),
  ].join('\u0000'), group])).values()]
}
