import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TDXEnv } from '../../lib/tdx'
import { getRouteMapVariants } from './map'

const tdx = vi.hoisted(() => ({
  fetchTDXJson: vi.fn(),
  getRouteStopGroups: vi.fn(),
}))

vi.mock('../../lib/tdx', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../lib/tdx')>(),
  fetchTDXJson: tdx.fetchTDXJson,
  getRouteStopGroups: tdx.getRouteStopGroups,
}))

const env = {} as TDXEnv
const SHAPE_SELECT = 'RouteUID,Direction,EncodedPolyline,UpdateTime'

function stopGroup(routeUid = 'TPE307') {
  return {
    direction: 0 as const,
    label: '起點 → 終點',
    routeUid,
    subRouteUid: `${routeUid}-A`,
    subRouteName: '測試路線',
    stops: [{
      routeUid,
      subRouteUid: `${routeUid}-A`,
      subRouteName: '測試路線',
      stopUid: 'STOP-1',
      stopName: '起點',
      direction: 0 as const,
      sequence: 1,
      position: { latitude: 25, longitude: 121 },
    }],
  }
}

beforeEach(() => {
  tdx.fetchTDXJson.mockReset()
  tdx.getRouteStopGroups.mockReset()
})

describe('TDX route shape fallback payload policy', () => {
  it('selects only fields consumed by city route-map fallback', async () => {
    tdx.getRouteStopGroups.mockResolvedValue([stopGroup()])
    tdx.fetchTDXJson.mockResolvedValue([{
      RouteUID: 'TPE307',
      Direction: 0,
      EncodedPolyline: '??',
      UpdateTime: '2026-09-05T10:00:00+08:00',
    }])

    const variants = await getRouteMapVariants(env, 'Taipei', '307')

    expect(variants).toHaveLength(1)
    expect(variants[0]).toMatchObject({
      routeUid: 'TPE307',
      direction: 0,
      updatedAt: '2026-09-05T10:00:00+08:00',
    })
    expect(tdx.fetchTDXJson).toHaveBeenCalledTimes(1)
    const [, url, ttl] = tdx.fetchTDXJson.mock.calls[0]
    expect(url.pathname).toBe('/api/basic/v2/Bus/Shape/City/Taipei/307')
    expect(url.searchParams.get('$select')).toBe(SHAPE_SELECT)
    expect(url.searchParams.get('$format')).toBe('JSON')
    expect(ttl).toBe(6 * 60 * 60)
  })

  it('applies the same projection when a THB route falls back to InterCity shapes', async () => {
    tdx.getRouteStopGroups.mockResolvedValue([stopGroup('THB9001')])
    tdx.fetchTDXJson.mockImplementation(async (_env: TDXEnv, url: URL) => {
      if (url.pathname.includes('/Shape/City/')) return []
      if (url.pathname.includes('/Shape/InterCity/')) return [{
        RouteUID: 'THB9001',
        Direction: 0,
        EncodedPolyline: '??',
      }]
      throw new Error(`unexpected URL: ${url}`)
    })

    await expect(getRouteMapVariants(env, 'Taichung', '9001')).resolves.toHaveLength(1)

    expect(tdx.fetchTDXJson).toHaveBeenCalledTimes(2)
    const cityUrl = tdx.fetchTDXJson.mock.calls[0]![1] as URL
    const intercityUrl = tdx.fetchTDXJson.mock.calls[1]![1] as URL
    expect(cityUrl.pathname).toBe('/api/basic/v2/Bus/Shape/City/Taichung/9001')
    expect(intercityUrl.pathname).toBe('/api/basic/v2/Bus/Shape/InterCity/9001')
    for (const url of [cityUrl, intercityUrl]) {
      expect(url.searchParams.get('$select')).toBe(SHAPE_SELECT)
      expect(url.searchParams.get('$format')).toBe('JSON')
    }
  })
})
