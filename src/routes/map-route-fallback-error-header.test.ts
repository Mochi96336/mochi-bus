import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PatternStopFallbackObserver } from '../infrastructure/transit/snapshot-pattern-stop-repository'
import type { MapEnv } from './map-http-context'
import { readRouteMap } from './map-route-reads'

const patternStops = vi.hoisted(() => ({
  getSnapshotRouteVariants: vi.fn(),
}))
const tdxMap = vi.hoisted(() => ({ getRouteMapVariants: vi.fn() }))

vi.mock('../infrastructure/transit/snapshot-pattern-stop-repository', () => patternStops)
vi.mock('../infrastructure/tdx/map', () => tdxMap)
vi.mock('../observability/production-log', () => ({ logProductionError: vi.fn() }))

const bindings = {
  TDX_CLIENT_ID: 'shared-id',
  TDX_CLIENT_SECRET: 'shared-secret',
  TRANSIT_DB: {} as D1Database,
  TRANSIT_SHAPES: {} as R2Bucket,
} as MapEnv['Bindings']

function request(): Promise<Response> {
  const app = new Hono<MapEnv>()
  app.get('/api/v1/map/route', readRouteMap)
  return Promise.resolve(app.request('https://bus.example/api/v1/map/route?city=Hsinchu&route=100', {}, bindings))
}

beforeEach(() => {
  patternStops.getSnapshotRouteVariants.mockReset()
  tdxMap.getRouteMapVariants.mockReset()
})

describe('route fallback error header', () => {
  it('exposes only the bounded fallback reason after a fallback-selected terminal error', async () => {
    patternStops.getSnapshotRouteVariants.mockImplementation(async (
      _env: MapEnv['Bindings'],
      city: string,
      _routeName: string,
      observeFallback?: PatternStopFallbackObserver,
    ) => {
      observeFallback?.({ city, snapshotVersion: 'v1', reason: 'manifest_missing' })
      throw new Error('private legacy failure detail')
    })

    const response = await request()
    const body = await response.text()

    expect(response.status).toBe(502)
    expect(response.headers.get('X-Mochi-Snapshot-Fallback-Reason')).toBe('manifest_missing')
    expect(JSON.parse(body)).toEqual({ error: '暫時無法取得路線地圖' })
    expect(body).not.toContain('private legacy failure detail')
  })

  it('does not invent a fallback reason for a terminal error before fallback selection', async () => {
    patternStops.getSnapshotRouteVariants.mockRejectedValue(new Error('private snapshot failure detail'))

    const response = await request()

    expect(response.status).toBe(502)
    expect(response.headers.has('X-Mochi-Snapshot-Fallback-Reason')).toBe(false)
  })
})
