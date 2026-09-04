import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MapEnv } from './map-http-context'
import { readVehicles } from './map-vehicles-read'

const tdx = vi.hoisted(() => ({ fetchTDXJson: vi.fn() }))

vi.mock('../lib/tdx', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/tdx')>(),
  fetchTDXJson: tdx.fetchTDXJson,
}))

const bindings = {
  TDX_CLIENT_ID: 'shared-id',
  TDX_CLIENT_SECRET: 'shared-secret',
  TRANSIT_DB: {} as D1Database,
  TRANSIT_SHAPES: {} as R2Bucket,
} as MapEnv['Bindings']

const VEHICLE_SELECT = 'PlateNumb,RouteUID,Direction,BusPosition,Speed,Azimuth,GPSTime,UpdateTime'

function request(query: string): Promise<Response> {
  const app = new Hono<MapEnv>()
  app.get('/api/v1/map/vehicles', readVehicles)
  return Promise.resolve(app.request(`https://bus.example/api/v1/map/vehicles?${query}`, {}, bindings))
}

describe('vehicle upstream request policy', () => {
  beforeEach(() => {
    tdx.fetchTDXJson.mockReset().mockResolvedValue([])
    vi.spyOn(Math, 'random').mockReturnValue(1)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  it('selects only public vehicle fields and pushes stable identity filters upstream', async () => {
    const response = await request('city=Taipei&route=307&routeUid=TPE307&direction=0')
    expect(response.status).toBe(200)

    const url = tdx.fetchTDXJson.mock.calls[0][1] as URL
    expect(url.pathname).toBe('/api/basic/v2/Bus/RealTimeByFrequency/City/Taipei/307')
    expect(url.searchParams.get('$format')).toBe('JSON')
    expect(url.searchParams.get('$select')).toBe(VEHICLE_SELECT)
    expect(url.searchParams.get('$filter')).toBe("RouteUID eq 'TPE307' and Direction eq 0")
  })

  it('uses InterCity scope for THB identities while keeping the same narrow field set', async () => {
    const response = await request('city=Taichung&route=9010&routeUid=THB9010&direction=1')
    expect(response.status).toBe(200)

    const url = tdx.fetchTDXJson.mock.calls[0][1] as URL
    expect(url.pathname).toBe('/api/basic/v2/Bus/RealTimeByFrequency/InterCity/9010')
    expect(url.searchParams.get('$select')).toBe(VEHICLE_SELECT)
    expect(url.searchParams.get('$filter')).toBe("RouteUID eq 'THB9010' and Direction eq 1")
  })

  it('keeps route-only reads compatible and simply omits the identity filter', async () => {
    const response = await request('city=Taipei&route=307')
    expect(response.status).toBe(200)

    const url = tdx.fetchTDXJson.mock.calls[0][1] as URL
    expect(url.searchParams.get('$select')).toBe(VEHICLE_SELECT)
    expect(url.searchParams.has('$filter')).toBe(false)
  })
})
