import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TDXServiceError } from '../lib/tdx'
import type { TelemetryEnvelope } from '../observability/telemetry'
import type { MapEnv } from './map-http-context'
import { readPlaceArrivals } from './map-place-arrivals'

const repository = vi.hoisted(() => ({
  getStopPlaceBundle: vi.fn(),
  getStopPlaceRoutes: vi.fn(),
  getSnapshotSchedule: vi.fn(),
}))
const tdx = vi.hoisted(() => ({
  resolveTDXJson: vi.fn(),
  tdxCredentialScope: vi.fn(),
  isRejectedUserTdxToken: vi.fn(),
  tdxWarningFromError: vi.fn(),
}))
const memory = vi.hoisted(() => ({
  memoryCacheGet: vi.fn(),
  memoryCacheSet: vi.fn(),
}))
const edge = vi.hoisted(() => ({
  cacheMatchFailOpen: vi.fn(),
  cachePutFailOpen: vi.fn(),
}))

vi.mock('../infrastructure/transit/snapshot-repository', () => repository)
vi.mock('../lib/tdx', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/tdx')>(),
  resolveTDXJson: tdx.resolveTDXJson,
  tdxCredentialScope: tdx.tdxCredentialScope,
  isRejectedUserTdxToken: tdx.isRejectedUserTdxToken,
  tdxWarningFromError: tdx.tdxWarningFromError,
}))
vi.mock('../lib/memory-cache', () => memory)
vi.mock('../lib/edge-cache', () => edge)

const metadata = {
  id: 'worker-version-id',
  tag: '0123456789abcdef0123456789abcdef01234567',
  timestamp: '2026-07-21T14:00:00.000Z',
} satisfies CloudflareBindings['CF_VERSION_METADATA']

const bindings = {
  TDX_CLIENT_ID: 'shared-id',
  TDX_CLIENT_SECRET: 'shared-secret',
  TRANSIT_DB: {} as D1Database,
  TRANSIT_SHAPES: {} as R2Bucket,
  CF_VERSION_METADATA: metadata,
} as MapEnv['Bindings']

const route = {
  routeUid: 'TPE307',
  routeName: '307',
  variantKey: 'TPE307:0',
  direction: 0 as const,
  label: '板橋 → 撫遠街',
  subRouteUid: 'TPE3070',
  subRouteName: '307',
  stopUid: 'STOP1',
  stopSequence: 4,
  stopName: '西門市場',
}

const bundle = {
  version: 'snapshot-v8',
  placeId: 'PLACE1',
  name: '西門市場',
  routes: [{ ...route, schedules: [] }],
}

const realtimeItem = {
  RouteUID: 'TPE307',
  SubRouteUID: 'TPE3070',
  Direction: 0,
  StopUID: 'STOP1',
  EstimateTime: 180,
  StopStatus: 0,
}

const activeSchedule = [{
  SubRouteUID: 'TPE3070',
  Direction: 0,
  Frequencys: [{
    StartTime: '00:00',
    EndTime: '23:59',
    MinHeadwayMins: 8,
    MaxHeadwayMins: 12,
    ServiceDay: { Tuesday: 1 },
  }],
}]

function createApp() {
  const app = new Hono<MapEnv>()
  app.get('/api/v1/map/place/:placeId/arrivals', readPlaceArrivals)
  return app
}

function request(path: string, init: RequestInit = {}): Promise<Response> {
  return Promise.resolve(createApp().request(`https://bus.example${path}`, init, bindings))
}

function capturedEvent(log: ReturnType<typeof vi.spyOn>): TelemetryEnvelope {
  const event = log.mock.calls
    .map(([value]: unknown[]) => value)
    .find((value: unknown): value is TelemetryEnvelope => Boolean(
      value && typeof value === 'object'
      && 'event' in value && value.event === 'api_operation_completed'
      && 'operation' in value && value.operation === 'map_place_arrivals',
    ))
  expect(event).toBeDefined()
  return event as TelemetryEnvelope
}

function upstream(data: unknown[]) {
  return { data, resolution: 'upstream' as const, degraded: false }
}

describe('Map Place Arrivals HTTP boundary', () => {
  let log: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-20T22:00:00.000Z'))
    Object.values(repository).forEach((mock) => mock.mockReset())
    Object.values(tdx).forEach((mock) => mock.mockReset())
    Object.values(memory).forEach((mock) => mock.mockReset())
    Object.values(edge).forEach((mock) => mock.mockReset())
    repository.getStopPlaceBundle.mockResolvedValue(bundle)
    repository.getStopPlaceRoutes.mockResolvedValue([])
    repository.getSnapshotSchedule.mockResolvedValue([])
    tdx.resolveTDXJson.mockResolvedValue(upstream([]))
    tdx.tdxCredentialScope.mockResolvedValue('shared-scope')
    tdx.isRejectedUserTdxToken.mockReturnValue(false)
    tdx.tdxWarningFromError.mockReturnValue(undefined)
    memory.memoryCacheGet.mockReturnValue(undefined)
    edge.cacheMatchFailOpen.mockResolvedValue(undefined)
    edge.cachePutFailOpen.mockResolvedValue(undefined)
    vi.stubGlobal('caches', { default: {} })
    vi.spyOn(Math, 'random').mockReturnValue(0)
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('serves realtime bundle arrivals, writes last-good state, and records success', async () => {
    tdx.resolveTDXJson.mockResolvedValue(upstream([realtimeItem]))

    const response = await request('/api/v1/map/place/PLACE1/arrivals?city=Taipei')
    const body = await response.json<Record<string, any>>()

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=15')
    expect(body).toMatchObject({
      schemaVersion: 1,
      city: 'Taipei',
      scheduleSource: 'place-bundle',
      snapshotVersion: 'snapshot-v8',
      realtime: { candidates: 1, queries: 1, rateLimited: false },
      routes: [{ routeUid: 'TPE307', source: 'realtime', estimateSeconds: 180 }],
    })
    expect(memory.memoryCacheSet).toHaveBeenCalledWith(
      expect.stringContaining('arrivals/last/Taipei/'),
      expect.objectContaining({ items: [realtimeItem] }),
      120,
    )
    expect(edge.cachePutFailOpen).toHaveBeenCalledWith(
      expect.anything(), expect.any(Request), expect.any(Response), 'arrivals_last', undefined,
    )
    expect(capturedEvent(log)).toMatchObject({
      result: 'success', source: 'realtime', snapshotVersion: 'snapshot-v8', city: 'Taipei',
    })
  })

  it('uses bundle schedules when realtime is empty', async () => {
    repository.getStopPlaceBundle.mockResolvedValue({
      ...bundle,
      routes: [{ ...route, schedules: activeSchedule }],
    })

    const response = await request('/api/v1/map/place/PLACE1/arrivals?city=Taipei')
    const body = await response.json<Record<string, any>>()

    expect(body).toMatchObject({
      scheduleSource: 'place-bundle',
      routes: [{ source: 'schedule', scheduleMinutes: 12, scheduleHeadway: [8, 12] }],
    })
    expect(capturedEvent(log)).toMatchObject({ result: 'degraded', source: 'schedule', failureClass: 'none' })
  })

  it('falls back to route objects and per-route snapshot schedules without a bundle', async () => {
    repository.getStopPlaceBundle.mockResolvedValue(null)
    repository.getStopPlaceRoutes.mockResolvedValue([route])
    repository.getSnapshotSchedule.mockResolvedValue(activeSchedule)

    const response = await request('/api/v1/map/place/PLACE1/arrivals?city=Taipei')
    const body = await response.json<Record<string, any>>()

    expect(repository.getSnapshotSchedule).toHaveBeenCalledWith(bindings, 'Taipei', '307')
    expect(body).toMatchObject({
      scheduleSource: 'route-objects', snapshotVersion: null,
      routes: [{ source: 'schedule', scheduleMinutes: 12 }],
    })
    expect(capturedEvent(log)).toMatchObject({ result: 'degraded', source: 'fallback', snapshotVersion: null })
  })

  it('replays last-good realtime as stale without counting an upstream query', async () => {
    memory.memoryCacheGet.mockImplementation((key: string) => key.startsWith('arrivals/last/')
      ? { items: [realtimeItem], cachedAt: Date.now() - 30_000 }
      : undefined)
    tdx.resolveTDXJson.mockImplementation(async (_env, _url, _ttl, options) => {
      const stale = await options.staleFallback?.(new Error('upstream unavailable'))
      return { data: stale?.data ?? [], resolution: 'stale_replay', degraded: true }
    })

    const response = await request('/api/v1/map/place/PLACE1/arrivals?city=Taipei')
    const body = await response.json<Record<string, any>>()

    expect(body).toMatchObject({
      realtime: { candidates: 1, queries: 0, rateLimited: false },
      routes: [{ source: 'stale-realtime', estimateSeconds: 180 }],
    })
    expect(capturedEvent(log)).toMatchObject({ result: 'degraded', source: 'stale' })
    expect(edge.cachePutFailOpen).not.toHaveBeenCalled()
  })

  it('turns a TDX rate limit into warning and cooldown while keeping HTTP 200', async () => {
    const error = new TDXServiceError('rate limited', 429)
    error.warning = 'tdx-rate-limit'
    tdx.resolveTDXJson.mockRejectedValue(error)
    tdx.tdxWarningFromError.mockReturnValue('tdx-rate-limit')

    const response = await request('/api/v1/map/place/PLACE1/arrivals?city=Taipei')
    const body = await response.json<Record<string, any>>()

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(body).toMatchObject({
      warning: 'tdx-rate-limit', realtime: { candidates: 1, queries: 0, rateLimited: true },
    })
    expect(memory.memoryCacheSet).toHaveBeenCalledWith('arrivals/cooldown/Taipei/shared-scope', true, 60)
    expect(edge.cachePutFailOpen).toHaveBeenCalledWith(
      expect.anything(), expect.any(Request), expect.any(Response), 'arrivals_cooldown', undefined,
    )
    expect(capturedEvent(log)).toMatchObject({
      result: 'degraded', source: 'fallback', failureClass: 'tdx_429', emptyReason: 'upstream_failure',
    })
  })

  it('passes an active cooldown into TDX resolution', async () => {
    memory.memoryCacheGet.mockImplementation((key: string) => key === 'arrivals/cooldown/Taipei/shared-scope')
    const error = new TDXServiceError('blocked', 429)
    error.warning = 'tdx-rate-limit'
    tdx.resolveTDXJson.mockRejectedValue(error)
    tdx.tdxWarningFromError.mockReturnValue('tdx-rate-limit')

    const response = await request('/api/v1/map/place/PLACE1/arrivals?city=Taipei')
    const body = await response.json<Record<string, any>>()

    expect(tdx.resolveTDXJson).toHaveBeenCalledWith(
      expect.anything(), expect.any(URL), 15,
      expect.objectContaining({ blockedFailureClass: 'rate_limited' }),
    )
    expect(edge.cacheMatchFailOpen).not.toHaveBeenCalled()
    expect(body).toMatchObject({ warning: 'tdx-rate-limit', realtime: { rateLimited: true } })
  })

  it('keeps a rejected personal TDX token terminal and coded', async () => {
    const rejected = new TDXServiceError('rejected', 401)
    tdx.resolveTDXJson.mockRejectedValue(rejected)
    tdx.isRejectedUserTdxToken.mockImplementation((error: unknown) => error === rejected)

    const response = await request('/api/v1/map/place/PLACE1/arrivals?city=Taipei', {
      headers: { Authorization: 'Bearer expired-personal-token' },
    })

    expect(response.status).toBe(401)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    await expect(response.json()).resolves.toMatchObject({ code: 'TDX_ACCESS_TOKEN_REJECTED' })
    expect(capturedEvent(log)).toMatchObject({ result: 'error', failureClass: 'tdx_401' })
  })

  it('validates city before touching TDX credential scope', async () => {
    const response = await request('/api/v1/map/place/PLACE1/arrivals?city=Unknown')

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: '請選擇城市' })
    expect(tdx.tdxCredentialScope).not.toHaveBeenCalled()
    expect(repository.getStopPlaceBundle).not.toHaveBeenCalled()
    expect(capturedEvent(log)).toMatchObject({ result: 'error', failureClass: 'input_validation' })
  })
})
