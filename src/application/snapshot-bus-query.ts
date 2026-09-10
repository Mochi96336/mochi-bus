import type { BusQuery, ResolvedBusQuery } from '../domain/bus-query'
import {
  getStopPlaceRoutes,
  type StopPlaceRoute,
} from '../infrastructure/transit/snapshot-place-routing-repository'
import {
  getStopPlaceByStopUid,
  type StopLookupFallbackObserver,
  type StopLookupPlace,
} from '../infrastructure/transit/snapshot-stop-lookup-repository'
import type { TransitBindings } from '../infrastructure/transit/snapshot-repository'
import {
  resolveBusQuery,
  type TDXEnv,
} from '../lib/tdx'
import { createSnapshotFallbackReporter } from '../observability/snapshot-fallback'

type SnapshotBusQueryDependencies = {
  getStopPlaceByStopUid: (
    env: TransitBindings,
    city: string,
    stopUid: string,
    observeFallback?: StopLookupFallbackObserver,
  ) => Promise<StopLookupPlace | null>
  getStopPlaceRoutes: (
    env: TransitBindings,
    city: string,
    placeId: string,
  ) => Promise<StopPlaceRoute[]>
  resolveBusQuery: typeof resolveBusQuery
  reportSnapshotFailure: (error: unknown) => void
  reportStopLookupFallback: StopLookupFallbackObserver
}

const defaultDependencies: SnapshotBusQueryDependencies = {
  getStopPlaceByStopUid,
  getStopPlaceRoutes,
  resolveBusQuery,
  reportSnapshotFailure: (error) => console.error('bus_query_snapshot_failed', error),
  reportStopLookupFallback: () => {},
}

/**
 * Resolve canonical bus-link identity from the active snapshot when the URL
 * already carries stable StopUID + RouteUID identity. Ambiguous, missing, or
 * incomplete snapshot data falls back to the existing TDX resolver unchanged.
 */
export async function resolveBusQueryWithSnapshotFallback(
  snapshot: TransitBindings,
  tdx: TDXEnv,
  query: BusQuery,
  dependencies: Partial<SnapshotBusQueryDependencies> = {},
): Promise<ResolvedBusQuery> {
  const deps = { ...defaultDependencies, ...dependencies }
  const versionMetadata = (snapshot as TransitBindings & {
    CF_VERSION_METADATA?: CloudflareBindings['CF_VERSION_METADATA']
  }).CF_VERSION_METADATA
  const reportStopLookupFallback = dependencies.reportStopLookupFallback
    ?? createSnapshotFallbackReporter({
      operation: 'bus_stop_routes',
      versionMetadata,
    })
  if (!query.stopUid || !query.routeUid) return deps.resolveBusQuery(tdx, query)

  try {
    const place = await deps.getStopPlaceByStopUid(
      snapshot,
      query.city,
      query.stopUid,
      reportStopLookupFallback,
    )
    if (!place) return deps.resolveBusQuery(tdx, query)

    const candidates = dedupeCandidates((await deps.getStopPlaceRoutes(snapshot, query.city, place.placeId))
      .filter((route) => route.stopUid === query.stopUid)
      .filter((route) => route.routeUid === query.routeUid)
      .filter((route) => route.direction === query.direction)
      .filter((route) => !query.subRouteUid || route.subRouteUid === query.subRouteUid))

    if (candidates.length !== 1) return deps.resolveBusQuery(tdx, query)
    const match = candidates[0]
    return {
      ...query,
      routeName: match.routeName,
      routeUid: match.routeUid,
      ...(match.subRouteUid ? { subRouteUid: match.subRouteUid } : { subRouteUid: undefined }),
      stopUid: match.stopUid,
      stopName: match.stopName,
    }
  } catch (error) {
    try {
      deps.reportSnapshotFailure(error)
    } catch {
      // Observability must never make the compatibility fallback unavailable.
    }
    return deps.resolveBusQuery(tdx, query)
  }
}

function dedupeCandidates(routes: StopPlaceRoute[]): StopPlaceRoute[] {
  return [...new Map(routes.map((route) => [[
    route.routeUid,
    route.subRouteUid ?? '',
    route.direction,
    route.stopUid,
    route.stopName,
  ].join('\u0000'), route])).values()]
}
