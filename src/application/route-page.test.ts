import { describe, expect, it, vi } from 'vitest'
import type { BusQuery, ResolvedBusQuery } from '../domain/bus-query'
import type { TransitBindings } from '../infrastructure/transit/snapshot-repository'
import type { RouteDetail, TDXEnv } from '../lib/tdx'
import { getRoutePageWithFallback } from './route-page'

const sources = {
  tdx: {} as TDXEnv,
  snapshot: {} as TransitBindings,
}

const query: BusQuery = {
  city: 'Taipei',
  routeName: '307',
  direction: 0,
  stopUid: 'STOP-2',
  stopName: '舊站名',
}

const resolved: ResolvedBusQuery = {
  ...query,
  routeUid: 'ROUTE-A',
  subRouteUid: 'SUB-A',
  stopUid: 'STOP-2',
  stopName: '捷運西門站',
}

const detail = {
  routeName: '307',
  direction: 0,
  label: '板橋 → 撫遠街',
  stops: [],
} as unknown as RouteDetail

const snapshotPage = {
  resolved: {
    ...resolved,
    routeUid: 'SNAPSHOT-ROUTE',
  },
  detail: {
    ...detail,
    label: 'Snapshot 板橋 → 撫遠街',
  },
}

describe('getRoutePageWithFallback', () => {
  it('returns the snapshot page without touching TDX static resolution', async () => {
    const resolveBusQuery = vi.fn()
    const getRoutePageDetail = vi.fn()
    const getSnapshotRoutePage = vi.fn(async () => snapshotPage)

    await expect(getRoutePageWithFallback(sources, query, {
      resolveBusQuery,
      getRoutePageDetail,
      getSnapshotRoutePage,
    })).resolves.toBe(snapshotPage)

    expect(getSnapshotRoutePage).toHaveBeenCalledWith(sources.snapshot, query)
    expect(resolveBusQuery).not.toHaveBeenCalled()
    expect(getRoutePageDetail).not.toHaveBeenCalled()
  })

  it('falls back to the TDX static page when snapshot has no unique match', async () => {
    const resolveBusQuery = vi.fn(async () => resolved)
    const getRoutePageDetail = vi.fn(async () => ({ detail }))
    const getSnapshotRoutePage = vi.fn(async () => null)

    await expect(getRoutePageWithFallback(sources, query, {
      resolveBusQuery,
      getRoutePageDetail,
      getSnapshotRoutePage,
    })).resolves.toEqual({ resolved, detail })

    expect(resolveBusQuery).toHaveBeenCalledWith(sources.tdx, query)
    expect(getRoutePageDetail).toHaveBeenCalledWith(sources.tdx, resolved)
  })

  it('reports snapshot failures and still uses the TDX compatibility path', async () => {
    const snapshotError = new Error('Snapshot database unavailable')
    const reportSnapshotFailure = vi.fn()

    await expect(getRoutePageWithFallback(sources, query, {
      resolveBusQuery: vi.fn(async () => resolved),
      getRoutePageDetail: vi.fn(async () => ({ detail })),
      getSnapshotRoutePage: vi.fn(async () => { throw snapshotError }),
      reportSnapshotFailure,
    })).resolves.toEqual({ resolved, detail })

    expect(reportSnapshotFailure).toHaveBeenCalledWith(snapshotError)
  })

  it('preserves the TDX error when snapshot and logging are both unavailable', async () => {
    const primaryError = new Error('TDX unavailable')
    const snapshotError = new Error('Snapshot database unavailable')
    const reportSnapshotFailure = vi.fn(() => {
      throw new Error('logger unavailable')
    })

    await expect(getRoutePageWithFallback(sources, query, {
      resolveBusQuery: vi.fn(async () => { throw primaryError }),
      getSnapshotRoutePage: vi.fn(async () => { throw snapshotError }),
      reportSnapshotFailure,
    })).rejects.toBe(primaryError)

    expect(reportSnapshotFailure).toHaveBeenCalledWith(snapshotError)
  })
})
