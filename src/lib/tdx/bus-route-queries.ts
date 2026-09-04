import type { BusQuery, Direction, ResolvedBusQuery } from '../../domain/bus-query'
import { classifyRouteName, type RouteCategory } from '../../domain/route-category'
import type { TelemetryCity } from '../../observability/telemetry'
import {
  formatETALabel,
  type BusETAItem,
  type LocalizedName,
} from './eta-formatting'
import type {
  TDXEnv,
  TDXResolutionOptions,
} from './resolution-cache'

export const BUS_ETA_CACHE_SECONDS = 12
const STATIC_CACHE_SECONDS = 60 * 60
const BUS_API_BASE = 'https://tdx.transportdata.tw/api/basic/v2/Bus'
const ROUTE_CATALOG_SELECT = 'RouteUID,RouteName,DepartureStopNameZh,DestinationStopNameZh'
const STOP_SUGGESTION_ETA_SELECT = [
  'RouteUID',
  'RouteName',
  'SubRouteUID',
  'StopUID',
  'StopName',
  'Direction',
  'EstimateTime',
  'StopStatus',
].join(',')
const STOP_SUGGESTION_STOP_SELECT = 'StopUID,StopPosition'

type StopOfRouteItem = {
  RouteUID?: string
  RouteName?: LocalizedName
  SubRouteUID?: string
  SubRouteName?: LocalizedName
  Direction?: number
  Stops?: Array<{
    StopUID?: string
    StopName?: LocalizedName
    StopSequence?: number
    StopPosition?: {
      PositionLat?: number
      PositionLon?: number
    }
  }>
}

type RouteItem = {
  RouteUID?: string
  RouteName?: LocalizedName
  DepartureStopNameZh?: string
  DestinationStopNameZh?: string
}

type StopItem = {
  StopUID?: string
  StopName?: LocalizedName
  StopPosition?: {
    PositionLat?: number
    PositionLon?: number
  }
}

export type RouteCatalogItem = {
  routeUid?: string
  routeName: string
  departure?: string
  destination?: string
  category: RouteCategory
}

export type RouteStop = {
  routeUid?: string
  subRouteUid?: string
  subRouteName: string
  stopUid: string
  stopName: string
  direction: Direction
  sequence: number
  position?: {
    latitude: number
    longitude: number
  }
}

export type StopGroup = {
  direction: Direction
  label: string
  routeUid?: string
  subRouteUid?: string
  subRouteName: string
  stops: RouteStop[]
}

export type StopRouteSuggestion = ResolvedBusQuery & {
  label: string
  directionLabel: string
}

export class QueryResolutionError extends Error {
  constructor(message: string, readonly candidates: RouteStop[] = []) {
    super(message)
    this.name = 'QueryResolutionError'
  }
}

export type TDXBusRouteQueryDependencies = {
  fetchTDXJson: <T>(
    env: TDXEnv,
    url: URL,
    ttlSeconds: number,
    options?: TDXResolutionOptions<T>,
  ) => Promise<T>
  telemetryCity: (value: string) => TelemetryCity | null
}

// Route/query ownership lives here: endpoint construction, route catalogs, stop groups,
// query resolution and same-stop suggestions. Token, HTTP, cache and circuit state stay
// behind the injected resolution façade.
export function createTDXBusRouteQueries(dependencies: TDXBusRouteQueryDependencies) {
  const getRouteStopGroups = async (
    env: TDXEnv,
    city: string,
    routeName: string,
    routeUid?: string,
  ): Promise<StopGroup[]> => {
    const url = formattedBusUrl(
      `StopOfRoute/${tdxRouteScope(city, routeUid)}/${encodeURIComponent(routeName)}`,
    )
    let data = await dependencies.fetchTDXJson<StopOfRouteItem[]>(env, url, STATIC_CACHE_SECONDS)
    // setup只帶路名時無法從RouteUID判斷公路客運；市區端點為空才退到InterCity。
    if (!data.length && !routeUid) {
      data = await dependencies.fetchTDXJson<StopOfRouteItem[]>(
        env,
        formattedBusUrl(`StopOfRoute/InterCity/${encodeURIComponent(routeName)}`),
        STATIC_CACHE_SECONDS,
      )
    }

    const groups = data
      .filter((item): item is StopOfRouteItem & { Direction: Direction } => (
        item.Direction === 0 || item.Direction === 1 || item.Direction === 2
      ))
      .map((item) => {
        const stops = (item.Stops ?? [])
          .filter((stop): stop is typeof stop & { StopUID: string } => Boolean(
            stop.StopUID && stop.StopName?.Zh_tw,
          ))
          .map((stop) => ({
            routeUid: item.RouteUID,
            subRouteUid: item.SubRouteUID,
            subRouteName: item.SubRouteName?.Zh_tw ?? item.RouteName?.Zh_tw ?? routeName,
            stopUid: stop.StopUID,
            stopName: stop.StopName?.Zh_tw ?? '未知站牌',
            direction: item.Direction,
            sequence: stop.StopSequence ?? 0,
            position: typeof stop.StopPosition?.PositionLat === 'number'
              && typeof stop.StopPosition.PositionLon === 'number'
              ? {
                  latitude: stop.StopPosition.PositionLat,
                  longitude: stop.StopPosition.PositionLon,
                }
              : undefined,
          }))
          .sort((a, b) => a.sequence - b.sequence)

        const first = stops.at(0)?.stopName ?? '起點未知'
        const last = stops.at(-1)?.stopName ?? '終點未知'
        return {
          direction: item.Direction,
          label: `${first} → ${last}`,
          routeUid: item.RouteUID,
          subRouteUid: item.SubRouteUID,
          subRouteName: item.SubRouteName?.Zh_tw ?? item.RouteName?.Zh_tw ?? routeName,
          stops,
        }
      })
      .filter((group) => group.stops.length > 0)

    return mergeEquivalentStopGroups(groups)
  }

  const resolveBusQuery = async (env: TDXEnv, query: BusQuery): Promise<ResolvedBusQuery> => {
    const groups = await getRouteStopGroups(env, query.city, query.routeName, query.routeUid)
    const candidates = groups
      .flatMap((group) => group.stops)
      .filter((stop) => stop.direction === query.direction)
      .filter((stop) => query.stopUid
        ? stop.stopUid === query.stopUid
        : stop.stopName === query.stopName)
      // 同一站牌可能有多條支線共用stopUid；有subRouteUid時必須排除其他支線。
      .filter((stop) => !query.subRouteUid || stop.subRouteUid === query.subRouteUid)

    const unique = dedupeStops(candidates)
    if (unique.length === 0) {
      throw new QueryResolutionError(`找不到 ${query.routeName} 的 ${query.stopName ?? query.stopUid}`)
    }
    if (unique.length > 1) {
      throw new QueryResolutionError('找到多個同名站牌，請選擇正確站牌', unique)
    }

    const match = unique[0]
    return {
      ...query,
      routeUid: query.routeUid ?? match.routeUid,
      subRouteUid: query.subRouteUid ?? match.subRouteUid,
      stopUid: match.stopUid,
      stopName: match.stopName,
    }
  }

  const getRouteCatalog = async (env: TDXEnv, city: string): Promise<RouteCatalogItem[]> => {
    const url = busUrl(`Route/City/${encodeURIComponent(city)}`)
    url.searchParams.set('$select', ROUTE_CATALOG_SELECT)
    url.searchParams.set('$format', 'JSON')
    const data = await dependencies.fetchTDXJson<RouteItem[]>(
      env,
      url,
      STATIC_CACHE_SECONDS,
      {
        operation: 'route_catalog',
        city: dependencies.telemetryCity(city),
        validate: isRecordArrayPayload,
      },
    )
    return mapRouteCatalog(data)
  }

  const getIntercityRouteCatalog = async (env: TDXEnv): Promise<RouteCatalogItem[]> => {
    const url = busUrl('Route/InterCity')
    url.searchParams.set('$select', ROUTE_CATALOG_SELECT)
    url.searchParams.set('$format', 'JSON')
    const data = await dependencies.fetchTDXJson<RouteItem[]>(env, url, STATIC_CACHE_SECONDS, {
      operation: 'route_catalog',
      city: null,
      validate: isRecordArrayPayload,
    })
    return mapRouteCatalog(data, false)
  }

  const getStopRouteSuggestions = async (
    env: TDXEnv,
    city: string,
    stopName: string,
    anchorStopUid?: string,
  ): Promise<StopRouteSuggestion[]> => {
    const filter = `StopName/Zh_tw eq '${stopName.replaceAll("'", "''")}'`
    const filteredUrl = (path: string, select: string) => {
      const url = busUrl(path)
      url.searchParams.set('$filter', filter)
      url.searchParams.set('$select', select)
      url.searchParams.set('$format', 'JSON')
      return url
    }

    // 公路客運與市區公車常共用同名站牌；InterCity失敗只少客運建議。
    const [data, stops, routes, intercityEta, intercityStops, intercityRoutes] = await Promise.all([
      dependencies.fetchTDXJson<BusETAItem[]>(
        env,
        filteredUrl(`EstimatedTimeOfArrival/City/${encodeURIComponent(city)}`, STOP_SUGGESTION_ETA_SELECT),
        BUS_ETA_CACHE_SECONDS,
      ),
      dependencies.fetchTDXJson<StopItem[]>(
        env,
        filteredUrl(`Stop/City/${encodeURIComponent(city)}`, STOP_SUGGESTION_STOP_SELECT),
        STATIC_CACHE_SECONDS,
      ),
      getRouteCatalog(env, city),
      dependencies.fetchTDXJson<BusETAItem[]>(
        env,
        filteredUrl('EstimatedTimeOfArrival/InterCity', STOP_SUGGESTION_ETA_SELECT),
        BUS_ETA_CACHE_SECONDS,
      ).catch(() => [] as BusETAItem[]),
      dependencies.fetchTDXJson<StopItem[]>(
        env,
        filteredUrl('Stop/InterCity', STOP_SUGGESTION_STOP_SELECT),
        STATIC_CACHE_SECONDS,
      ).catch(() => [] as StopItem[]),
      getIntercityRouteCatalog(env).catch(() => [] as RouteCatalogItem[]),
    ])

    const nearbyStopUids = findNearbyStopUids([...stops, ...intercityStops], anchorStopUid)
    const routeByUid = new Map([...routes, ...intercityRoutes]
      .filter((route) => route.routeUid)
      .map((route) => [route.routeUid as string, route]))

    const suggestions = [...data, ...intercityEta]
      .filter((item): item is BusETAItem & {
        StopUID: string
        StopName: { Zh_tw: string }
        Direction: Direction
      } => Boolean(item.StopUID && item.StopName?.Zh_tw && item.RouteName?.Zh_tw)
        && (item.Direction === 0 || item.Direction === 1))
      .filter((item) => nearbyStopUids.size === 0 || nearbyStopUids.has(item.StopUID))
      .map((item) => {
        const route = item.RouteUID ? routeByUid.get(item.RouteUID) : undefined
        const from = item.Direction === 0 ? route?.departure : route?.destination
        const to = item.Direction === 0 ? route?.destination : route?.departure
        return {
          city,
          routeName: item.RouteName?.Zh_tw ?? '未知路線',
          routeUid: item.RouteUID,
          subRouteUid: item.SubRouteUID,
          stopName: item.StopName.Zh_tw,
          stopUid: item.StopUID,
          direction: item.Direction,
          directionLabel: from && to ? `${from} → ${to}` : '',
          label: formatETALabel(
            typeof item.EstimateTime === 'number'
              ? Math.ceil(Math.max(0, item.EstimateTime) / 60)
              : null,
            item.StopStatus ?? 0,
          ),
        }
      })

    return [...new Map(suggestions.map((item) => [
      `${item.routeUid ?? item.routeName}:${item.subRouteUid ?? ''}:${item.stopUid}:${item.direction}`,
      item,
    ])).values()]
      .sort((a, b) => a.routeName.localeCompare(b.routeName, 'zh-Hant', { numeric: true }))
      .slice(0, 40)
  }

  return {
    resolveBusQuery,
    getRouteStopGroups,
    getRouteCatalog,
    getStopRouteSuggestions,
  }
}

// 公路客運資源掛在/InterCity；RouteUID固定THB開頭。
export function tdxRouteScope(city: string, routeUid?: string): string {
  return routeUid?.startsWith('THB') ? 'InterCity' : `City/${encodeURIComponent(city)}`
}

export function mergeEquivalentStopGroups(groups: StopGroup[]): StopGroup[] {
  const merged = new Map<string, StopGroup>()
  for (const group of groups) {
    // 相同站序不代表相同支線；RouteUID/SubRouteUID不同時必須保留。
    const signature = [
      group.routeUid ?? '',
      group.subRouteUid ?? '',
      group.direction,
      group.stops.map((stop) => stop.stopName).join('>'),
    ].join(':')
    const existing = merged.get(signature)
    if (!existing) {
      merged.set(signature, group)
      continue
    }

    const names = new Set([...existing.subRouteName.split('／'), group.subRouteName])
    existing.subRouteName = [...names].join('／')
  }
  return [...merged.values()]
}

function busUrl(path: string): URL {
  return new URL(`${BUS_API_BASE}/${path}`)
}

function formattedBusUrl(path: string): URL {
  const url = busUrl(path)
  url.searchParams.set('$format', 'JSON')
  return url
}

function mapRouteCatalog(items: RouteItem[], dedupeAndSort = true): RouteCatalogItem[] {
  const routes = items
    .filter((item): item is RouteItem & { RouteName: { Zh_tw: string } } => Boolean(
      item.RouteName?.Zh_tw,
    ))
    .map((item) => ({
      routeUid: item.RouteUID,
      routeName: item.RouteName.Zh_tw,
      departure: item.DepartureStopNameZh,
      destination: item.DestinationStopNameZh,
      category: classifyRouteName(item.RouteName.Zh_tw, item.RouteUID),
    }))

  if (!dedupeAndSort) return routes
  return [...new Map(routes.map((route) => [
    route.routeUid ?? `${route.routeName}:${route.departure ?? ''}:${route.destination ?? ''}`,
    route,
  ])).values()]
    .sort((a, b) => a.routeName.localeCompare(b.routeName, 'zh-Hant', { numeric: true })
      || (a.routeUid ?? '').localeCompare(b.routeUid ?? ''))
}

function isRecordArrayPayload<T extends object>(value: unknown): value is T[] {
  return Array.isArray(value)
    && value.every((item) => item !== null && typeof item === 'object' && !Array.isArray(item))
}

function dedupeStops(stops: RouteStop[]): RouteStop[] {
  return [...new Map(stops.map((stop) => [[
    stop.routeUid ?? '',
    stop.subRouteUid ?? '',
    stop.direction,
    stop.stopUid,
  ].join(':'), stop])).values()]
}

function findNearbyStopUids(stops: StopItem[], anchorStopUid?: string): Set<string> {
  if (!anchorStopUid) return new Set()
  const anchor = stops.find((stop) => stop.StopUID === anchorStopUid)?.StopPosition
  if (typeof anchor?.PositionLat !== 'number' || typeof anchor.PositionLon !== 'number') {
    return new Set([anchorStopUid])
  }

  return new Set(stops
    .filter((stop) => stop.StopUID
      && typeof stop.StopPosition?.PositionLat === 'number'
      && typeof stop.StopPosition.PositionLon === 'number')
    .filter((stop) => distanceMeters(
      anchor.PositionLat as number,
      anchor.PositionLon as number,
      stop.StopPosition?.PositionLat as number,
      stop.StopPosition?.PositionLon as number,
    ) <= 25)
    .map((stop) => stop.StopUID as string))
}

function distanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const radius = 6_371_000
  const toRadians = (degrees: number) => degrees * Math.PI / 180
  const deltaLat = toRadians(lat2 - lat1)
  const deltaLon = toRadians(lon2 - lon1)
  const a = Math.sin(deltaLat / 2) ** 2
    + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(deltaLon / 2) ** 2
  return 2 * radius * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}