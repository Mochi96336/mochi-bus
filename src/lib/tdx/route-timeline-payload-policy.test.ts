import { describe, expect, it, vi } from 'vitest'
import type { ResolvedBusQuery } from '../../domain/bus-query'
import type { ScheduleItem } from '../../domain/schedule'
import {
  createTDXCommuteRoutePresentation,
  type TDXCommuteRoutePresentationDependencies,
} from './commute-route-presentation'
import type { StopGroup } from './bus-route-queries'
import type { TDXEnv, TDXResolutionOptions } from './resolution-cache'

const ROUTE_TIMELINE_SELECT = 'RouteUID,SubRouteUID,StopUID,Direction,EstimateTime,StopStatus'
const env = {} as unknown as TDXEnv

function group(routeUid: string, subRouteUid: string, direction: 0 | 1): StopGroup {
  return {
    direction,
    label: '起點 → 終點',
    routeUid,
    subRouteUid,
    subRouteName: '測試路線',
    stops: [
      {
        routeUid,
        subRouteUid,
        subRouteName: '測試路線',
        stopUid: 'STOP-1',
        stopName: '起點',
        direction,
        sequence: 1,
      },
      {
        routeUid,
        subRouteUid,
        subRouteName: '測試路線',
        stopUid: 'STOP-2',
        stopName: '終點',
        direction,
        sequence: 2,
      },
    ],
  }
}

function harness(stopGroup: StopGroup) {
  const fetchTDXJson = vi.fn(async () => [
    {
      RouteUID: stopGroup.routeUid,
      SubRouteUID: stopGroup.subRouteUid,
      StopUID: 'STOP-1',
      Direction: stopGroup.direction,
      EstimateTime: 120,
      StopStatus: 0,
    },
    // Keep local identity matching defensive even when the upstream filter is present.
    {
      RouteUID: stopGroup.routeUid,
      SubRouteUID: stopGroup.subRouteUid,
      StopUID: 'STOP-2',
      Direction: stopGroup.direction === 0 ? 1 : 0,
      EstimateTime: 30,
      StopStatus: 0,
    },
  ]) as TDXCommuteRoutePresentationDependencies['fetchTDXJson']

  const dependencies: TDXCommuteRoutePresentationDependencies = {
    fetchTDXJson,
    getRouteStopGroups: vi.fn(async () => [stopGroup]),
    getBusSchedule: vi.fn(async () => [] as ScheduleItem[]),
    getSnapshotSchedule: vi.fn(async () => null),
  }

  return {
    fetchTDXJson,
    presentation: createTDXCommuteRoutePresentation(dependencies),
  }
}

function query(overrides: Partial<ResolvedBusQuery> = {}): ResolvedBusQuery {
  return {
    city: 'Taipei',
    routeName: '307',
    routeUid: 'TPE307',
    subRouteUid: 'TPE307-A',
    stopName: '起點',
    stopUid: 'STOP-1',
    direction: 0,
    ...overrides,
  }
}

describe('TDX route timeline payload policy', () => {
  it('selects only fields consumed by the timeline and filters to the requested city direction', async () => {
    const stopGroup = group('TPE307', 'TPE307-A', 0)
    const { fetchTDXJson, presentation } = harness(stopGroup)

    const result = await presentation.getRouteDetail(env, query())

    expect(result.detail.stops).toEqual([
      expect.objectContaining({ stopUid: 'STOP-1', etaLabel: '2 分', etaTone: 'urgent' }),
      expect.objectContaining({ stopUid: 'STOP-2', etaLabel: null, etaTone: 'muted' }),
    ])

    expect(fetchTDXJson).toHaveBeenCalledTimes(1)
    const [, url, ttl] = vi.mocked(fetchTDXJson).mock.calls[0] as [
      TDXEnv,
      URL,
      number,
      TDXResolutionOptions<unknown> | undefined,
    ]
    expect(url.pathname).toBe('/api/basic/v2/Bus/EstimatedTimeOfArrival/City/Taipei/307')
    expect(url.searchParams.get('$select')).toBe(ROUTE_TIMELINE_SELECT)
    expect(url.searchParams.get('$filter')).toBe('Direction eq 0')
    expect(url.searchParams.get('$format')).toBe('JSON')
    expect(ttl).toBe(12)
  })

  it('keeps THB timelines route-scoped to InterCity while filtering the requested direction', async () => {
    const stopGroup = group('THB9001', 'THB9001-A', 1)
    const { fetchTDXJson, presentation } = harness(stopGroup)
    const intercityQuery = query({
      city: 'Taichung',
      routeName: '9001',
      routeUid: 'THB9001',
      subRouteUid: 'THB9001-A',
      direction: 1,
    })

    await expect(presentation.getRouteDetail(env, intercityQuery)).resolves.toMatchObject({
      detail: { routeName: '9001', direction: 1 },
    })

    const url = vi.mocked(fetchTDXJson).mock.calls[0]![1]
    expect(url.pathname).toBe('/api/basic/v2/Bus/EstimatedTimeOfArrival/InterCity/9001')
    expect(url.searchParams.get('$select')).toBe(ROUTE_TIMELINE_SELECT)
    expect(url.searchParams.get('$filter')).toBe('Direction eq 1')
    expect(url.searchParams.get('$format')).toBe('JSON')
  })
})
