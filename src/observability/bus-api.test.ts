import { afterEach, describe, expect, it, vi } from 'vitest'
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

afterEach(() => {
  vi.restoreAllMocks()
})

describe('bus API observability', () => {
  it('distinguishes snapshot static reads from TDX static fallback', () => {
    expect(busStaticLookupOutcome(true, 2)).toEqual({
      result: 'success',
      source: 'snapshot',
      emptyReason: 'not_applicable',
    })
    expect(busStaticLookupOutcome(false, 2)).toEqual({
      result: 'degraded',
      source: 'tdx_static',
      emptyReason: 'not_applicable',
    })
    expect(busStaticLookupOutcome(false, 0)).toEqual({
      result: 'empty',
      source: 'tdx_static',
      emptyReason: 'no_routes',
    })
  })

  it('keeps stop-route snapshot plus realtime enrichment semantically mixed', () => {
    expect(busStopRoutesOutcome(true, 2)).toEqual({
      result: 'success',
      source: 'mixed',
      emptyReason: 'not_applicable',
    })
    expect(busStopRoutesOutcome(false, 2)).toEqual({
      result: 'degraded',
      source: 'fallback',
      emptyReason: 'not_applicable',
    })
  })

  it('emits a schema-valid empty completion instead of silently dropping it', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const tracker = beginBusApiOperation('bus_routes', 'Taipei', metadata)

    expect(tracker.complete({
      ...busStaticLookupOutcome(false, 0),
      httpStatus: 200,
    })).toBe(true)

    const event = capturedApiEvent(log)
    expect(event).toMatchObject({
      event: 'api_operation_completed',
      operation: 'bus_routes',
      city: 'Taipei',
      result: 'empty',
      source: 'tdx_static',
      emptyReason: 'no_routes',
      releaseSha: metadata.tag,
      trafficClass: 'user',
      sampleProbability: 0.1,
    })
  })

  it('records terminal bus API errors without changing the public error contract', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const tracker = beginBusApiOperation('bus_stops', 'Taipei', metadata)

    expect(completeBusApiError(tracker, 429)).toBe(true)

    expect(capturedApiEvent(log)).toMatchObject({
      operation: 'bus_stops',
      result: 'error',
      source: 'none',
      failureClass: 'tdx_429',
      httpStatusClass: '4xx',
    })
  })

  it('classifies all API input status variants as validation failures', () => {
    for (const status of [400, 404, 413, 415, 422] as const) {
      vi.spyOn(Math, 'random').mockReturnValue(0)
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
      const tracker = beginBusApiOperation('bus_stops', 'Taipei', metadata)
      expect(completeBusApiError(tracker, status)).toBe(true)
      expect(capturedApiEvent(log)).toMatchObject({ failureClass: 'input_validation' })
      vi.restoreAllMocks()
    }
  })
})

function capturedApiEvent(log: ReturnType<typeof vi.spyOn>): TelemetryEnvelope {
  const event = log.mock.calls
    .map(([value]: unknown[]) => value)
    .find((value: unknown): value is TelemetryEnvelope => Boolean(
      value && typeof value === 'object'
      && 'event' in value && value.event === 'api_operation_completed',
    ))
  expect(event).toBeDefined()
  return event as TelemetryEnvelope
}
