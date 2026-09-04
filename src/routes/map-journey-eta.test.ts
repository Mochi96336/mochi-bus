import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TDX_ACCESS_TOKEN_REJECTED_CODE,
  TDX_ACCESS_TOKEN_REJECTED_MESSAGE,
} from '../domain/tdx-api-error'
import { TDXServiceError } from '../lib/tdx'
import type { TelemetryEnvelope } from '../observability/telemetry'
import type { MapEnv } from './map-http-context'
import { journeyEtaBodyLimit, readJourneyEta } from './map-journey-eta'

const patternStops = vi.hoisted(() => ({
  getJourneyLegStopRefs: vi.fn(),
}))
const repository = vi.hoisted(() => ({
  getSnapshotSchedule: vi.fn(),
}))
const tdx = vi.hoisted(() => ({
  fetchTDXJson: vi.fn(),
  getBusSchedule: vi.fn(),
}))

vi.mock('../infrastructure/transit/snapshot-pattern-stop-repository', () => patternStops)
vi.mock('../infrastructure/transit/snapshot-repository', async (importOriginal) => ({
  ...await importOriginal<typeof import('../infrastructure/transit/snapshot-repository')>(),
  getSnapshotSchedule: repository.getSnapshotSchedule,
}))

vi.mock('../lib/tdx', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/tdx')>(),
  fetchTDXJson: tdx.fetchTDXJson,
  getBusSchedule: tdx.getBusSchedule,
}))

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

const leg = { key: 'leg-1', patternId: 'pattern-1', sequence: 1 }
const ref = {
  ...leg,
  routeUid: 'TPE1',
  direction: 0 as const,
  routeName: '307',
  stopUid: 'STOP1',
}

function createApp() {
  const app = new Hono<MapEnv>()
  app.post('/api/v1/map/journey-eta', journeyEtaBodyLimit, readJourneyEta)
  return app
}

function request(body: unknown, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  return Promise.resolve(createApp().request('https://bus.example/api/v1/map/journey-eta', {
    ...init,
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }, bindings))
}

function capturedEvent(log: ReturnType<typeof vi.spyOn>): TelemetryEnvelope {
  const event = log.mock.calls
    .map(([value]: unknown[]) => value)
    .find((value: unknown): value is TelemetryEnvelope => Boolean(
      value && typeof value === 'object'
      && 'event' in value && value.event === 'api_operation_completed'
      && 'operation' in value && value.operation === 'map_journey_eta',
    ))
  expect(event).toBeDefined()
  return event as TelemetryEnvelope
}

const allServiceDays = {
  Sunday: 1,
  Monday: 1,
  Tuesday: 1,
  Wednesday: 1,
  Thursday: 1,
  Friday: 1,
  Saturday: 1,
}

describe('Map journey ETA handler', () => {
  let log: ReturnType<typeof vi.spyOn>
  let errorLog: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    patternStops.getJourneyLegStopRefs.mockReset()
    repository.getSnapshotSchedule.mockReset()
    tdx.fetchTDXJson.mockReset()
    tdx.getBusSchedule.mockReset()
    patternStops.getJourneyLegStopRefs.mockResolvedValue([ref])
    repository.getSnapshotSchedule.mockResolvedValue(null)
    tdx.getBusSchedule.mockResolvedValue([])
    vi.spyOn(Math, 'random').mockReturnValue(0)
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('batches multiple city routes into one realtime TDX request', async () => {
    const secondLeg = { key: 'leg-2', patternId: 'pattern-2', sequence: 2 }
    patternStops.getJourneyLegStopRefs.mockResolvedValue([
      ref,
      {
        ...secondLeg,
        routeUid: 'TPE2',
        direction: 1 as const,
        routeName: '299',
        stopUid: 'STOP2',
      },
    ])
    tdx.fetchTDXJson.mockResolvedValue([
      {
        RouteUID: 'TPE1',
        Direction: 0,
        StopUID: 'STOP1',
        EstimateTime: 180,
        StopStatus: 0,
      },
      {
        RouteUID: 'TPE2',
        Direction: 1,
        StopUID: 'STOP2',
        EstimateTime: 420,
        StopStatus: 0,
      },
    ])

    const response = await request({ city: 'Taipei', legs: [leg, secondLeg] })
    const body = await response.json<{
      schemaVersion: number
      city: string
      fetchedAt: string
      estimates: Array<{ key: string; source: string; minutes: number }>
    }>()

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(body).toMatchObject({
      schemaVersion: 1,
      city: 'Taipei',
      estimates: [
        { key: 'leg-1', source: 'realtime', minutes: 3 },
        { key: 'leg-2', source: 'realtime', minutes: 7 },
      ],
    })
    expect(Number.isNaN(Date.parse(body.fetchedAt))).toBe(false)
    expect(tdx.fetchTDXJson).toHaveBeenCalledTimes(1)
    const [env, url, ttl, options] = tdx.fetchTDXJson.mock.calls[0]
    expect(env).toMatchObject({ TDX_CLIENT_ID: 'shared-id', TDX_CLIENT_SECRET: 'shared-secret' })
    const requestUrl = new URL(String(url))
    expect(requestUrl.pathname).toBe('/api/basic/v2/Bus/EstimatedTimeOfArrival/City/Taipei')
    expect(requestUrl.searchParams.get('$filter')).toContain("StopUID eq 'STOP1'")
    expect(requestUrl.searchParams.get('$filter')).toContain("StopUID eq 'STOP2'")
    expect(requestUrl.searchParams.get('$filter')).toContain("RouteUID eq 'TPE1'")
    expect(requestUrl.searchParams.get('$filter')).toContain("RouteUID eq 'TPE2'")
    expect(requestUrl.searchParams.get('$select')).toBe('RouteUID,SubRouteUID,StopUID,Direction,EstimateTime,StopStatus')
    expect(ttl).toBe(15)
    expect(options).toMatchObject({
      operation: 'journey_eta',
      city: 'Taipei',
      maxResponseBytes: 512 * 1024,
    })
    expect(repository.getSnapshotSchedule).not.toHaveBeenCalled()
    expect(tdx.getBusSchedule).not.toHaveBeenCalled()
    expect(capturedEvent(log)).toMatchObject({
      result: 'success',
      source: 'realtime',
      qualityBucket: 'complete_realtime',
      city: 'Taipei',
    })
  })

  it('uses snapshot schedules before the TDX schedule fallback', async () => {
    tdx.fetchTDXJson.mockResolvedValue([])
    repository.getSnapshotSchedule.mockResolvedValue([{
      Direction: 0,
      Frequencys: [{
        StartTime: '00:00',
        EndTime: '23:59',
        MinHeadwayMins: 5,
        MaxHeadwayMins: 10,
        ServiceDay: allServiceDays,
      }],
    }])

    const response = await request({ city: 'Taipei', legs: [leg] })
    const body = await response.json<{
      estimates: Array<{
        source: string
        minutes: number
        departureBased: boolean
        headwayMinutes: [number, number]
      }>
    }>()

    expect(response.status).toBe(200)
    expect(body.estimates[0]).toMatchObject({
      source: 'schedule',
      minutes: 10,
      departureBased: true,
      headwayMinutes: [5, 10],
    })
    expect(repository.getSnapshotSchedule).toHaveBeenCalledWith(
      expect.anything(), 'Taipei', '307', 'TPE1',
    )
    expect(tdx.getBusSchedule).not.toHaveBeenCalled()
    expect(capturedEvent(log)).toMatchObject({
      result: 'degraded',
      source: 'schedule',
      qualityBucket: 'complete_schedule',
    })
  })

  it('keeps unresolved route lookup results as all-unknown without upstream access', async () => {
    patternStops.getJourneyLegStopRefs.mockResolvedValue([])

    const response = await request({ city: 'Taipei', legs: [leg] })
    const body = await response.json<{ estimates: unknown[] }>()

    expect(response.status).toBe(200)
    expect(body.estimates).toEqual([])
    expect(tdx.fetchTDXJson).not.toHaveBeenCalled()
    expect(repository.getSnapshotSchedule).not.toHaveBeenCalled()
    expect(capturedEvent(log)).toMatchObject({
      result: 'empty',
      source: 'none',
      emptyReason: 'all_estimates_unknown',
      qualityBucket: 'all_unknown',
    })
  })

  it('aggregates route failures using the strongest TDX warning', async () => {
    const quotaError = new TDXServiceError('quota exhausted', 429)
    quotaError.warning = 'tdx-quota'
    tdx.fetchTDXJson.mockRejectedValue(new Error('network unavailable'))
    tdx.getBusSchedule.mockRejectedValue(quotaError)

    const response = await request({ city: 'Taipei', legs: [leg] })
    const body = await response.json<{
      warning?: string
      estimates: Array<{ source: string; minutes: number | null }>
    }>()

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(body.warning).toBe('tdx-quota')
    expect(body.estimates[0]).toMatchObject({ source: 'none', minutes: null })
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('journey_eta_upstream_failed'))
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('journey_schedule_route_failed'))
    expect(capturedEvent(log)).toMatchObject({
      result: 'degraded',
      source: 'fallback',
      failureClass: 'tdx_quota',
      emptyReason: 'upstream_failure',
      qualityBucket: 'all_unknown',
    })
  })

  it('keeps rejected personal tokens terminal and coded', async () => {
    tdx.fetchTDXJson.mockRejectedValue(new TDXServiceError('token rejected', 401))

    const response = await request({ city: 'Taipei', legs: [leg] }, {
      headers: { Authorization: 'Bearer rejected-token' },
    })

    expect(response.status).toBe(401)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    await expect(response.json()).resolves.toEqual({
      code: TDX_ACCESS_TOKEN_REJECTED_CODE,
      error: TDX_ACCESS_TOKEN_REJECTED_MESSAGE,
    })
    expect(repository.getSnapshotSchedule).not.toHaveBeenCalled()
    expect(capturedEvent(log)).toMatchObject({
      result: 'error',
      source: 'none',
      failureClass: 'tdx_401',
    })
  })

  it('preserves media-type and journey-input validation before repository access', async () => {
    const mediaResponse = await request('{}', {
      headers: { 'Content-Type': 'text/plain' },
    })
    expect(mediaResponse.status).toBe(415)
    await expect(mediaResponse.json()).resolves.toEqual({
      error: 'Content-Type 必須是 application/json',
      code: 'UNSUPPORTED_MEDIA_TYPE',
    })

    log.mockClear()
    const inputResponse = await request({ city: 'Taipei', legs: [] })
    expect(inputResponse.status).toBe(422)
    await expect(inputResponse.json()).resolves.toEqual({
      error: 'ETA 查詢項目必須介於 1 到 12 筆',
      code: 'INVALID_REQUEST',
    })
    expect(patternStops.getJourneyLegStopRefs).not.toHaveBeenCalled()
    expect(capturedEvent(log)).toMatchObject({
      result: 'error',
      failureClass: 'input_validation',
    })
  })

  it('keeps the 16 KiB body limit outside the handler with an exact no-store response', async () => {
    const response = await request({
      city: 'Taipei',
      legs: [leg],
      padding: 'x'.repeat(17_000),
    })

    expect(response.status).toBe(413)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    await expect(response.json()).resolves.toEqual({
      error: '請求內容過大',
      code: 'PAYLOAD_TOO_LARGE',
    })
    expect(patternStops.getJourneyLegStopRefs).not.toHaveBeenCalled()
  })
})
