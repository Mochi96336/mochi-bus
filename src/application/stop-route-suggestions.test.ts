import { describe, expect, it, vi } from 'vitest'
import type { StopPlaceRoute } from '../infrastructure/transit/snapshot-place-routing-repository'
import type { TransitBindings } from '../infrastructure/transit/snapshot-repository'
import type { TDXEnv } from '../lib/tdx'
import { getSnapshotStopRouteSuggestions } from './stop-route-suggestions'

const env = {} as TDXEnv & TransitBindings
const place = {
  placeId: 'place-1',
  name: '共同站',
  latitude: 25.04,
  longitude: 121.52,
}

const routes: StopPlaceRoute[] = [
  {
    routeUid: 'TPE123',
    routeName: '307',
    variantKey: 'pattern-city',
    direction: 0,
    label: '板橋 → 撫遠街',
    subRouteUid: 'TPE123-A',
    subRouteName: '307',
    stopUid: 'TPE-STOP',
    stopSequence: 8,
    stopName: '共同站',
  },
  {
    routeUid: 'THB999',
    routeName: '9001',
    variantKey: 'pattern-intercity',
    direction: 1,
    label: '市府轉運站 → 中壢',
    subRouteUid: 'THB999-B',
    subRouteName: '9001',
    stopUid: 'THB-STOP',
    stopSequence: 4,
    stopName: '共同站',
  },
]

describe('snapshot-first setup stop route suggestions', () => {
  it('uses snapshot route identity and only compact ETA batches upstream', async () => {
    const seenUrls: URL[] = []
    const resolveRealtime = vi.fn(async (_env, url: URL) => {
      seenUrls.push(url)
      if (url.pathname.endsWith('/City/Taipei')) {
        return [{
          RouteUID: 'TPE123',
          SubRouteUID: 'TPE123-A',
          StopUID: 'TPE-STOP',
          Direction: 0,
          EstimateTime: 120,
          StopStatus: 0,
        }]
      }
      return [{
        RouteUID: 'THB999',
        SubRouteUID: 'THB999-B',
        StopUID: 'THB-STOP',
        Direction: 1,
        EstimateTime: 300,
        StopStatus: 0,
      }]
    })

    const result = await getSnapshotStopRouteSuggestions(env, 'Taipei', 'TPE-STOP', {
      getStopPlaceByStopUid: vi.fn().mockResolvedValue(place),
      getStopPlaceRoutes: vi.fn().mockResolvedValue(routes),
      resolveRealtime,
      reportSnapshotFailure: vi.fn(),
      reportRealtimeFailure: vi.fn(),
    })

    expect(result?.place).toEqual(place)
    expect(result?.buses).toEqual([
      expect.objectContaining({
        routeName: '307',
        routeUid: 'TPE123',
        patternId: 'pattern-city',
        stopUid: 'TPE-STOP',
        directionLabel: '板橋 → 撫遠街',
        label: '2 分',
      }),
      expect.objectContaining({
        routeName: '9001',
        routeUid: 'THB999',
        patternId: 'pattern-intercity',
        stopUid: 'THB-STOP',
        directionLabel: '市府轉運站 → 中壢',
        label: '5 分',
      }),
    ])
    expect(seenUrls).toHaveLength(2)
    expect(seenUrls.map((url) => url.pathname)).toEqual([
      '/api/basic/v2/Bus/EstimatedTimeOfArrival/City/Taipei',
      '/api/basic/v2/Bus/EstimatedTimeOfArrival/InterCity',
    ])
    for (const url of seenUrls) {
      expect(url.searchParams.get('$select')).toBe(
        'RouteUID,SubRouteUID,StopUID,Direction,EstimateTime,StopStatus',
      )
      expect(url.pathname).not.toContain('/Stop/')
      expect(url.pathname).not.toContain('/Route/')
    }
    expect(seenUrls[0].searchParams.get('$filter')).toContain("StopUID eq 'TPE-STOP'")
    expect(seenUrls[0].searchParams.get('$filter')).toContain("RouteUID eq 'TPE123'")
    expect(seenUrls[1].searchParams.get('$filter')).toContain("StopUID eq 'THB-STOP'")
    expect(seenUrls[1].searchParams.get('$filter')).toContain("RouteUID eq 'THB999'")
  })

  it('returns static snapshot suggestions when realtime is unavailable', async () => {
    const reportRealtimeFailure = vi.fn()
    const result = await getSnapshotStopRouteSuggestions(env, 'Taipei', 'TPE-STOP', {
      getStopPlaceByStopUid: vi.fn().mockResolvedValue(place),
      getStopPlaceRoutes: vi.fn().mockResolvedValue([routes[0]]),
      resolveRealtime: vi.fn().mockRejectedValue(new Error('TDX unavailable')),
      reportSnapshotFailure: vi.fn(),
      reportRealtimeFailure,
    })

    expect(result?.buses).toEqual([
      expect.objectContaining({ routeUid: 'TPE123', patternId: 'pattern-city' }),
    ])
    expect(result?.buses[0]).not.toHaveProperty('label')
    expect(reportRealtimeFailure).toHaveBeenCalledTimes(1)
  })

  it('returns null without touching realtime when snapshot place identity is unavailable', async () => {
    const resolveRealtime = vi.fn()
    const result = await getSnapshotStopRouteSuggestions(env, 'Taipei', 'missing', {
      getStopPlaceByStopUid: vi.fn().mockResolvedValue(null),
      getStopPlaceRoutes: vi.fn(),
      resolveRealtime,
      reportSnapshotFailure: vi.fn(),
      reportRealtimeFailure: vi.fn(),
    })

    expect(result).toBeNull()
    expect(resolveRealtime).not.toHaveBeenCalled()
  })
})
