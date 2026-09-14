import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RouteMapVariant } from '../domain/map/map-model'
import type { MapEnv } from './map-http-context'
import { readRouteMap } from './map-route-reads'

const patternStops = vi.hoisted(() => ({
  getSnapshotRouteVariants: vi.fn(),
}))
const tdxMap = vi.hoisted(() => ({
  getRouteMapVariants: vi.fn(),
}))

vi.mock('../infrastructure/transit/snapshot-pattern-stop-repository', () => patternStops)
vi.mock('../infrastructure/tdx/map', () => tdxMap)

const bindings = {
  TDX_CLIENT_ID: 'shared-id',
  TDX_CLIENT_SECRET: 'shared-secret',
  TRANSIT_DB: {} as D1Database,
  TRANSIT_SHAPES: {} as R2Bucket,
} as MapEnv['Bindings']

function request(): Promise<Response> {
  const app = new Hono<MapEnv>()
  app.get('/api/v1/map/route', readRouteMap)
  return Promise.resolve(app.request(
    'https://bus.example/api/v1/map/route?city=Taipei&route=307',
    {},
    bindings,
  ))
}

function denseVariant(): RouteMapVariant {
  return {
    variantKey: 'PATTERN-DENSE',
    routeName: '307',
    routeUid: 'TPE307',
    subRouteUid: 'SUB-DENSE',
    direction: 0,
    label: '板橋 → 撫遠街',
    subRouteName: '307',
    shape: {
      type: 'Feature',
      properties: { routeUid: 'TPE307', direction: 0 },
      geometry: {
        type: 'LineString',
        coordinates: [
          [121.5, 25],
          [121.50025, 25.00025],
          [121.5005, 25.0005],
          [121.50075, 25.00075],
          [121.501, 25.001],
        ],
      },
    },
    stops: {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: { stopUid: 'STOP-1', stopName: '第一站', sequence: 1 },
        geometry: { type: 'Point', coordinates: [121.5, 25] },
      }],
    },
    updatedAt: null,
  }
}

beforeEach(() => {
  patternStops.getSnapshotRouteVariants.mockReset()
  tdxMap.getRouteMapVariants.mockReset()
})

describe('route map response geometry', () => {
  it('simplifies dense route geometry at the HTTP boundary without changing variant or stop identity', async () => {
    const variant = denseVariant()
    patternStops.getSnapshotRouteVariants.mockResolvedValue([variant])

    const response = await request()
    const body = await response.json() as { variants: RouteMapVariant[] }

    expect(response.status).toBe(200)
    expect(body.variants).toHaveLength(1)
    expect(body.variants[0]).toMatchObject({
      variantKey: 'PATTERN-DENSE',
      routeUid: 'TPE307',
      subRouteUid: 'SUB-DENSE',
      direction: 0,
      stops: variant.stops,
    })
    expect(body.variants[0].shape.geometry.coordinates).toEqual([
      [121.5, 25],
      [121.501, 25.001],
    ])
    expect(variant.shape.geometry.coordinates).toHaveLength(5)
    expect(tdxMap.getRouteMapVariants).not.toHaveBeenCalled()
  })

  it('applies the same response bound to TDX fallback geometry', async () => {
    const variant = denseVariant()
    patternStops.getSnapshotRouteVariants.mockResolvedValue([])
    tdxMap.getRouteMapVariants.mockResolvedValue([variant])

    const response = await request()
    const body = await response.json() as { source: string; variants: RouteMapVariant[] }

    expect(response.status).toBe(200)
    expect(body.source).toBe('tdx')
    expect(body.variants[0].shape.geometry.coordinates).toEqual([
      [121.5, 25],
      [121.501, 25.001],
    ])
  })
})
