import type { BusQuery, ResolvedBusQuery } from '../domain/bus-query'
import { getRoutePageDetail } from '../domain/route-page-detail'
import type { TransitBindings } from '../infrastructure/transit/snapshot-repository'
import {
  resolveBusQuery,
  type RouteDetail,
  type TDXEnv,
} from '../lib/tdx'
import { getSnapshotRoutePage } from './snapshot-route-page'

export type RoutePage = {
  resolved: ResolvedBusQuery
  detail: RouteDetail
}

export type RoutePageSources = {
  tdx: TDXEnv
  snapshot: TransitBindings
}

type RoutePageDependencies = {
  resolveBusQuery: typeof resolveBusQuery
  getRoutePageDetail: typeof getRoutePageDetail
  getSnapshotRoutePage: typeof getSnapshotRoutePage
  reportSnapshotFailure: (error: unknown) => void
}

const defaultDependencies: RoutePageDependencies = {
  resolveBusQuery,
  getRoutePageDetail,
  getSnapshotRoutePage,
  reportSnapshotFailure: (error) => console.error('route_snapshot_read_failed', error),
}

/**
 * Resolve the static Route page from the active snapshot first. Route navigation
 * only needs stable route/stop identity and station order; realtime ETA is loaded
 * later by the browser API, where shared/BYOK cache policy already applies.
 *
 * Missing, ambiguous, or broken snapshot data falls back to the legacy TDX
 * resolver/detail path so old links and incomplete instances remain compatible.
 */
export async function getRoutePageWithFallback(
  sources: RoutePageSources,
  query: BusQuery,
  dependencies: Partial<RoutePageDependencies> = {},
): Promise<RoutePage> {
  const resolvedDependencies: RoutePageDependencies = {
    ...defaultDependencies,
    ...dependencies,
  }

  try {
    const snapshot = await resolvedDependencies.getSnapshotRoutePage(sources.snapshot, query)
    if (snapshot) return snapshot
  } catch (snapshotError) {
    try {
      resolvedDependencies.reportSnapshotFailure(snapshotError)
    } catch {
      // Logging failures must never block the compatibility fallback.
    }
  }

  const resolved = await resolvedDependencies.resolveBusQuery(sources.tdx, query)
  const { detail } = await resolvedDependencies.getRoutePageDetail(sources.tdx, resolved)
  return { resolved, detail }
}
