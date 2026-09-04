import type { BusQuery, ResolvedBusQuery } from '../domain/bus-query'
import type { RouteMapVariant } from '../domain/map/map-model'
import { buildRouteDetailWithoutEta } from '../domain/route-page-detail'
import {
  buildResolvedSnapshotRouteQuery,
  selectUniqueSnapshotRouteVariant,
} from '../domain/snapshot-route-selection'
import {
  getSnapshotRouteVariants,
  type TransitBindings,
} from '../infrastructure/transit/snapshot-pattern-stop-repository'
import type { RouteDetail } from '../lib/tdx'

export type SnapshotRoutePage = {
  resolved: ResolvedBusQuery
  detail: RouteDetail
}

export type SnapshotRouteVariant = RouteMapVariant

type SnapshotRouteVariantLoader = typeof getSnapshotRouteVariants

/**
 * Assemble the complete Snapshot Route fallback outside the HTTP layer.
 * Missing or ambiguous physical identities remain unresolved and return null.
 */
export async function getSnapshotRoutePage(
  env: TransitBindings,
  query: BusQuery,
  loadVariants: SnapshotRouteVariantLoader = getSnapshotRouteVariants,
): Promise<SnapshotRoutePage | null> {
  if (!query.stopUid) return null

  const variants = await loadVariants(env, query.city, query.routeName)
  const selection = selectUniqueSnapshotRouteVariant(variants, query)
  if (!selection) return null

  const resolved = buildResolvedSnapshotRouteQuery(query, selection)
  return {
    resolved,
    detail: buildSnapshotRouteDetail(selection.variant, resolved.stopUid),
  }
}

export function buildSnapshotRouteDetail(
  variant: SnapshotRouteVariant,
  selectedStopUid: string,
): RouteDetail {
  const stops = [...variant.stops.features]
    .sort((a, b) => a.properties.sequence - b.properties.sequence)
    .map((stop) => ({
      stopUid: stop.properties.stopUid,
      stopName: stop.properties.stopName,
      sequence: stop.properties.sequence,
    }))

  return buildRouteDetailWithoutEta({
    routeName: variant.routeName,
    direction: variant.direction,
    stopUid: selectedStopUid,
  }, {
    label: variant.label,
    stops,
  })
}
