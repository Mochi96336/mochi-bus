import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TransitBindings } from '../infrastructure/transit/snapshot-repository'
import type { TDXEnv } from '../lib/tdx'
import type { TelemetryEnvelope, TelemetryOperation } from '../observability/telemetry'
import bus from './bus'

const routeStops = vi.hoisted(() => ({
  getSnapshotRouteStopGroups: vi.fn(),
}))
const stopRoutes = vi.hoisted(() => ({
  getSnapshotStopRouteSuggestions: vi.fn(),
}))
const snapshotRepository = vi.hoisted(() => ({
  getSnapshotRouteCatalog: vi.fn(),
}))
const tdx = vi.hoisted(() => ({
  getRouteCatalog: vi.fn(),
  getRouteStopGroups: vi.fn(),
  getStopRouteSuggestions: vi.fn(),
}))

vi.mock('../application/snapshot-route-stop-groups', async (importOriginal) => ({
  ...await importOriginal<typeof import('../application/snapshot-route-stop-groups')>(),
  getSnapshotRouteStopGroups: routeStops.getSnapshotRouteStopGroups,
}))
vi.mock('../application/stop-route-suggestions', async (importOriginal) => ({
  ...await importOriginal<typeof import('../application/stop-route-suggestions')>(),
  getSnapshotStopRouteSuggestions: stopRoutes.getSnapshotStopRouteSuggestions,
}))
vi.mock('../infrastructure/transit/snapshot-repository', async (importOriginal) => ({
  ...await importOriginal<typeof import('../infrastructure/transit/snapshot-repository')>(),
  getSnapshotRouteCatalog: snapshotRepository.getSnapshotRouteCatalog,
}))
vi.mock('../lib/tdx', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/tdx')>(),
  getRouteCatalog: tdx.getRouteCatalog,
  getRouteStopGroups: tdx.getRouteStopGroups,
  getStopRouteSuggestions: tdx.getStopRouteSuggestions,
}))

const metadata = {
  id: 'worker-version-id',
  tag: '0123456789abcdef0123456789abcdef01234567',
  timestamp: '2026-09-09T02:00:00.000Z',
} satisfies CloudflareBindings['CF_VERSION_METADATA']

const bindings = {
  TDX_CLIENT_ID: 'shared-id',
  TDX_CLIENT_SECRET: 'shared-secret',
  TRANSIT_DB: {} as D1Database,
  TRANSIT_SHAPES: {} as R2Bucket,
  CF_VERSION_METADATA: metadata,
} as TDXEnv & TransitBindings

const snapshotRoutes = [{
  routeUid: 'TPE307',
  routeName: '307',
  departure: '板橋',
  destination: '撫遠街',
  category: 'city-bus',
}]

const snapshotGroups = [{
  direction: 0,
  label: '板橋 → 撫遠街',
  subRouteUid: 'TPE307-A',
  stops: [{
    stopUid: 'STOP-1',
    stopName: '共同站',
    sequence: 1,
    routeUid: 'TPE307',
    subRouteUid: 'TPE307-A',
    direction: 0,
  }],
}]

const snapshotSuggestions = {
  place: {
    placeId: 'PLACE-1',
    name: '共同站',
    latitude: 25.04,
    longitude: 121.51,
  },
  buses: [{
    city: 'Taipei',
    routeName: '307',
    routeUid: 'TPE307',
    subRouteUid: 'TPE307-A',
    patternId: 'PATTERN-A',
    stopName: '共同站',
    stopUid: 'STOP-1',
    direction: 0,
    directionLabel: '板橋 → 撫遠街',
    label: '5 分',
  }],
}

function request(path: string): Promise<Response> {
  return Promise.resolve(bus.request(`https://bus.example${path}`, {}, bindings))
}

function capturedEvent(log: ReturnType<typeof vi.spyOn>, operation: TelemetryOperation): TelemetryEnvelope {
  const event = log.mock.calls
    .map(([value]: unknown[]) => value)
    .find((value: unknown): value is TelemetryEnvelope => Boolean(
      value && typeof value === 'object'
      && 'event' in value && value.event === 'api_operation_completed'
      && 'operation' in value && value.operation === operation,
    ))
  expect(event).toBeDefined()
  return event as TelemetryEnvelope
}

describe('bus setup snapshot quota contract', () => {
  let log: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    Object.values(routeStops).forEach((mock) => mock.mockReset())
    Object.values(stopRoutes).forEach((mock) => mock.mockReset())
    Object.values(snapshotRepository).forEach((mock) => mock.mockReset())
    Object.values(tdx).forEach((mock) => mock.mockReset())
    vi.spyOn(Math, 'random').mockReturnValue(0)
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('serves the route catalog from snapshot without legacy Route discovery', async () => {
    snapshotRepository.getSnapshotRouteCatalog.mockResolvedValue(snapshotRoutes)

    const response = await request('/api/v1/routes?city=Taipei')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ routes: snapshotRoutes })
    expect(snapshotRepository.getSnapshotRouteCatalog).toHaveBeenCalledWith(bindings, 'Taipei')
    expect(tdx.getRouteCatalog).not.toHaveBeenCalled()
    expect(capturedEvent(log, 'bus_routes')).toMatchObject({
      result: 'success',
      source: 'snapshot',
      city: 'Taipei',
    })
  })

  it('serves station order from snapshot without legacy StopOfRoute discovery', async () => {
    routeStops.getSnapshotRouteStopGroups.mockResolvedValue(snapshotGroups)

    const response = await request('/api/v1/stops?city=Taipei&route=307&routeUid=TPE307')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ groups: snapshotGroups })
    expect(routeStops.getSnapshotRouteStopGroups).toHaveBeenCalledWith(bindings, 'Taipei', '307', 'TPE307')
    expect(tdx.getRouteStopGroups).not.toHaveBeenCalled()
    expect(capturedEvent(log, 'bus_stops')).toMatchObject({
      result: 'success',
      source: 'snapshot',
      city: 'Taipei',
    })
  })

  it('serves same-place suggestions from snapshot without legacy Stop/Route discovery', async () => {
    stopRoutes.getSnapshotStopRouteSuggestions.mockResolvedValue(snapshotSuggestions)

    const response = await request('/api/v1/stop-routes?city=Taipei&stop=%E5%85%B1%E5%90%8C%E7%AB%99&stopUid=STOP-1')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      place: snapshotSuggestions.place,
      buses: snapshotSuggestions.buses,
    })
    expect(stopRoutes.getSnapshotStopRouteSuggestions).toHaveBeenCalledWith(
      expect.objectContaining(bindings),
      'Taipei',
      'STOP-1',
    )
    expect(tdx.getStopRouteSuggestions).not.toHaveBeenCalled()
    expect(capturedEvent(log, 'bus_stop_routes')).toMatchObject({
      result: 'success',
      source: 'mixed',
      city: 'Taipei',
    })
  })
})
