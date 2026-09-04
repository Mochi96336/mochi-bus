import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RouteMapVariant } from '../domain/map/map-model'
import type { MapEnv } from './map-http-context'
import { readRouteMap, readRouteTimetable } from './map-route-reads'

const patternStops = vi.hoisted(() => ({
  getSnapshotRouteVariants: vi.fn(),
}))
const repository = vi.hoisted(() => ({
  getSnapshotSchedule: vi.fn(),
}))
const tdxMap = vi.hoisted(() => ({ getRouteMapVariants: vi.fn() }))
const tdx = vi.hoisted(() => ({ getBusSchedule: vi.fn() }))
const timetableDomain = vi.hoisted(() => ({ buildRouteTimetable: vi.fn() }))

vi.mock('../infrastructure/transit/snapshot-pattern-stop-repository', () => patternStops)
vi.mock('../infrastructure/transit/snapshot-repository', () => repository)
vi.mock('../infrastructure/tdx/map', () => tdxMap)
vi.mock('../domain/map/timetable', () => timetableDomain)
vi.mock('../lib/tdx', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/tdx')>(),
  getBusSchedule: tdx.getBusSchedule,
}))

const bindings = {
  TDX_CLIENT_ID: 'shared-id',
  TDX_CLIENT_SECRET: 'shared-secret',
  TRANSIT_DB: {} as D1Database,
  TRANSIT_SHAPES: {} as R2Bucket,
} as MapEnv['Bindings']

function createApp() {
  const app = new Hono<MapEnv>()
  app.get('/api/v1/map/route', readRouteMap)
  app.get('/api/v1/map/timetable', readRouteTimetable)
  return app
}

function request(path: string): Promise<Response> {
  return Promise.resolve(createApp().request(`https://bus.example${path}`, {}, bindings))
}

function routeVariant(
  variantKey: string,
  direction: 0 | 1 | 2,
  subRouteUid: string,
  stopUid: string,
): RouteMapVariant {
  return {
    variantKey,
    routeName: '307',
    routeUid: 'TPE307',
    subRouteUid,
    direction,
    label: direction === 0 ? '板橋 → 撫遠街' : '撫遠街 → 板橋',
    subRouteName: '307',
    shape: {
      type: 'Feature',
      properties: { routeUid: 'TPE307', direction },
      geometry: { type: 'LineString', coordinates: [[121.5, 25], [121.6, 25.1]] },
    },
    stops: {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: { stopUid, stopName: `站牌 ${stopUid}`, sequence: 1 },
        geometry: { type: 'Point', coordinates: [121.5, 25] },
      }],
    },
    updatedAt: null,
  }
}

const outbound = routeVariant('PATTERN-OUT', 0, 'SUB-OUT', 'STOP-OUT')
const inbound = routeVariant('PATTERN-IN', 1, 'SUB-IN', 'STOP-IN')

beforeEach(() => {
  Object.values(patternStops).forEach((mock) => mock.mockReset())
  Object.values(repository).forEach((mock) => mock.mockReset())
  Object.values(tdxMap).forEach((mock) => mock.mockReset())
  Object.values(tdx).forEach((mock) => mock.mockReset())
  Object.values(timetableDomain).forEach((mock) => mock.mockReset())
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-07-21T04:00:00.000Z'))
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Map route read handlers', () => {
  it('serves route variants from snapshot with the long-lived cache contract', async () => {
    patternStops.getSnapshotRouteVariants.mockResolvedValue([outbound])

    const response = await request('/api/v1/map/route?city=Taipei&route=307')

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=86400')
    await expect(response.json()).resolves.toEqual({
      schemaVersion: 1,
      city: 'Taipei',
      routeName: '307',
      source: 'snapshot',
      variants: [outbound],
    })
    expect(tdxMap.getRouteMapVariants).not.toHaveBeenCalled()
  })

  it('falls back to TDX route variants with the short cache contract', async () => {
    patternStops.getSnapshotRouteVariants.mockResolvedValue([])
    tdxMap.getRouteMapVariants.mockResolvedValue([inbound])

    const response = await request('/api/v1/map/route?city=Taipei&route=307')

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=300')
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      source: 'tdx',
      variants: [inbound],
    }))
    expect(tdxMap.getRouteMapVariants).toHaveBeenCalledWith(expect.objectContaining({
      TDX_CLIENT_ID: 'shared-id',
      TDX_CLIENT_SECRET: 'shared-secret',
    }), 'Taipei', '307')
  })

  it('preserves the route-map not-found response after both sources are empty', async () => {
    patternStops.getSnapshotRouteVariants.mockResolvedValue([])
    tdxMap.getRouteMapVariants.mockResolvedValue([])

    const response = await request('/api/v1/map/route?city=Taipei&route=307')

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: '這條路線目前沒有可用的地圖線型' })
  })

  it('selects the timetable variant by every supplied identity field', async () => {
    patternStops.getSnapshotRouteVariants.mockResolvedValue([outbound, inbound])
    repository.getSnapshotSchedule.mockResolvedValue([])
    timetableDomain.buildRouteTimetable.mockReturnValue({ rows: ['snapshot-result'] })

    const response = await request(
      '/api/v1/map/timetable?city=Taipei&route=307&direction=1&variant=PATTERN-IN&routeUid=TPE307&subRouteUid=SUB-IN&stopUid=STOP-IN',
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=300')
    await expect(response.json()).resolves.toEqual({
      schemaVersion: 1,
      city: 'Taipei',
      routeName: '307',
      variantKey: 'PATTERN-IN',
      routeUid: 'TPE307',
      direction: 1,
      source: 'snapshot',
      timetable: { rows: ['snapshot-result'] },
    })
    expect(repository.getSnapshotSchedule).toHaveBeenCalledWith(bindings, 'Taipei', '307', 'TPE307')
    expect(tdx.getBusSchedule).not.toHaveBeenCalled()
    expect(timetableDomain.buildRouteTimetable).toHaveBeenCalledWith([], {
      direction: 1,
      subRouteUid: 'SUB-IN',
      stops: [{ stopUid: 'STOP-IN', stopName: '站牌 STOP-IN', sequence: 1 }],
    }, 'STOP-IN', new Date('2026-07-21T04:00:00.000Z'))
  })

  it('falls back to TDX schedules and reports the schedule source', async () => {
    patternStops.getSnapshotRouteVariants.mockResolvedValue([outbound])
    repository.getSnapshotSchedule.mockResolvedValue(null)
    tdx.getBusSchedule.mockResolvedValue([{ RouteUID: 'TPE307' }])
    timetableDomain.buildRouteTimetable.mockReturnValue({ rows: ['tdx-result'] })

    const response = await request('/api/v1/map/timetable?city=Taipei&route=307&direction=0')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      variantKey: 'PATTERN-OUT',
      source: 'tdx',
      timetable: { rows: ['tdx-result'] },
    }))
    expect(tdx.getBusSchedule).toHaveBeenCalledWith(expect.any(Object), 'Taipei', '307', 'TPE307')
  })

  it('keeps timetable source tied to schedules when variants came from TDX', async () => {
    patternStops.getSnapshotRouteVariants.mockResolvedValue([])
    tdxMap.getRouteMapVariants.mockResolvedValue([outbound])
    repository.getSnapshotSchedule.mockResolvedValue([])
    timetableDomain.buildRouteTimetable.mockReturnValue({ rows: [] })

    const response = await request('/api/v1/map/timetable?city=Taipei&route=307&direction=0')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual(expect.objectContaining({ source: 'snapshot' }))
    expect(tdx.getBusSchedule).not.toHaveBeenCalled()
  })

  it('returns 404 before schedule lookup when no variant matches', async () => {
    patternStops.getSnapshotRouteVariants.mockResolvedValue([outbound])

    const response = await request('/api/v1/map/timetable?city=Taipei&route=307&direction=1')

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: '找不到這個方向的站序' })
    expect(repository.getSnapshotSchedule).not.toHaveBeenCalled()
    expect(tdx.getBusSchedule).not.toHaveBeenCalled()
  })

  it('rejects a missing timetable direction before variant lookup', async () => {
    const response = await request('/api/v1/map/timetable?city=Taipei&route=307')

    expect(response.status).toBe(400)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    await expect(response.json()).resolves.toEqual({ error: '請選擇行駛方向' })
    expect(patternStops.getSnapshotRouteVariants).not.toHaveBeenCalled()
  })
})
