import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetMemoryCacheForTests } from '../lib/memory-cache'
import { resetTDXTestState } from '../lib/tdx'
import map from './map'

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

function environment() {
  const bundle = {
    version: 'v1',
    placeId: 'PLACE1',
    name: '測試站',
    routes: [{
      routeUid: 'TPE1',
      routeName: '307',
      variantKey: 'TPE1:0',
      direction: 0,
      label: 'A → B',
      subRouteName: '307',
      stopUid: 'STOP1',
      stopSequence: 1,
      stopName: '測試站',
      schedules: [],
    }],
  }
  return {
    TDX_CLIENT_ID: 'shared-id',
    TDX_CLIENT_SECRET: 'shared-secret',
    TRANSIT_DB: database(),
    TRANSIT_SHAPES: {
      get: vi.fn(async () => ({ json: async () => bundle })),
    } as unknown as R2Bucket,
  }
}

describe('map place arrivals snapshot-only mode', () => {
  beforeEach(() => {
    resetMemoryCacheForTests()
    resetTDXTestState()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
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

  it('returns the active place bundle without any TDX access when realtime=0', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('TDX must not be called') })
    vi.stubGlobal('fetch', fetchMock)

    const response = await map.request(
      'https://bus.example/api/v1/map/place/PLACE1/arrivals?city=Taipei&realtime=0',
      {},
      environment(),
    )
    const body = await response.json<{
      scheduleSource: string
      snapshotVersion: string | null
      routes: Array<{ routeUid: string; source: string }>
      realtime: { candidates: number; queries: number; rateLimited: boolean }
    }>()

    expect(response.status).toBe(200)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(body.scheduleSource).toBe('place-bundle')
    expect(body.snapshotVersion).toBe('v1')
    expect(body.realtime).toEqual({ candidates: 0, queries: 0, rateLimited: false })
    expect(body.routes).toEqual([
      expect.objectContaining({ routeUid: 'TPE1', source: 'none' }),
    ])
  })

  it('rejects ambiguous realtime values before any upstream access', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('TDX must not be called') })
    vi.stubGlobal('fetch', fetchMock)

    const response = await map.request(
      'https://bus.example/api/v1/map/place/PLACE1/arrivals?city=Taipei&realtime=2',
      {},
      environment(),
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: 'realtime 必須是 0 或 1',
      code: 'INVALID_QUERY',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
