import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedBusQuery } from '../domain/bus-query'
import type { RouteEtaDetail } from '../domain/route-page-detail'
import type { ScheduleItem } from '../domain/schedule'
import type { TransitBindings } from '../infrastructure/transit/snapshot-repository'
import {
  TDXServiceError,
  type StopGroup,
  type TDXEnv,
} from '../lib/tdx'
import { getRouteEtaWithSnapshotFallback } from './snapshot-route-eta'

const query = {
  city: 'Taipei',
  routeName: '307',
  routeUid: 'TPE307',
  subRouteUid: 'TPE307-A',
  stopName: '共同站',
  stopUid: 'STOP-2',
  direction: 0,
} satisfies ResolvedBusQuery

const group: StopGroup = {
  direction: 0,
  label: '起點 → 終點',
  routeUid: 'TPE307',
  subRouteUid: 'TPE307-A',
  subRouteName: '307',
  stops: [
    {
      routeUid: 'TPE307', subRouteUid: 'TPE307-A', subRouteName: '307',
      stopUid: 'STOP-1', stopName: '起點', direction: 0, sequence: 1,
    },
    {
      routeUid: 'TPE307', subRouteUid: 'TPE307-A', subRouteName: '307',
      stopUid: 'STOP-2', stopName: '共同站', direction: 0, sequence: 2,
    },
    {
      routeUid: 'TPE307', subRouteUid: 'TPE307-A', subRouteName: '307',
      stopUid: 'STOP-3', stopName: '終點', direction: 0, sequence: 3,
    },
  ],
}

const sources = {
  tdx: {} as TDXEnv,
  snapshot: {} as TransitBindings,
}

const legacyResult: RouteEtaDetail = {
  detail: {
    routeName: '307',
    direction: 0,
    label: 'legacy',
    stops: [],
  },
  eta: { kind: 'empty' },
}

function realtimeRows() {
  return group.stops.map((stop, index) => ({
    RouteUID: 'TPE307',
    SubRouteUID: 'TPE307-A',
    StopUID: stop.stopUid,
    Direction: 0,
    EstimateTime: (index + 1) * 120,
    StopStatus: 0,
  }))
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('snapshot-backed Route ETA', () => {
  it('uses snapshot station order and only sends the route-wide realtime ETA request', async () => {
    const getSnapshotRouteStopGroups = vi.fn(async () => [group])
    const getLegacyRouteEtaDetail = vi.fn(async () => legacyResult)
    const fetchRouteEta = vi.fn(async () => realtimeRows())
    const getSnapshotSchedule = vi.fn(async () => null)
    const getBusSchedule = vi.fn(async () => [] as ScheduleItem[])

    const result = await getRouteEtaWithSnapshotFallback(sources, query, {
      getSnapshotRouteStopGroups,
      getLegacyRouteEtaDetail,
      fetchRouteEta,
      getSnapshotSchedule,
      getBusSchedule,
    })

    expect(result.eta).toEqual({ kind: 'realtime' })
    expect(result.detail.stops.map((stop) => stop.stopUid)).toEqual(['STOP-1', 'STOP-2', 'STOP-3'])
    expect(getSnapshotRouteStopGroups).toHaveBeenCalledWith(
      sources.snapshot,
      'Taipei',
      '307',
      'TPE307',
    )
    expect(getLegacyRouteEtaDetail).not.toHaveBeenCalled()
    expect(getSnapshotSchedule).not.toHaveBeenCalled()
    expect(getBusSchedule).not.toHaveBeenCalled()

    const [env, url, ttl] = fetchRouteEta.mock.calls[0]!
    expect(env).toBe(sources.tdx)
    expect(url.pathname).toBe('/api/basic/v2/Bus/EstimatedTimeOfArrival/City/Taipei/307')
    expect(url.searchParams.get('$filter')).toBe('Direction eq 0')
    expect(url.searchParams.get('$select')).toBe(
      'RouteUID,SubRouteUID,StopUID,Direction,EstimateTime,StopStatus',
    )
    expect(url.searchParams.get('$format')).toBe('JSON')
    expect(ttl).toBe(12)
  })

  it('falls back to the legacy TDX station-order path when snapshot identity is not exact', async () => {
    const otherGroup = {
      ...group,
      subRouteUid: 'OTHER',
      stops: group.stops.map((stop) => ({ ...stop, subRouteUid: 'OTHER' })),
    }
    const getLegacyRouteEtaDetail = vi.fn(async () => legacyResult)

    await expect(getRouteEtaWithSnapshotFallback(sources, query, {
      getSnapshotRouteStopGroups: vi.fn(async () => [otherGroup]),
      getLegacyRouteEtaDetail,
      fetchRouteEta: vi.fn(async () => realtimeRows()),
    })).resolves.toBe(legacyResult)

    expect(getLegacyRouteEtaDetail).toHaveBeenCalledWith(sources.tdx, query)
  })

  it('keeps snapshot station order when realtime is rate limited instead of issuing StopOfRoute fallback', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const error = new TDXServiceError('rate limited', 429)
    error.warning = 'tdx-rate-limit'
    const getLegacyRouteEtaDetail = vi.fn(async () => legacyResult)

    const result = await getRouteEtaWithSnapshotFallback(sources, query, {
      getSnapshotRouteStopGroups: vi.fn(async () => [group]),
      getLegacyRouteEtaDetail,
      fetchRouteEta: vi.fn(async () => { throw error }),
    })

    expect(result.eta).toEqual({ kind: 'unavailable', warning: 'tdx-rate-limit' })
    expect(result.detail.stops.find((stop) => stop.selected)?.etaLabel).toBe('即時忙線')
    expect(result.detail.stops.map((stop) => stop.stopUid)).toEqual(['STOP-1', 'STOP-2', 'STOP-3'])
    expect(getLegacyRouteEtaDetail).not.toHaveBeenCalled()
  })

  it('uses snapshot schedule fallback for realtime gaps without touching the TDX schedule endpoint', async () => {
    const getSnapshotSchedule = vi.fn(async () => [] as ScheduleItem[])
    const getBusSchedule = vi.fn(async () => { throw new Error('TDX schedule should not be called') })

    const result = await getRouteEtaWithSnapshotFallback(sources, query, {
      getSnapshotRouteStopGroups: vi.fn(async () => [group]),
      getLegacyRouteEtaDetail: vi.fn(async () => legacyResult),
      fetchRouteEta: vi.fn(async () => []),
      getSnapshotSchedule,
      getBusSchedule,
      now: () => new Date('2026-09-09T00:00:00Z'),
    })

    expect(result.eta).toEqual({ kind: 'empty' })
    expect(getSnapshotSchedule).toHaveBeenCalledWith(sources.snapshot, 'Taipei', '307', 'TPE307')
    expect(getBusSchedule).not.toHaveBeenCalled()
  })
})
