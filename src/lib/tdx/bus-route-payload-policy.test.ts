import { describe, expect, it } from 'vitest'
import type { TelemetryCity } from '../../observability/telemetry'
import {
  createTDXBusRouteQueries,
  type TDXBusRouteQueryDependencies,
} from './bus-route-queries'
import type { TDXEnv, TDXResolutionOptions } from './resolution-cache'

const env = {} as unknown as TDXEnv
const ROUTE_SELECT = 'RouteUID,RouteName,DepartureStopNameZh,DestinationStopNameZh'
const ETA_SELECT = 'RouteUID,RouteName,SubRouteUID,StopUID,StopName,Direction,EstimateTime,StopStatus'
const STOP_SELECT = 'StopUID,StopPosition'

type FetchCall = {
  url: URL
  options?: TDXResolutionOptions<unknown>
}

function harness(
  responder: (url: URL) => unknown | Promise<unknown>,
) {
  const calls: FetchCall[] = []
  const fetchTDXJson: TDXBusRouteQueryDependencies['fetchTDXJson'] = async <T>(
    _env: TDXEnv,
    url: URL,
    _ttlSeconds: number,
    options?: TDXResolutionOptions<T>,
  ): Promise<T> => {
    calls.push({ url, options: options as TDXResolutionOptions<unknown> | undefined })
    return await responder(url) as T
  }

  return {
    calls,
    queries: createTDXBusRouteQueries({
      fetchTDXJson,
      telemetryCity: (value): TelemetryCity | null => value === 'Taipei' ? 'Taipei' : null,
    }),
  }
}

function parameterNames(url: URL): string[] {
  if (!url.search) return []
  return url.search.slice(1).split('&').map((pair) => decodeURIComponent(pair.split('=', 1)[0]))
}

describe('TDX route discovery payload policy', () => {
  it('requests only route-catalog fields used by presentation', async () => {
    const { calls, queries } = harness(() => [{
      RouteUID: 'R307',
      RouteName: { Zh_tw: '307' },
      DepartureStopNameZh: '板橋',
      DestinationStopNameZh: '撫遠街',
    }])

    await expect(queries.getRouteCatalog(env, 'Taipei')).resolves.toEqual([
      expect.objectContaining({ routeUid: 'R307', routeName: '307' }),
    ])

    expect(calls).toHaveLength(1)
    expect(calls[0].url.pathname).toBe('/api/basic/v2/Bus/Route/City/Taipei')
    expect(calls[0].url.searchParams.get('$select')).toBe(ROUTE_SELECT)
    expect(calls[0].url.searchParams.get('$format')).toBe('JSON')
    expect(calls[0].options).toMatchObject({ operation: 'route_catalog', city: 'Taipei' })
  })

  it('trims same-stop ETA and Stop payloads while preserving filter ordering and escaping', async () => {
    const { calls, queries } = harness((url) => {
      if (url.pathname.includes('/EstimatedTimeOfArrival/City/')) return [{
        RouteUID: 'R307', RouteName: { Zh_tw: '307' }, SubRouteUID: 'R307-A',
        StopUID: 'CITY-A', StopName: { Zh_tw: "共同'站" }, Direction: 0, EstimateTime: 120,
      }]
      if (url.pathname.includes('/Stop/City/')) return [{
        StopUID: 'CITY-A', StopPosition: { PositionLat: 25, PositionLon: 121 },
      }]
      if (url.pathname.includes('/Route/City/')) return [{
        RouteUID: 'R307', RouteName: { Zh_tw: '307' },
        DepartureStopNameZh: '板橋', DestinationStopNameZh: '撫遠街',
      }]
      if (url.pathname.includes('/InterCity')) return []
      throw new Error(`unexpected URL: ${url}`)
    })

    await expect(queries.getStopRouteSuggestions(env, 'Taipei', "共同'站", 'CITY-A'))
      .resolves.toEqual([
        expect.objectContaining({ routeUid: 'R307', stopUid: 'CITY-A', label: '2 分' }),
      ])

    const etaCalls = calls.filter(({ url }) => url.pathname.includes('/EstimatedTimeOfArrival/'))
    const stopCalls = calls.filter(({ url }) => url.pathname.includes('/Stop/'))
    const routeCalls = calls.filter(({ url }) => url.pathname.includes('/Route/'))

    expect(etaCalls).toHaveLength(2)
    expect(stopCalls).toHaveLength(2)
    expect(routeCalls).toHaveLength(2)

    for (const { url } of etaCalls) {
      expect(url.searchParams.get('$filter')).toBe("StopName/Zh_tw eq '共同''站'")
      expect(url.searchParams.get('$select')).toBe(ETA_SELECT)
      expect(url.searchParams.get('$format')).toBe('JSON')
      expect(parameterNames(url)).toEqual(['$filter', '$select', '$format'])
    }

    for (const { url } of stopCalls) {
      expect(url.searchParams.get('$filter')).toBe("StopName/Zh_tw eq '共同''站'")
      expect(url.searchParams.get('$select')).toBe(STOP_SELECT)
      expect(url.searchParams.get('$format')).toBe('JSON')
      expect(parameterNames(url)).toEqual(['$filter', '$select', '$format'])
    }

    for (const { url } of routeCalls) {
      expect(url.searchParams.get('$select')).toBe(ROUTE_SELECT)
      expect(url.searchParams.get('$format')).toBe('JSON')
      expect(parameterNames(url)).toEqual(['$select', '$format'])
    }
  })
})
