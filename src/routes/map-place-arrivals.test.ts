import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetMemoryCacheForTests } from '../lib/memory-cache'
import { resetTDXTestState } from '../lib/tdx'
import map from './map'

type BundleRoute = {
  routeUid: string
  routeName: string
  variantKey: string
  direction: 0 | 1 | 2
  label: string
  subRouteUid?: string
  subRouteName: string
  stopUid: string
  stopSequence: number
  stopName: string
  schedules: []
}

function database(): D1Database {
  return {
    prepare() {
      const statement = {
        bind: () => statement,
        first: async () => ({ active_version: 'v1' }),
        all: async () => ({ success: true, results: [], meta: {} }),
      }
      return statement
    },
    batch: async () => [],
  } as unknown as D1Database
}

function environment(routes: BundleRoute[]) {
  const bundle = {
    version: 'v1',
    placeId: 'PLACE1',
    name: '測試站',
    routes,
  }
  return {
    TRANSIT_DB: database(),
    TRANSIT_SHAPES: {
      get: vi.fn(async () => ({ json: async () => bundle })),
    } as unknown as R2Bucket,
  }
}

function requestUrl(input: RequestInfo | URL): URL {
  if (input instanceof Request) return new URL(input.url)
  return new URL(String(input))
}

function parsedConsoleCalls(calls: readonly (readonly unknown[])[]): Array<Record<string, unknown>> {
  return calls.flatMap(([value]) => {
    if (typeof value !== 'string') return []
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? [parsed as Record<string, unknown>]
        : []
    } catch {
      return []
    }
  })
}

describe('map place arrivals batching', () => {
  beforeEach(() => {
    resetMemoryCacheForTests()
    resetTDXTestState()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    vi.stubGlobal('caches', {
      default: {
        match: vi.fn(async () => undefined),
        put: vi.fn(async () => undefined),
      },
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    resetMemoryCacheForTests()
    resetTDXTestState()
  })

  it('uses one TDX request for multiple city routes', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input)
      expect(url.pathname).toBe('/api/basic/v2/Bus/EstimatedTimeOfArrival/City/Taipei')
      expect(url.searchParams.get('$filter')).toBe(
        "(StopUID eq 'STOP1' or StopUID eq 'STOP2') and (RouteUID eq 'TPE1' or RouteUID eq 'TPE2')",
      )
      expect(url.searchParams.get('$select')).toBe(
        'RouteUID,SubRouteUID,StopUID,Direction,EstimateTime,StopStatus',
      )
      return new Response(JSON.stringify([
        { RouteUID: 'TPE1', StopUID: 'STOP1', Direction: 0, EstimateTime: 120, StopStatus: 0 },
        { RouteUID: 'TPE2', StopUID: 'STOP2', Direction: 1, EstimateTime: 300, StopStatus: 0 },
      ]), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)

    const response = await map.request(
      'https://bus.example/api/v1/map/place/PLACE1/arrivals?city=Taipei',
      { headers: { Authorization: 'Bearer personal-token' } },
      environment([
        {
          routeUid: 'TPE1', routeName: '307', variantKey: 'TPE1:0', direction: 0,
          label: 'A → B', subRouteName: '307', stopUid: 'STOP1', stopSequence: 1,
          stopName: '測試站', schedules: [],
        },
        {
          routeUid: 'TPE2', routeName: '299', variantKey: 'TPE2:1', direction: 1,
          label: 'B → A', subRouteName: '299', stopUid: 'STOP2', stopSequence: 1,
          stopName: '測試站', schedules: [],
        },
      ]),
    )
    const body = await response.json<{
      routes: Array<{ routeUid: string; source: string }>
      realtime: { candidates: number; queries: number; rateLimited: boolean }
    }>()

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(body.realtime).toEqual({ candidates: 2, queries: 1, rateLimited: false })
    expect(body.routes).toEqual(expect.arrayContaining([
      expect.objectContaining({ routeUid: 'TPE1', source: 'realtime' }),
      expect.objectContaining({ routeUid: 'TPE2', source: 'realtime' }),
    ]))
  })

  it('uses valid rows without warning when neighboring rows are malformed or have unknown directions', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([
      { RouteUID: 'TPE1', StopUID: 'STOP1', Direction: 0, EstimateTime: 120, StopStatus: 0 },
      { RouteUID: 'TPE2', StopUID: 'STOP2', Direction: 255, EstimateTime: 300, StopStatus: 0 },
      { StopUID: 'STOP1', Direction: 0 },
    ]), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const response = await map.request(
      'https://bus.example/api/v1/map/place/PLACE1/arrivals?city=Taipei',
      { headers: { Authorization: 'Bearer personal-token' } },
      environment([
        {
          routeUid: 'TPE1', routeName: '307', variantKey: 'TPE1:0', direction: 0,
          label: 'A → B', subRouteName: '307', stopUid: 'STOP1', stopSequence: 1,
          stopName: '測試站', schedules: [],
        },
        {
          routeUid: 'TPE2', routeName: '299', variantKey: 'TPE2:1', direction: 1,
          label: 'B → A', subRouteName: '299', stopUid: 'STOP2', stopSequence: 1,
          stopName: '測試站', schedules: [],
        },
      ]),
    )
    const body = await response.json<{
      warning?: string
      routes: Array<{ routeUid: string; source: string }>
      realtime: { candidates: number; queries: number; rateLimited: boolean }
    }>()

    expect(response.status).toBe(200)
    expect(body.warning).toBeUndefined()
    expect(body.realtime).toEqual({ candidates: 2, queries: 1, rateLimited: false })
    expect(body.routes).toEqual(expect.arrayContaining([
      expect.objectContaining({ routeUid: 'TPE1', source: 'realtime' }),
      expect.objectContaining({ routeUid: 'TPE2', source: 'none' }),
    ]))

    const normalized = parsedConsoleCalls(vi.mocked(console.info).mock.calls)
      .find((entry) => entry.message === 'tdx_payload_rows_normalized')
    expect(normalized).toMatchObject({
      operation: 'place_arrivals',
      totalRows: 3,
      acceptedRows: 2,
      droppedRows: 1,
      issueCounts: { invalid_route_uid: 1 },
      unknownDirectionValues: [255],
    })
  })

  it('warns and avoids cache writes when a non-empty payload has no usable rows', async () => {
    const cachePut = vi.fn(async () => undefined)
    vi.stubGlobal('caches', {
      default: {
        match: vi.fn(async () => undefined),
        put: cachePut,
      },
    })
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([
      { RouteUID: 'TPE1', StopUID: 'STOP1', Direction: '0' },
      { RouteUID: 'OTHER', StopUID: 'STOP1', Direction: 0 },
    ]), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const response = await map.request(
      'https://bus.example/api/v1/map/place/PLACE1/arrivals?city=Taipei',
      { headers: { Authorization: 'Bearer personal-token' } },
      environment([{
        routeUid: 'TPE1', routeName: '307', variantKey: 'TPE1:0', direction: 0,
        label: 'A → B', subRouteName: '307', stopUid: 'STOP1', stopSequence: 1,
        stopName: '測試站', schedules: [],
      }]),
    )
    const body = await response.json<{
      warning?: string
      routes: Array<{ routeUid: string; source: string }>
      realtime: { candidates: number; queries: number; rateLimited: boolean }
    }>()

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(cachePut).not.toHaveBeenCalled()
    expect(body.warning).toBe('tdx-unavailable')
    expect(body.realtime).toEqual({ candidates: 1, queries: 0, rateLimited: false })
    expect(body.routes).toEqual([
      expect.objectContaining({ routeUid: 'TPE1', source: 'none' }),
    ])
  })

  it('uses at most one request per City and InterCity scope', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input)
      if (url.pathname.endsWith('/City/Taipei')) {
        return new Response(JSON.stringify([
          { RouteUID: 'TPE1', StopUID: 'CITY_STOP', Direction: 0, EstimateTime: 120, StopStatus: 0 },
        ]), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.pathname.endsWith('/InterCity')) {
        return new Response(JSON.stringify([
          { RouteUID: 'THB1001', StopUID: 'THB_STOP', Direction: 0, EstimateTime: 240, StopStatus: 0 },
        ]), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response('unexpected scope', { status: 500 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const response = await map.request(
      'https://bus.example/api/v1/map/place/PLACE1/arrivals?city=Taipei',
      { headers: { Authorization: 'Bearer personal-token' } },
      environment([
        {
          routeUid: 'TPE1', routeName: '307', variantKey: 'TPE1:0', direction: 0,
          label: 'A → B', subRouteName: '307', stopUid: 'CITY_STOP', stopSequence: 1,
          stopName: '測試站', schedules: [],
        },
        {
          routeUid: 'THB1001', routeName: '國道客運', variantKey: 'THB1001:0', direction: 0,
          label: 'A → C', subRouteName: '國道客運', stopUid: 'THB_STOP', stopSequence: 1,
          stopName: '測試站', schedules: [],
        },
      ]),
    )
    const body = await response.json<{
      routes: Array<{ routeUid: string; source: string }>
      realtime: { candidates: number; queries: number; rateLimited: boolean }
    }>()

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls.map(([input]) => requestUrl(input).pathname)).toEqual([
      '/api/basic/v2/Bus/EstimatedTimeOfArrival/City/Taipei',
      '/api/basic/v2/Bus/EstimatedTimeOfArrival/InterCity',
    ])
    expect(body.realtime).toEqual({ candidates: 2, queries: 2, rateLimited: false })
    expect(body.routes.every((route) => route.source === 'realtime')).toBe(true)
  })

  it('stops before the second scope after TDX rate limiting', async () => {
    const fetchMock = vi.fn(async () => new Response('rate limited', { status: 429 }))
    vi.stubGlobal('fetch', fetchMock)

    const response = await map.request(
      'https://bus.example/api/v1/map/place/PLACE1/arrivals?city=Taipei',
      { headers: { Authorization: 'Bearer personal-token' } },
      environment([
        {
          routeUid: 'TPE1', routeName: '307', variantKey: 'TPE1:0', direction: 0,
          label: 'A → B', subRouteName: '307', stopUid: 'CITY_STOP', stopSequence: 1,
          stopName: '測試站', schedules: [],
        },
        {
          routeUid: 'THB1001', routeName: '國道客運', variantKey: 'THB1001:0', direction: 0,
          label: 'A → C', subRouteName: '國道客運', stopUid: 'THB_STOP', stopSequence: 1,
          stopName: '測試站', schedules: [],
        },
      ]),
    )
    const body = await response.json<{
      warning?: string
      realtime: { candidates: number; queries: number; rateLimited: boolean }
    }>()

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(body.warning).toBe('tdx-rate-limit')
    expect(body.realtime).toEqual({ candidates: 2, queries: 0, rateLimited: true })
  })
})
