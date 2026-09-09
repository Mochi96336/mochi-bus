import { describe, expect, it } from 'vitest'
import {
  formatTdxUsageSummary,
  parseTdxUsageText,
  summarizeTdxUsage,
  TDX_BYTES_PER_POINT,
  TDX_CALLS_PER_POINT,
} from './tdx-usage-summary.mjs'

function runtime(overrides = {}) {
  return {
    message: 'tdx_upstream_usage',
    operation: 'bus_eta',
    resource: 'EstimatedTimeOfArrival',
    scope: 'City/Taipei',
    credentialScope: 'shared',
    result: 'success',
    status: 200,
    attempt: 1,
    receivedBytes: 1_500_000,
    declaredBytes: 1_500_000,
    failureClass: 'none',
    ...overrides,
  }
}

describe('TDX usage accounting', () => {
  it('parses runtime and snapshot logs while keeping malformed and unrelated input visible', () => {
    const probe = {
      event: 'tdx_city_persistent_cache',
      resource: 'Route',
      resolution: 'probe',
      sourceVersion: 'v2',
      result: 'success',
      status: 200,
      bytes: 150,
    }
    const miss = {
      event: 'tdx_city_cache',
      city: 'Taipei',
      resource: 'Route',
      resolution: 'miss',
      sourceVersion: 'v2',
      status: 200,
      bytes: 15_000_000,
    }
    const byok429 = runtime({
      operation: 'place_arrivals',
      credentialScope: 'byok',
      result: 'http_error',
      status: 429,
      receivedBytes: null,
      declaredBytes: 300,
      failureClass: 'tdx_429',
    })
    const transport = runtime({
      result: 'transport_error',
      status: null,
      attempt: 2,
      receivedBytes: null,
      declaredBytes: null,
      failureClass: 'timeout',
    })

    const text = [
      JSON.stringify(runtime()),
      `2026-09-09T01:00:00Z worker ${JSON.stringify(probe)}`,
      JSON.stringify({ log: JSON.stringify(miss) }),
      JSON.stringify({ message: [JSON.stringify(byok429)] }),
      JSON.stringify(transport),
      'not json',
      JSON.stringify({ event: 'other_event' }),
    ].join('\n')

    const parsed = parseTdxUsageText(text)
    expect(parsed.input).toEqual({
      nonEmptyLines: 7,
      parsedLines: 6,
      malformedLines: 1,
      unrelatedRecords: 1,
    })
    expect(parsed.events).toHaveLength(5)

    const summary = summarizeTdxUsage(parsed.events, parsed.input)
    expect(summary.rates).toMatchObject({
      callsPerPoint: TDX_CALLS_PER_POINT,
      bytesPerPoint: TDX_BYTES_PER_POINT,
    })
    expect(summary.scopes.shared).toMatchObject({
      attempts: 4,
      httpResponses: 3,
      successResponses: 3,
      exactReceivedBytes: 16_500_150,
      unknownByteResponses: 0,
      declaredOnlyBytes: 0,
    })
    expect(summary.scopes.byok).toMatchObject({
      attempts: 1,
      httpResponses: 1,
      successResponses: 0,
      exactReceivedBytes: 0,
      unknownByteResponses: 1,
      declaredOnlyBytes: 300,
    })
    expect(summary.scopes.all.responseCallPoints).toBeCloseTo(4 / 1_500)
    expect(summary.scopes.all.exactVolumePoints).toBeCloseTo(16_500_150 / 150_000_000)
    expect(summary.scopes.all.combinedKnownEstimate).toBeCloseTo(
      (4 / 1_500) + (16_500_150 / 150_000_000),
    )

    expect(summary.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        billingScope: 'shared',
        plane: 'snapshot',
        operation: 'source_probe',
        resource: 'Route',
        scope: 'City/*',
        httpResponses: 1,
        exactReceivedBytes: 150,
      }),
      expect.objectContaining({
        billingScope: 'shared',
        plane: 'snapshot',
        operation: 'full_source',
        resource: 'Route',
        scope: 'City/Taipei',
        httpResponses: 1,
        exactReceivedBytes: 15_000_000,
      }),
    ]))
  })

  it('counts transport failures as attempts only and keeps declared-only bytes separate', () => {
    const snapshotError = {
      event: 'tdx_intercity_cache',
      resource: 'Shape',
      resolution: 'upstream-error',
      sourceVersion: 'v3',
      status: 503,
      bytes: 900,
    }
    const parsed = parseTdxUsageText([
      JSON.stringify(runtime({
        result: 'transport_error',
        status: null,
        receivedBytes: null,
        declaredBytes: null,
        failureClass: 'timeout',
      })),
      JSON.stringify(snapshotError),
    ].join('\n'))

    const summary = summarizeTdxUsage(parsed.events, parsed.input)
    expect(summary.scopes.shared).toMatchObject({
      attempts: 2,
      httpResponses: 1,
      successResponses: 0,
      exactReceivedBytes: 0,
      unknownByteResponses: 1,
      declaredOnlyBytes: 900,
    })
    expect(summary.scopes.shared.responseCallPoints).toBeCloseTo(1 / 1_500)
    expect(summary.scopes.shared.exactVolumePoints).toBe(0)
    expect(summary.scopes.shared.declaredAdjustedVolumePoints).toBeCloseTo(900 / 150_000_000)
  })

  it('fails closed on incomplete usage-shaped records instead of inventing billing scope', () => {
    const parsed = parseTdxUsageText([
      JSON.stringify({ message: 'tdx_upstream_usage', result: 'success', status: 200 }),
      JSON.stringify({
        event: 'tdx_city_cache',
        resource: 'Route',
        resolution: 'miss',
        status: 200,
        bytes: 100,
      }),
      JSON.stringify({
        event: 'tdx_city_persistent_cache',
        resource: 'Route',
        resolution: 'probe',
        result: 'success',
        status: 200,
        bytes: null,
      }),
    ].join('\n'))

    expect(parsed.events).toEqual([])
    expect(parsed.input).toMatchObject({ parsedLines: 3, unrelatedRecords: 3 })
    const summary = summarizeTdxUsage(parsed.events, parsed.input)
    expect(summary.scopes.all).toMatchObject({ attempts: 0, httpResponses: 0, exactReceivedBytes: 0 })
  })

  it('formats an explicit estimate disclaimer and tabular breakdown', () => {
    const parsed = parseTdxUsageText(JSON.stringify(runtime()))
    const report = formatTdxUsageSummary(summarizeTdxUsage(parsed.events, parsed.input))

    expect(report).toContain('TDX upstream usage summary')
    expect(report).toContain('settlement and rounding remain authoritative')
    expect(report).toContain('shared\t1\t1\t1\t1.500000')
    expect(report).toContain('runtime\tbus_eta\tEstimatedTimeOfArrival\tCity/Taipei')
    expect(report).toContain('recognized_events=1')
  })
})
