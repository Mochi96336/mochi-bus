import type { BusQuery, Direction, ResolvedBusQuery } from '../../domain/bus-query'
import { selectBestEta } from '../../domain/map/eta'
import {
  routeEtaStateFromTdx,
  type RouteEtaPresentationState,
} from '../../domain/route-eta-status'
import { selectRouteStopGroup } from '../../domain/route-stop-group-selection'
import {
  nextScheduledMinutes,
  scheduleClockLabel,
  type ScheduleItem,
} from '../../domain/schedule'
import type { TDXWarning } from '../../domain/tdx-warning'
import type { TransitBindings } from '../../infrastructure/transit/snapshot-repository'
import { logProductionError } from '../../observability/production-log'
import {
  isRejectedUserTdxToken,
  tdxWarningFromError,
} from './error-classification'
import {
  formatETALabel,
  toETAResult,
  type BusETAItem,
  type ETAResult,
} from './eta-formatting'
import {
  BUS_ETA_CACHE_SECONDS,
  QueryResolutionError,
  tdxRouteScope,
  type StopGroup,
} from './bus-route-queries'
import type {
  TDXEnv,
  TDXResolutionOptions,
} from './resolution-cache'

const ETA_API_BASE = 'https://tdx.transportdata.tw/api/basic/v2/Bus/EstimatedTimeOfArrival'
const SINGLE_STOP_ETA_SELECT = [
  'RouteUID',
  'SubRouteUID',
  'StopUID',
  'StopName',
  'Direction',
  'EstimateTime',
  'StopStatus',
  'DataTime',
  'SrcUpdateTime',
  'SrcTransTime',
  'UpdateTime',
].join(',')
const ROUTE_TIMELINE_ETA_SELECT = [
  'RouteUID',
  'SubRouteUID',
  'StopUID',
  'Direction',
  'EstimateTime',
  'StopStatus',
].join(',')

// 「estimated 淡墨」保留給未來的時刻表 fallback；Route timeline目前只呈現即時ETA。
// 空白不可解讀為已過站，因為也可能是缺漏、支線對應或尚未發車。
export type RouteEtaTone = 'live' | 'urgent' | 'muted'

export type RouteDetail = {
  routeName: string
  direction: Direction
  label: string
  stops: Array<{
    stopUid: string
    stopName: string
    sequence: number
    selected: boolean
    etaLabel: string | null
    etaTone: RouteEtaTone
  }>
}

export type RouteDetailWithEtaStates = {
  detail: RouteDetail
  states: RouteEtaPresentationState[]
}

export type TDXCommuteRoutePresentationDependencies = {
  fetchTDXJson: <T>(
    env: TDXEnv,
    url: URL,
    ttlSeconds: number,
    options?: TDXResolutionOptions<T>,
  ) => Promise<T>
  getRouteStopGroups: (
    env: TDXEnv,
    city: string,
    routeName: string,
    routeUid?: string,
  ) => Promise<StopGroup[]>
  getBusSchedule: (
    env: TDXEnv,
    city: string,
    routeName: string,
    routeUid?: string,
  ) => Promise<ScheduleItem[]>
  getSnapshotSchedule: (
    env: TDXEnv & TransitBindings,
    city: string,
    routeName: string,
    routeUid?: string,
  ) => Promise<ScheduleItem[] | null>
  now?: () => Date
}

// This boundary owns commute/route presentation decisions only: realtime selection,
// schedule fallback labels and route timeline ETA states. Token, HTTP, cache, circuit,
// route catalog and schedule endpoint ownership remain behind injected dependencies.
// Snapshot access must stay lazy at composition so unrelated callers and module mocks
// are not forced to provide the snapshot export during façade initialization.
export function createTDXCommuteRoutePresentation(
  dependencies: TDXCommuteRoutePresentationDependencies,
) {
  const now = dependencies.now ?? (() => new Date())

  const getRouteETA = async (env: TDXEnv, query: ResolvedBusQuery): Promise<BusETAItem[]> => (
    dependencies.fetchTDXJson<BusETAItem[]>(env, routeTimelineEtaUrl(query), BUS_ETA_CACHE_SECONDS)
  )

  const getStopETA = async (env: TDXEnv, query: ResolvedBusQuery): Promise<BusETAItem[]> => (
    dependencies.fetchTDXJson<BusETAItem[]>(env, singleStopEtaUrl(query), BUS_ETA_CACHE_SECONDS)
  )

  const getCommuteETA = async (
    env: TDXEnv & Partial<TransitBindings>,
    query: ResolvedBusQuery,
  ): Promise<ETAResult> => {
    let items: BusETAItem[] = []
    let warning: TDXWarning | undefined
    try {
      items = await getStopETA(env, query)
    } catch (error) {
      if (isRejectedUserTdxToken(error, env.TDX_USER_ACCESS_TOKEN)) throw error
      warning = tdxWarningFromError(error)
      logProductionError({
        event: 'commute_eta_realtime_failed',
        operation: 'bus_eta',
        city: query.city,
        error,
      })
    }

    const item = selectBestEta(items, {
      routeUid: query.routeUid,
      stopUid: query.stopUid,
      direction: query.direction,
      subRouteUid: query.subRouteUid,
    })
    // 完全沒有即時資料時放入空item，讓時刻表fallback有機會接手；不放DataTime，
    // dataTime保持null，避免看起來像有新鮮即時資料。
    const result = toETAResult(item ?? {
      StopUID: query.stopUid,
      Direction: query.direction,
      StopStatus: 0,
    }, query, now())
    if (result.minutes !== null) return warning ? { ...result, warning } : result

    // 即時資料沒有預估時間時退回時刻表，避免小型客運即時回報不穩就一直顯示暫無資料。
    try {
      const schedules = env.TRANSIT_DB && env.TRANSIT_SHAPES
        ? await dependencies.getSnapshotSchedule(
            env as TDXEnv & TransitBindings,
            query.city,
            query.routeName,
            query.routeUid,
          ) ?? await dependencies.getBusSchedule(env, query.city, query.routeName, query.routeUid)
        : await dependencies.getBusSchedule(env, query.city, query.routeName, query.routeUid)
      const scheduleNow = now()
      const estimate = nextScheduledMinutes(schedules, {
        stopUid: query.stopUid,
        direction: query.direction,
        subRouteUid: query.subRouteUid,
      }, scheduleNow)
      if (estimate === null) return result
      return {
        ...result,
        minutes: estimate.minutes,
        estimateSeconds: estimate.minutes * 60,
        // 發車時間是下限，不可假裝成到站時間。
        label: estimate.headwayMinutes
          ? `${estimate.headwayMinutes[0]}–${estimate.headwayMinutes[1]} 分一班`
          : scheduleClockLabel(estimate, scheduleNow)
            ?? (estimate.departureBased
              ? `${Math.max(1, estimate.minutes)} 分後發車`
              : formatETALabel(estimate.minutes, result.stopStatus)),
        statusLabel: estimate.headwayMinutes
          ? '班距預估'
          : estimate.nextDay
            ? '今日已收班'
            : estimate.departureBased ? '時刻表發車預估' : '時刻表預估',
        source: 'schedule',
        warning,
      }
    } catch (error) {
      if (isRejectedUserTdxToken(error, env.TDX_USER_ACCESS_TOKEN)) throw error
      warning ??= tdxWarningFromError(error)
      logProductionError({
        event: 'eta_schedule_fallback_failed',
        operation: 'bus_eta',
        city: query.city,
        error,
      })
      return warning ? { ...result, warning } : result
    }
  }

  const getRouteDetail = async (
    env: TDXEnv,
    query: ResolvedBusQuery,
  ): Promise<RouteDetailWithEtaStates> => {
    // Both reads still start in parallel, but station order must finish its full
    // resolution/cache lifecycle before an ETA failure escapes. Otherwise a fast
    // 429 can open the credential circuit between singleflight cleanup and the
    // fallback station-order cache write, turning a degradable response into 429.
    const [groupsResult, etaItemsResult] = await Promise.allSettled([
      dependencies.getRouteStopGroups(env, query.city, query.routeName, query.routeUid),
      getRouteETA(env, query),
    ])
    if (groupsResult.status === 'rejected') throw groupsResult.reason
    if (etaItemsResult.status === 'rejected') throw etaItemsResult.reason

    const groups = groupsResult.value
    const etaItems = etaItemsResult.value
    const group = selectRouteStopGroup(groups, query)

    if (!group) throw new QueryResolutionError('找不到這個方向的完整站序')
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
          etaTone: (seconds === null ? 'muted' : seconds <= 180 ? 'urgent' : 'live') as RouteEtaTone,
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

  return { getCommuteETA, getRouteDetail }
}

function routeEtaUrl(query: BusQuery): URL {
  const url = new URL(
    `${ETA_API_BASE}/${tdxRouteScope(query.city, query.routeUid)}/${encodeURIComponent(query.routeName)}`,
  )
  url.searchParams.set('$format', 'JSON')
  return url
}

function routeTimelineEtaUrl(query: ResolvedBusQuery): URL {
  const url = routeEtaUrl(query)
  url.searchParams.set('$select', ROUTE_TIMELINE_ETA_SELECT)
  // The timeline only renders one direction. Pushing this invariant upstream drops the
  // opposite-direction rows while local StopUID/RouteUID/SubRouteUID matching stays defensive.
  url.searchParams.set('$filter', `Direction eq ${query.direction}`)
  return url
}

function singleStopEtaUrl(query: ResolvedBusQuery): URL {
  // RouteUID is the stable identity needed to use the collection endpoint safely.
  // Legacy/ambiguous callers without it keep the previous route-scoped behavior.
  if (!query.routeUid) return routeEtaUrl(query)

  const url = new URL(`${ETA_API_BASE}/${tdxRouteScope(query.city, query.routeUid)}`)
  url.searchParams.set('$filter', [
    `StopUID eq '${escapeODataString(query.stopUid)}'`,
    `RouteUID eq '${escapeODataString(query.routeUid)}'`,
    `Direction eq ${query.direction}`,
  ].join(' and '))
  url.searchParams.set('$select', SINGLE_STOP_ETA_SELECT)
  url.searchParams.set('$format', 'JSON')
  return url
}

function escapeODataString(value: string): string {
  return value.replaceAll("'", "''")
}
