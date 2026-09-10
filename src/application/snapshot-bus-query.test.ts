import { describe, expect, it, vi } from 'vitest'
import type { BusQuery, ResolvedBusQuery } from '../domain/bus-query'
import type { StopPlaceRoute } from '../infrastructure/transit/snapshot-place-routing-repository'
import type { StopLookupPlace } from '../infrastructure/transit/snapshot-stop-lookup-repository'
import type { TransitBindings } from '../infrastructure/transit/snapshot-repository'
import type { TDXEnv } from '../lib/tdx'
import { resolveBusQueryWithSnapshotFallback } from './snapshot-bus-query'

const snapshot = {} as TransitBindings
const tdx = {} as TDXEnv
const query = {
  city: 'Taipei',
  routeName: '307舊名',
  routeUid: 'TPE307',
  subRouteUid: 'TPE307-A',
  stopName: '舊站名',
  stopUid: 'STOP-2',
  direction: 0,
} satisfies BusQuery

const place: StopLookupPlace = {
  placeId: 'PLACE-1',
  name: '共同站',
  latitude: 25.04,
  longitude: 121.51,
}

function route(overrides: Partial<StopPlaceRoute> = {}): StopPlaceRoute {
  return {
    routeUid: 'TPE307',
    routeName: '307',
    variantKey: 'PATTERN-A',
    direction: 0,
    label: '起點 → 終點',
    subRouteUid: 'TPE307-A',
    subRouteName: '307',
    stopUid: 'STOP-2',
    stopSequence: 20,
    stopName: '共同站',
    ...overrides,
  }
}

const legacy: ResolvedBusQuery = {
  ...query,
  routeName: 'legacy',
  stopName: 'legacy stop',
  stopUid: 'LEGACY-STOP',
}

describe('snapshot bus query resolution', () => {
  it('canonicalizes stable route and stop identity without touching TDX', async () => {
    const getStopPlaceByStopUid = vi.fn(async () => place)
    const getStopPlaceRoutes = vi.fn(async () => [route()])
    const resolveBusQuery = vi.fn(async () => legacy)
    const reportStopLookupFallback = vi.fn()

    const result = await resolveBusQueryWithSnapshotFallback(snapshot, tdx, query, {
      getStopPlaceByStopUid,
      getStopPlaceRoutes,
      resolveBusQuery,
      reportStopLookupFallback,
    })

    expect(result).toEqual({
      ...query,
      routeName: '307',
      stopName: '共同站',
    })
    expect(getStopPlaceByStopUid).toHaveBeenCalledWith(
      snapshot,
      'Taipei',
      'STOP-2',
      reportStopLookupFallback,
    )
    expect(getStopPlaceRoutes).toHaveBeenCalledWith(snapshot, 'Taipei', 'PLACE-1')
    expect(resolveBusQuery).not.toHaveBeenCalled()
  })

  it('dedupes equivalent snapshot pattern occurrences before deciding uniqueness', async () => {
    const resolveBusQuery = vi.fn(async () => legacy)

    const result = await resolveBusQueryWithSnapshotFallback(snapshot, tdx, query, {
      getStopPlaceByStopUid: vi.fn(async () => place),
      getStopPlaceRoutes: vi.fn(async () => [
        route(),
        route({ variantKey: 'PATTERN-B', stopSequence: 21 }),
      ]),
      resolveBusQuery,
    })

    expect(result.routeName).toBe('307')
    expect(resolveBusQuery).not.toHaveBeenCalled()
  })

  it('falls back to TDX when snapshot identity is ambiguous or does not match the requested sub-route', async () => {
    const resolveBusQuery = vi.fn(async () => legacy)
    const ambiguousQuery = { ...query, subRouteUid: undefined }

    await expect(resolveBusQueryWithSnapshotFallback(snapshot, tdx, ambiguousQuery, {
      getStopPlaceByStopUid: vi.fn(async () => place),
      getStopPlaceRoutes: vi.fn(async () => [
        route({ subRouteUid: 'A' }),
        route({ subRouteUid: 'B', variantKey: 'PATTERN-B' }),
      ]),
      resolveBusQuery,
    })).resolves.toBe(legacy)

    await expect(resolveBusQueryWithSnapshotFallback(snapshot, tdx, query, {
      getStopPlaceByStopUid: vi.fn(async () => place),
      getStopPlaceRoutes: vi.fn(async () => [route({ subRouteUid: 'OTHER' })]),
      resolveBusQuery,
    })).resolves.toBe(legacy)

    expect(resolveBusQuery).toHaveBeenCalledTimes(2)
  })

  it('uses the legacy resolver for incomplete stable identity and after snapshot read failures', async () => {
    const resolveBusQuery = vi.fn(async () => legacy)
    const reportSnapshotFailure = vi.fn()

    await expect(resolveBusQueryWithSnapshotFallback(snapshot, tdx, {
      ...query,
      routeUid: undefined,
    }, {
      resolveBusQuery,
    })).resolves.toBe(legacy)

    await expect(resolveBusQueryWithSnapshotFallback(snapshot, tdx, query, {
      getStopPlaceByStopUid: vi.fn(async () => { throw new Error('R2 unavailable') }),
      resolveBusQuery,
      reportSnapshotFailure,
    })).resolves.toBe(legacy)

    expect(resolveBusQuery).toHaveBeenCalledTimes(2)
    expect(reportSnapshotFailure).toHaveBeenCalledTimes(1)
  })
})
