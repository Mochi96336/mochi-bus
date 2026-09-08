import type { ResolvedBusQuery } from '../domain/bus-query'
import { selectBestEta } from '../domain/map/eta'
import {
  routeEtaHasRealtimeEstimate,
  routeEtaIsUnknown,
  routeEtaStateFromTdx,
  type RouteEtaPresentationState,
} from '../domain/route-eta-status'
import { selectRouteStopGroup } from '../domain/route-stop-group-selection'
import {
  applyRouteTimelineFallback,
  routeTimelineNeedsSchedule,
} from '../domain/route-timeline-fallback'
import type { ScheduleItem } from '../domain/schedule'
import {
  buildRouteDetailWithoutEta,
  getRouteEtaDetail,
  type RouteEtaDetail,
} from '../domain/route-page-detail'
import {
  getSnapshotSchedule,
  type TransitBindings,
} from '../infrastructure/transit/snapshot-repository'
import {
  fetchTDXJson,
  formatETALabel,
  getBusSchedule,
  isRejectedUserTdxToken,
  tdxRouteScope,
  tdxWarningFromError,
  type BusETAItem,
  type RouteDetail,
  type RouteDetailWithEtaStates,
  type StopGroup,
  type TDXEnv,
  type TDXWarning,
} from '../lib/tdx'
import { BUS_ETA_CACHE_SECONDS } from '../lib/tdx/bus-route-queries'
import { getSnapshotRouteStopGroups } from './snapshot-route-stop-groups'

const ETA_API_BASE = 'https://tdx.transportdata.tw/api/basic/v2/Bus/EstimatedTimeOfArrival'
const ROUTE_TIMELINE_ETA_SELECT = [
  'RouteUID',
  'SubRouteUID',
  'StopUID',
  'Direction',
  'EstimateTime',
  'StopStatus',
].join(',')

export type SnapshotRouteEtaSources = {
  tdx: TDXEnv
  snapshot: TransitBindings
}

type SnapshotRouteEtaDependencies = {
  getSnapshotRouteStopGroups: typeof getSnapshotRouteStopGroups
  getLegacyRouteEtaDetail: typeof getRouteEtaDetail
  fetchRouteEta: (env: TDXEnv, url: URL, ttlSeconds: number) => Promise<BusETAItem[]>
  getSnapshotSchedule: typeof getSnapshotSchedule
  getBusSchedule: typeof getBusSchedule
  now: () => Date
  reportSnapshotFailure: (error: unknown) => void
}

const defaultDependencies: SnapshotRouteEtaDependencies = {
  getSnapshotRouteStopGroups,
  getLegacyRouteEtaDetail: getRouteEtaDetail,
  fetchRouteEta: (env, url, ttlSeconds) => fetchTDXJson<BusETAItem[]>(env, url, ttlSeconds),
  getSnapshotSchedule,
  getBusSchedule,
  now: () => new Date(),
  reportSnapshotFailure: (error) => console.error('route_eta_snapshot_read_failed', error),
}

/**
 * Keep Route ETA realtime, but resolve its static station order from the active
 * snapshot whenever a stable RouteUID is available. Missing/ambiguous snapshot
 * data falls back to the legacy TDX StopOfRoute path unchanged.
 */
export async function getRouteEtaWithSnapshotFallback(
  sources: SnapshotRouteEtaSources,
  query: ResolvedBusQuery,
  dependencies: Partial<SnapshotRouteEtaDependencies> = {},
): Promise<RouteEtaDetail> {
  const resolvedDependencies: SnapshotRouteEtaDependencies = {
    ...defaultDependencies,
    ...dependencies,
  }

  if (!query.routeUid) {
    return resolvedDependencies.getLegacyRouteEtaDetail(sources.tdx, query)
  }

  let groups: StopGroup[]
  try {
    groups = await resolvedDependencies.getSnapshotRouteStopGroups(
      sources.snapshot,
      query.city,
      query.routeName,
      query.routeUid,
    )
  } catch (error) {
    try {
      resolvedDependencies.reportSnapshotFailure(error)
    } catch {
      // Observability must never block the legacy compatibility path.
    }
    return resolvedDependencies.getLegacyRouteEtaDetail(sources.tdx, query)
  }

  const group = selectRouteStopGroup(groups, query)
  if (!group) return resolvedDependencies.getLegacyRouteEtaDetail(sources.tdx, query)

  return getSnapshotBackedRouteEtaDetail(sources, query, group, resolvedDependencies)
}

async function getSnapshotBackedRouteEtaDetail(
  sources: SnapshotRouteEtaSources,
  query: ResolvedBusQuery,
  group: StopGroup,
  dependencies: SnapshotRouteEtaDependencies,
): Promise<RouteEtaDetail> {
  let etaItems: BusETAItem[]
  try {
    etaItems = await dependencies.fetchRouteEta(
      sources.tdx,
      routeTimelineEtaUrl(query),
      BUS_ETA_CACHE_SECONDS,
    )
  } catch (error) {
    if (isRejectedUserTdxToken(error, sources.tdx.TDX_USER_ACCESS_TOKEN)) throw error
    const warning = tdxWarningFromError(error)
    if (!warning) throw error

    console.error(JSON.stringify({
      message: 'route_eta_failed',
      city: query.city,
      warning,
    }))
    return {
      detail: buildRouteDetailWithoutEta(query, group, unavailableLabel(warning)),
      eta: { kind: 'unavailable', warning },
    }
  }

  let { detail, states } = buildRealtimeRouteDetail(query, group, etaItems)

  if (routeTimelineNeedsSchedule(detail.stops, states)) {
    let schedules: ScheduleItem[] = []
    try {
      schedules = await dependencies.getSnapshotSchedule(
        sources.snapshot,
        query.city,
        query.routeName,
        query.routeUid,
      ) ?? await dependencies.getBusSchedule(
        sources.tdx,
        query.city,
        query.routeName,
        query.routeUid,
      )
    } catch (error) {
      if (isRejectedUserTdxToken(error, sources.tdx.TDX_USER_ACCESS_TOKEN)) throw error
      console.error(JSON.stringify({
        message: 'route_schedule_fallback_failed',
        city: query.city,
      }))
    }

    const fallback = applyRouteTimelineFallback(detail.stops, states, schedules, {
      direction: query.direction,
      subRouteUid: query.subRouteUid,
    }, dependencies.now())
    detail = { ...detail, stops: fallback.stops }
    states = fallback.states
  }

  if (states.some(routeEtaHasRealtimeEstimate)) {
    return { detail, eta: { kind: 'realtime' } }
  }
  return {
    detail: withSelectedStopStatusWhenUnknown(detail, states, '暫無即時'),
    eta: { kind: 'empty' },
  }
}

function buildRealtimeRouteDetail(
  query: ResolvedBusQuery,
  group: StopGroup,
  etaItems: BusETAItem[],
): RouteDetailWithEtaStates {
  const stopUids = new Set(group.stops.map((stop) => stop.stopUid))
  const etaByStop = new Map([...stopUids].map((stopUid) => [
    stopUid,
    selectBestEta(etaItems, {
      routeUid: query.routeUid,
      subRouteUid: query.subRouteUid ?? group.subRouteUid,
      stopUid,
      direction: query.direction,
    }),
  ]))

  const timeline = group.stops.map((stop) => {
    const eta = etaByStop.get(stop.stopUid)
    const seconds = typeof eta?.EstimateTime === 'number' ? Math.max(0, eta.EstimateTime) : null
    return {
      stop: {
        stopUid: stop.stopUid,
        stopName: stop.stopName,
        sequence: stop.sequence,
        selected: stop.stopUid === query.stopUid,
        etaLabel: eta
          ? formatETALabel(seconds === null ? null : Math.ceil(seconds / 60), eta.StopStatus ?? 0)
          : null,
        etaTone: (seconds === null ? 'muted' : seconds <= 180 ? 'urgent' : 'live') as RouteDetail['stops'][number]['etaTone'],
      },
      state: routeEtaStateFromTdx({
        hasRealtimeRecord: Boolean(eta),
        estimateSeconds: seconds,
        stopStatus: eta?.StopStatus,
      }),
    }
  })

  return {
    detail: {
      routeName: query.routeName,
      direction: query.direction,
      label: group.label,
      stops: timeline.map((row) => row.stop),
    },
    states: timeline.map((row) => row.state),
  }
}

function routeTimelineEtaUrl(query: ResolvedBusQuery): URL {
  const url = new URL(
    `${ETA_API_BASE}/${tdxRouteScope(query.city, query.routeUid)}/${encodeURIComponent(query.routeName)}`,
  )
  url.searchParams.set('$select', ROUTE_TIMELINE_ETA_SELECT)
  url.searchParams.set('$filter', `Direction eq ${query.direction}`)
  url.searchParams.set('$format', 'JSON')
  return url
}

function withSelectedStopStatusWhenUnknown(
  detail: RouteDetail,
  states: readonly RouteEtaPresentationState[],
  selectedStatus: string,
): RouteDetail {
  if (detail.stops.length !== states.length) {
    throw new Error('Route ETA presentation state does not match the station timeline')
  }
  return {
    ...detail,
    stops: detail.stops.map((stop, index) => stop.selected && routeEtaIsUnknown(states[index])
      ? { ...stop, etaLabel: selectedStatus, etaTone: 'muted' }
      : stop),
  }
}

function unavailableLabel(warning: TDXWarning): string {
  if (warning === 'tdx-quota') return '額度不可用'
  if (warning === 'tdx-rate-limit') return '即時忙線'
  return '即時未更新'
}
