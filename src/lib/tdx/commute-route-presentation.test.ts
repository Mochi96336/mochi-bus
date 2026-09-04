import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedBusQuery } from '../../domain/bus-query'
import type { ScheduleItem } from '../../domain/schedule'
import { TDXServiceError } from './error-classification'
import {
  createTDXCommuteRoutePresentation,
  type TDXCommuteRoutePresentationDependencies,
} from './commute-route-presentation'
import type { StopGroup } from './bus-route-queries'
import type { TDXEnv, TDXResolutionOptions } from './resolution-cache'

const query = {
  city: 'Taipei',
  routeName: '307',
  routeUid: 'TPE307',
  subRouteUid: 'TPE307-A',
  stopName: '共同站',
  stopUid: 'STOP-2',
  direction: 0,
} satisfies ResolvedBusQuery

const env = {} as unknown as TDXEnv

function stopGroup(): StopGroup {
  return {
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
}

function harness(overrides: Partial<TDXCommuteRoutePresentationDependencies> = {}) {
  const fetchTDXJson: TDXCommuteRoutePresentationDependencies['fetchTDXJson'] = async <T>(
    _env: TDXEnv,
    _url: URL,
    _ttlSeconds: number,
    _options?: TDXResolutionOptions<T>,
  ) => [] as T
  const getRouteStopGroups = vi.fn(async () => [stopGroup()])
  const getBusSchedule = vi.fn(async () => [] as ScheduleItem[])
  const getSnapshotSchedule = vi.fn(async () => null)
  const dependencies: TDXCommuteRoutePresentationDependencies = {
    fetchTDXJson,
    getRouteStopGroups,
    getBusSchedule,
    getSnapshotSchedule,
    now: () => new Date('2026-07-21T00:00:00.000Z'),
    ...overrides,
  }
  return {
    presentation: createTDXCommuteRoutePresentation(dependencies),
    fetchTDXJson,
    getRouteStopGroups,
    getBusSchedule,
    getSnapshotSchedule,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('TDX commute and route presentation boundary', () => {
  it('filters a single-stop realtime read by stable route, stop and direction identity', async () => {
    const fetchTDXJson = vi.fn(async () => [
      {
        RouteUID: 'TPE307', SubRouteUID: 'OTHER', StopUID: 'STOP-2', Direction: 0,
        EstimateTime: 30, StopName: { Zh_tw: '錯誤支線' },
      },
      {
        RouteUID: 'TPE307', SubRouteUID: 'TPE307-A', StopUID: 'STOP-2', Direction: 0,
        EstimateTime: 420, StopName: { Zh_tw: '共同站' }, DataTime: '2026-07-21T00:00:00Z',
      },
    ]) as TDXCommuteRoutePresentationDependencies['fetchTDXJson']
    const { presentation, getBusSchedule, getSnapshotSchedule } = harness({ fetchTDXJson })

    const result = await presentation.getCommuteETA(env, query)

    expect(result).toMatchObject({
      routeName: '307', stopName: '共同站', stopUid: 'STOP-2',
      minutes: 7, estimateSeconds: 420, label: '7 分', source: 'realtime',
    })
    expect(result).not.toHaveProperty('warning')
    expect(getSnapshotSchedule).not.toHaveBeenCalled()
    expect(getBusSchedule).not.toHaveBeenCalled()

    const realtimeUrl = vi.mocked(fetchTDXJson).mock.calls[0]![1]
    expect(realtimeUrl.pathname).toBe('/api/basic/v2/Bus/EstimatedTimeOfArrival/City/Taipei')
    expect(realtimeUrl.searchParams.get('$filter')).toBe(
      "StopUID eq 'STOP-2' and RouteUID eq 'TPE307' and Direction eq 0",
    )
    expect(realtimeUrl.searchParams.get('$select')).toBe(
      'RouteUID,SubRouteUID,StopUID,StopName,Direction,EstimateTime,StopStatus,DataTime,SrcUpdateTime,SrcTransTime,UpdateTime',
    )
    expect(realtimeUrl.searchParams.get('$format')).toBe('JSON')
    expect(vi.mocked(fetchTDXJson).mock.calls[0]![2]).toBe(12)
  })

  it('keeps the previous route-scoped ETA endpoint when RouteUID is unavailable', async () => {
    const legacyQuery = { ...query, routeUid: undefined } satisfies ResolvedBusQuery
    const fetchTDXJson = vi.fn(async () => [{
      StopUID: 'STOP-2', Direction: 0, EstimateTime: 120,
    }]) as TDXCommuteRoutePresentationDependencies['fetchTDXJson']
    const { presentation } = harness({ fetchTDXJson })

    await expect(presentation.getCommuteETA(env, legacyQuery)).resolves.toMatchObject({
      minutes: 2,
      source: 'realtime',
    })

    const realtimeUrl = vi.mocked(fetchTDXJson).mock.calls[0]![1]
    expect(realtimeUrl.pathname).toBe('/api/basic/v2/Bus/EstimatedTimeOfArrival/City/Taipei/307')
    expect(realtimeUrl.searchParams.has('$filter')).toBe(false)
    expect(realtimeUrl.searchParams.has('$select')).toBe(false)
  })

  it('uses the InterCity collection for filtered THB single-stop ETA reads', async () => {
    const intercityQuery = {
      ...query,
      city: 'Taichung',
      routeUid: 'THB1234',
      subRouteUid: undefined,
    } satisfies ResolvedBusQuery
    const fetchTDXJson = vi.fn(async () => [{
      RouteUID: 'THB1234', StopUID: 'STOP-2', Direction: 0, EstimateTime: 180,
    }]) as TDXCommuteRoutePresentationDependencies['fetchTDXJson']
    const { presentation } = harness({ fetchTDXJson })

    await expect(presentation.getCommuteETA(env, intercityQuery)).resolves.toMatchObject({
      minutes: 3,
      source: 'realtime',
    })

    const realtimeUrl = vi.mocked(fetchTDXJson).mock.calls[0]![1]
    expect(realtimeUrl.pathname).toBe('/api/basic/v2/Bus/EstimatedTimeOfArrival/InterCity')
    expect(realtimeUrl.searchParams.get('$filter')).toContain("RouteUID eq 'THB1234'")
  })

  it('falls back from a shared realtime failure to an exact stop timetable and keeps the warning', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const fetchTDXJson = vi.fn(async () => { throw new TDXServiceError('upstream', 503) }) as TDXCommuteRoutePresentationDependencies['fetchTDXJson']
    const schedules: ScheduleItem[] = [{
      SubRouteUID: 'TPE307-A', Direction: 0,
      Timetables: [{
        ServiceDay: { Tuesday: 1 },
        StopTimes: [{ StopUID: 'STOP-2', StopSequence: 2, ArrivalTime: '08:07' }],
      }],
    }]
    const getBusSchedule = vi.fn(async () => schedules)
    const { presentation } = harness({ fetchTDXJson, getBusSchedule })

    await expect(presentation.getCommuteETA(env, query)).resolves.toMatchObject({
      minutes: 7,
      estimateSeconds: 420,
      label: '7 分',
      statusLabel: '時刻表預估',
      source: 'schedule',
      warning: 'tdx-unavailable',
      dataTime: null,
    })
  })

  it('prefers snapshot schedules and only calls TDX schedule when the snapshot is absent', async () => {
    const snapshotSchedules: ScheduleItem[] = [{
      SubRouteUID: 'TPE307-A', Direction: 0,
      Frequencys: [{
        StartTime: '07:00', EndTime: '09:00', MinHeadwayMins: 8, MaxHeadwayMins: 12,
        ServiceDay: { Tuesday: 1 },
      }],
    }]
    const getSnapshotSchedule = vi.fn(async () => snapshotSchedules)
    const getBusSchedule = vi.fn(async () => { throw new Error('should not call') })
    const { presentation } = harness({ getSnapshotSchedule, getBusSchedule })
    const bindings = { TRANSIT_DB: {}, TRANSIT_SHAPES: {} } as unknown as TDXEnv

    const result = await presentation.getCommuteETA(bindings, query)

    expect(result).toMatchObject({
      minutes: 12, label: '8–12 分一班', statusLabel: '班距預估', source: 'schedule',
    })
    expect(getSnapshotSchedule).toHaveBeenCalledTimes(1)
    expect(getBusSchedule).not.toHaveBeenCalled()
  })

  it('uses the TDX schedule after a null snapshot and labels departure-only estimates honestly', async () => {
    const getSnapshotSchedule = vi.fn(async () => null)
    const getBusSchedule = vi.fn(async () => [{
      SubRouteUID: 'TPE307-A', Direction: 0,
      Timetables: [{
        ServiceDay: { Tuesday: 1 },
        StopTimes: [{ StopUID: 'ORIGIN', StopSequence: 1, DepartureTime: '08:05' }],
      }],
    }] as ScheduleItem[])
    const { presentation } = harness({ getSnapshotSchedule, getBusSchedule })
    const bindings = { TRANSIT_DB: {}, TRANSIT_SHAPES: {} } as unknown as TDXEnv

    await expect(presentation.getCommuteETA(bindings, query)).resolves.toMatchObject({
      minutes: 5,
      label: '5 分後發車',
      statusLabel: '時刻表發車預估',
      source: 'schedule',
    })
    expect(getBusSchedule).toHaveBeenCalledTimes(1)
  })

  it('rethrows a rejected personal token before any schedule fallback', async () => {
    const rejected = new TDXServiceError('rejected', 401)
    const fetchTDXJson = vi.fn(async () => { throw rejected }) as TDXCommuteRoutePresentationDependencies['fetchTDXJson']
    const getBusSchedule = vi.fn(async () => [] as ScheduleItem[])
    const { presentation } = harness({ fetchTDXJson, getBusSchedule })
    const personalEnv = { TDX_USER_ACCESS_TOKEN: 'Bearer test-token' } as TDXEnv

    await expect(presentation.getCommuteETA(personalEnv, query)).rejects.toBe(rejected)
    expect(getBusSchedule).not.toHaveBeenCalled()
  })

  it('keeps the original empty realtime result when schedules contain no matching estimate', async () => {
    const getBusSchedule = vi.fn(async () => [] as ScheduleItem[])
    const { presentation } = harness({ getBusSchedule })

    const result = await presentation.getCommuteETA(env, query)
    expect(result).toMatchObject({
      minutes: null,
      estimateSeconds: null,
      label: '暫無預估時間',
      source: 'none',
    })
    expect(result).not.toHaveProperty('warning')
  })

  it('keeps route timeline reads on the route-scoped endpoint', async () => {
    const fetchTDXJson = vi.fn(async () => [
      {
        RouteUID: 'TPE307', SubRouteUID: 'TPE307-A', StopUID: 'STOP-1', Direction: 0,
        EstimateTime: 120, StopStatus: 0,
      },
      {
        RouteUID: 'TPE307', SubRouteUID: 'TPE307-A', StopUID: 'STOP-2', Direction: 0,
        EstimateTime: 600, StopStatus: 0,
      },
      {
        RouteUID: 'TPE307', SubRouteUID: 'TPE307-A', StopUID: 'STOP-3', Direction: 0,
        EstimateTime: null, StopStatus: 1,
      },
    ]) as TDXCommuteRoutePresentationDependencies['fetchTDXJson']
    const { presentation } = harness({ fetchTDXJson })

    const result = await presentation.getRouteDetail(env, query)

    expect(result.detail).toMatchObject({
      routeName: '307', direction: 0, label: '起點 → 終點',
      stops: [
        { stopUid: 'STOP-1', selected: false, etaLabel: '2 分', etaTone: 'urgent' },
        { stopUid: 'STOP-2', selected: true, etaLabel: '10 分', etaTone: 'live' },
        { stopUid: 'STOP-3', selected: false, etaLabel: '尚未發車', etaTone: 'muted' },
      ],
    })
    expect(result.states).toEqual([
      { source: 'realtime', status: 'estimated' },
      { source: 'realtime', status: 'estimated' },
      { source: 'realtime', status: 'not-departed' },
    ])

    const routeUrl = vi.mocked(fetchTDXJson).mock.calls[0]![1]
    expect(routeUrl.pathname).toBe('/api/basic/v2/Bus/EstimatedTimeOfArrival/City/Taipei/307')
    expect(routeUrl.searchParams.has('$filter')).toBe(false)
    expect(routeUrl.searchParams.has('$select')).toBe(false)
  })

  it('throws the exact route-direction resolution error when no stop group matches', async () => {
    const getRouteStopGroups = vi.fn(async () => [
      { ...stopGroup(), direction: 1 as const, stops: stopGroup().stops.map((stop) => ({ ...stop, direction: 1 as const })) },
    ])
    const { presentation } = harness({ getRouteStopGroups })

    await expect(presentation.getRouteDetail(env, query)).rejects.toMatchObject({
      name: 'QueryResolutionError',
      message: '找不到這個方向的完整站序',
      candidates: [],
    })
  })
})
