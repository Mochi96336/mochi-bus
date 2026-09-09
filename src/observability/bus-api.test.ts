import { describe, expect, it, vi } from 'vitest'
import type { TelemetryEnvelope } from './telemetry'
import {
  beginBusApiOperation,
  busStaticLookupOutcome,
  busStopRoutesOutcome,
  completeBusApiError,
} from './bus-api'

const metadata = {
  id: 'worker-version-id',
  tag: '0123456789abcdef0123456789abcdef01234567',
  timestamp: '2026-09-09T00:00:00.000Z',
} satisfies CloudflareBindings['CF_VERSION_METADATA']

describe('bus API observability', () => {
  it('distinguishes snapshot static reads from TDX static fallback', () => {
    expect(busStaticLookupOutcome(true, 2)).toEqual({ result: 'success', source: 'snapshot' })
    expect(busStaticLookupOutcome(false, 2)).toEqual({ result: 'degraded', source: 'tdx_static' })
    expect(busStaticLookupOutcome(false, 0)).toEqual({ result: 'empty', source: 'tdx_static' })
  })

  it('keeps stop-route snapshot plus realtime enrichment semantically mixed', () => {
    expect(busStopRoutesOutcome(true, 2)).toEqual({ result: 'success', source: 'mixed' })
    expect(busStopRoutesOutcome(false, 2)).toEqual({ result: 'degraded', source: 'fallback' })
  })

  it('emits the existing sampled api completion contract with release identity', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const tracker = beginBusApiOperation('bus_routes', 'Taipei', metadata)

    tracker.complete({
      ...busStaticLookupOutcome(false, 3),
      httpStatus: 200,
    })

    const event = log.mock.calls
      .map(([value]: unknown[]) => value)
      .find((value: unknown): value is TelemetryEnvelope => Boolean(
        value && typeof value === 'object'
        && 'event' in value && value.event === 'api_operation_completed',
      ))
    expect(event).toMatchObject({
      event: 'api_operation_completed',
      operation: 'bus_routes',
      city: 'Taipei',
      result: 'degraded',
      source: 'tdx_static',
      releaseSha: metadata.tag,
      trafficClass: 'user',
      sampleProbability: 0.1,
    })
    vi.restoreAllMocks()
  })

  it('records terminal bus API errors without changing the public error contract', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const tracker = beginBusApiOperation('bus_stops', 'Taipei', metadata)

    expect(completeBusApiError(tracker, 429)).toBe(true)

    const event = log.mock.calls
      .map(([value]: unknown[]) => value)
      .find((value: unknown): value is TelemetryEnvelope => Boolean(
        value && typeof value === 'object'
        && 'event' in value && value.event === 'api_operation_completed',
      ))
    expect(event).toMatchObject({
      operation: 'bus_stops',
      result: 'error',
      source: 'none',
      failureClass: 'tdx_429',
      httpStatusClass: '4xx',
    })
    vi.restoreAllMocks()
  })
})
