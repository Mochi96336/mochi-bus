import { describe, expect, it, vi } from 'vitest'
import {
  emitTelemetry,
  errorFingerprint,
  httpStatusClass,
  latencyBucket,
  parseTelemetryEvent,
  TELEMETRY_EVENT_SCHEMA,
  type TelemetryEnvelope,
} from './telemetry'

function validEvent(overrides: Partial<TelemetryEnvelope> = {}): TelemetryEnvelope {
  return {
    eventSchema: TELEMETRY_EVENT_SCHEMA,
    event: 'api_operation_completed',
    releaseSha: null,
    workerVersionId: null,
    workerCreatedAt: null,
    deploymentId: null,
    city: 'Taipei',
    operation: 'map_routes',
    result: 'success',
    source: 'snapshot',
    snapshotVersion: '2026-07-19T03:17:00Z',
    httpStatusClass: '2xx',
    latencyBucket: '50_199ms',
    cacheResult: 'edge_hit',
    trafficClass: 'user',
    sampleProbability: 0.1,
    failureClass: 'none',
    emptyReason: 'not_applicable',
    qualityBucket: 'not_applicable',
    ...overrides,
  }
}

function validResolutionEvent(overrides: Partial<TelemetryEnvelope> = {}): TelemetryEnvelope {
  return validEvent({
    event: 'tdx_resolution_completed',
    operation: 'map_vehicles',
    result: 'success',
    source: 'realtime',
    snapshotVersion: null,
    httpStatusClass: 'none',
    cacheResult: 'miss',
    tdxOperation: 'vehicle_positions',
    credentialScope: 'shared',
    resolution: 'upstream',
    retryCountBucket: '0',
    recoveredAfterRetry: false,
    dataAgeBucket: 'fresh',
    upstreamStatusClass: '2xx',
    ...overrides,
  })
}

function validWindowEvent(overrides: Partial<TelemetryEnvelope> = {}): TelemetryEnvelope {
  return validEvent({
    event: 'snapshot_window_completed',
    operation: 'snapshot_publish',
    result: 'success',
    source: 'snapshot',
    snapshotVersion: '20260719T031700000Z',
    httpStatusClass: 'none',
    cacheResult: 'not_applicable',
    trafficClass: 'snapshot_publish',
    sampleProbability: 1,
    windowId: 'v1:Taipei:2026-07-20:0317',
    windowResult: 'published',
    activeVersion: '20260719T031700000Z',
    previousVersion: '20260712T031700000Z',
    workflowRunId: '29500000000',
    ...overrides,
  })
}

function validProbeEvent(overrides: Partial<TelemetryEnvelope> = {}): TelemetryEnvelope {
  return validEvent({
    event: 'snapshot_probe_completed',
    operation: 'snapshot_probe',
    result: 'success',
    source: 'snapshot',
    snapshotVersion: '20260719T031700000Z',
    httpStatusClass: 'none',
    cacheResult: 'not_applicable',
    trafficClass: 'publish_smoke',
    sampleProbability: 1,
    windowId: 'v1:Taipei:2026-07-20:0317',
    versionRole: 'active',
    probeGroup: 'active_snapshot',
    rollbackAvailable: true,
    probeCaseVersion: 1,
    sampleCaseId: 'case_0123456789ab',
    hardChecksPassed: 11,
    diagnosticWarningCount: 0,
    ...overrides,
  })
}

function validPublicProbeEvent(overrides: Partial<TelemetryEnvelope> = {}): TelemetryEnvelope {
  return validEvent({
    event: 'public_probe_completed',
    operation: 'public_probe',
    result: 'success',
    source: 'snapshot',
    snapshotVersion: '20260719T031700000Z',
    httpStatusClass: 'none',
    cacheResult: 'not_applicable',
    trafficClass: 'synthetic',
    sampleProbability: 1,
    probeCaseVersion: 1,
    sampleCaseId: 'pub_0123456789ab',
    hardChecksPassed: 10,
    diagnosticWarningCount: 0,
    ...overrides,
  })
}

describe('telemetry contract', () => {
  it('accepts and freezes an allowlisted common envelope', () => {
    const event = parseTelemetryEvent(validEvent())

    expect(event).toEqual(validEvent())
    expect(Object.isFrozen(event)).toBe(true)
  })

  it('requires every denominator field and rejects unknown enum values', () => {
    const missingResult = { ...validEvent() } as Record<string, unknown>
    delete missingResult.result

    expect(parseTelemetryEvent(missingResult)).toBeUndefined()
    expect(parseTelemetryEvent({ ...validEvent(), operation: 'arbitrary_path' })).toBeUndefined()
    expect(parseTelemetryEvent({ ...validEvent(), result: 'ok' })).toBeUndefined()
    expect(parseTelemetryEvent({ ...validEvent(), sampleProbability: 0 })).toBeUndefined()
    expect(parseTelemetryEvent({ ...validEvent(), releaseSha: '0123456' })).toBeUndefined()
    expect(parseTelemetryEvent({ ...validEvent(), result: 'empty' })).toBeUndefined()
    expect(parseTelemetryEvent({ ...validEvent(), result: 'error', failureClass: 'none' })).toBeUndefined()
  })

  it.each([
    ['Authorization', 'Bearer secret'],
    ['accessToken', 'token'],
    ['clientSecret', 'secret'],
    ['credentialFingerprint', 'fingerprint'],
    ['ip', '203.0.113.10'],
    ['ipHash', 'hash'],
    ['latitude', 25.033],
    ['longitude', 121.5654],
    ['url', 'https://bus.example/map?place=private'],
    ['query', 'route=307'],
    ['searchText', 'home address'],
    ['requestBody', { route: '307' }],
    ['responseBody', { token: 'secret' }],
    ['plate', 'ABC-1234'],
    ['boardId', 'board-private'],
    ['journeyId', 'journey-private'],
    ['error', 'raw failure'],
    ['message', 'raw failure'],
    ['cause', 'raw cause'],
    ['stack', 'raw stack'],
  ])('rejects the prohibited %s field instead of silently sanitizing it', (key, value) => {
    expect(parseTelemetryEvent({ ...validEvent(), [key]: value })).toBeUndefined()
  })

  it('rejects sensitive markers smuggled through an otherwise allowed identifier', () => {
    expect(parseTelemetryEvent({ ...validEvent(), deploymentId: 'client-secret' })).toBeUndefined()
    expect(parseTelemetryEvent({ ...validEvent(), snapshotVersion: 'access_token' })).toBeUndefined()
  })

  it('requires bounded TDX resolution fields only on resolution events', () => {
    expect(parseTelemetryEvent(validResolutionEvent())).toEqual(validResolutionEvent())
    expect(parseTelemetryEvent({ ...validResolutionEvent(), resolution: undefined })).toBeUndefined()
    expect(parseTelemetryEvent({ ...validResolutionEvent(), credentialScope: 'token-hash' })).toBeUndefined()
    expect(parseTelemetryEvent({ ...validResolutionEvent(), retryCountBucket: '1' })).toBeUndefined()
    expect(parseTelemetryEvent(validResolutionEvent({
      retryCountBucket: '1',
      recoveredAfterRetry: true,
      initialFailureClass: 'timeout',
    }))).toBeDefined()
    expect(parseTelemetryEvent(validResolutionEvent({
      resolution: 'memory',
      result: 'error',
      failureClass: 'network_error',
      cacheResult: 'memory_hit',
      upstreamStatusClass: 'none',
      dataAgeBucket: '1_5m',
    }))).toBeUndefined()
    expect(parseTelemetryEvent(validResolutionEvent({
      resolution: 'stale_replay',
      result: 'degraded',
      failureClass: 'none',
      cacheResult: 'bypass',
      upstreamStatusClass: 'none',
    }))).toBeUndefined()
    expect(parseTelemetryEvent(validResolutionEvent({
      retryCountBucket: '1',
      recoveredAfterRetry: true,
      initialFailureClass: 'none',
    }))).toBeUndefined()
    expect(parseTelemetryEvent(validResolutionEvent({ cacheResult: 'edge_hit' }))).toBeUndefined()
    expect(parseTelemetryEvent(validResolutionEvent({ operation: 'map_routes' }))).toBeUndefined()
    expect(parseTelemetryEvent(validResolutionEvent({ source: 'schedule' }))).toBeUndefined()
    expect(parseTelemetryEvent({ ...validEvent(), tdxOperation: 'vehicle_positions' })).toBeUndefined()
  })

  it('requires a strict snapshot window result mapping only on window events', () => {
    expect(parseTelemetryEvent(validWindowEvent())).toEqual(validWindowEvent())
    expect(parseTelemetryEvent(validWindowEvent({ windowResult: 'unchanged' }))).toBeDefined()
    expect(parseTelemetryEvent(validWindowEvent({
      result: 'error',
      source: 'none',
      windowResult: 'failed',
      failureClass: 'snapshot_stage',
    }))).toBeDefined()
    expect(parseTelemetryEvent(validWindowEvent({ windowId: undefined }))).toBeUndefined()
    expect(parseTelemetryEvent(validWindowEvent({ result: 'success', windowResult: 'failed' }))).toBeUndefined()
    expect(parseTelemetryEvent(validWindowEvent({ snapshotVersion: 'other-version' }))).toBeUndefined()
    expect(parseTelemetryEvent({ ...validEvent(), windowId: 'v1:Taipei:2026-07-20:0317' })).toBeUndefined()
  })

  it('accepts only bounded active snapshot probe metadata', () => {
    expect(parseTelemetryEvent(validProbeEvent())).toEqual(validProbeEvent())
    expect(parseTelemetryEvent(validProbeEvent({
      result: 'degraded', failureClass: 'previous_unavailable',
      rollbackAvailable: false, diagnosticWarningCount: 1,
    }))).toBeDefined()
    expect(parseTelemetryEvent(validProbeEvent({
      result: 'error', failureClass: 'network_missing', rollbackAvailable: false, hardChecksPassed: 5,
    }))).toBeDefined()
    expect(parseTelemetryEvent(validProbeEvent({ hardChecksPassed: 12 }))).toBeUndefined()
    expect(parseTelemetryEvent(validProbeEvent({ result: 'success', failureClass: 'network_missing' }))).toBeUndefined()
    expect(parseTelemetryEvent(validProbeEvent({ versionRole: 'previous' }))).toBeUndefined()
    expect(parseTelemetryEvent({ ...validEvent(), sampleCaseId: 'case_0123456789ab' })).toBeUndefined()
  })

  it.each([
    'routing_authority_read_failed',
    'routing_authority_incomplete',
    'routing_authority_invalid',
  ] as const)('retains the bounded %s active-probe failure class', (failureClass) => {
    expect(parseTelemetryEvent(validProbeEvent({
      result: 'error', failureClass, rollbackAvailable: false, hardChecksPassed: 1,
    }))).toBeDefined()
  })

  it('separates public probe hard health from realtime degradation', () => {
    expect(parseTelemetryEvent(validPublicProbeEvent())).toEqual(validPublicProbeEvent())
    expect(parseTelemetryEvent(validPublicProbeEvent({
      result: 'degraded', failureClass: 'realtime_schedule_only', diagnosticWarningCount: 2,
    }))).toBeDefined()
    expect(parseTelemetryEvent(validPublicProbeEvent({
      result: 'error', source: 'none', failureClass: 'public_version_mismatch', hardChecksPassed: 5,
    }))).toBeDefined()
    // A degraded realtime plane never claims the snapshot plane failed.
    expect(parseTelemetryEvent(validPublicProbeEvent({
      result: 'degraded', failureClass: 'realtime_schedule_only', diagnosticWarningCount: 2, source: 'none',
    }))).toBeUndefined()
    expect(parseTelemetryEvent(validPublicProbeEvent({
      result: 'degraded', failureClass: 'realtime_schedule_only', diagnosticWarningCount: 2, hardChecksPassed: 9,
    }))).toBeUndefined()
    expect(parseTelemetryEvent(validPublicProbeEvent({ hardChecksPassed: 11 }))).toBeUndefined()
    expect(parseTelemetryEvent(validPublicProbeEvent({ versionRole: 'active' }))).toBeUndefined()
    expect(parseTelemetryEvent(validPublicProbeEvent({ trafficClass: 'user' }))).toBeUndefined()
  })
})

describe('telemetry helpers', () => {
  it('emits the validated object and fails open when validation or the sink fails', () => {
    const sink = vi.fn()

    expect(emitTelemetry(validEvent(), sink)).toBe(true)
    expect(sink).toHaveBeenCalledWith(validEvent())
    expect(emitTelemetry({ ...validEvent(), stack: 'private' }, sink)).toBe(false)
    expect(() => emitTelemetry(validEvent(), () => { throw new Error('console unavailable') })).not.toThrow()
    expect(emitTelemetry(validEvent(), () => { throw new Error('console unavailable') })).toBe(false)
  })

  it('does not affect the caller when the default console sink throws', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => { throw new Error('console unavailable') })

    expect(() => emitTelemetry(validEvent())).not.toThrow()
    expect(emitTelemetry(validEvent())).toBe(false)
    log.mockRestore()
  })

  it('uses stable latency and HTTP status buckets', () => {
    expect([49, 50, 199, 200, 999, 1_000, 2_999, 3_000, 6_000, 6_001].map(latencyBucket))
      .toEqual(['lt_50ms', '50_199ms', '50_199ms', '200_999ms', '200_999ms', '1_3s', '1_3s', '3_6s', '3_6s', 'gt_6s'])
    expect(latencyBucket(Number.NaN)).toBe('unknown')
    expect(httpStatusClass(204)).toBe('2xx')
    expect(httpStatusClass(429)).toBe('4xx')
    expect(httpStatusClass(503)).toBe('5xx')
    expect(httpStatusClass(undefined)).toBe('none')
  })

  it('fingerprints only sanitized error type, asset basename, and line bucket', async () => {
    const first = await errorFingerprint({
      errorType: 'TypeError',
      assetUrl: 'https://bus.example/assets/map-abc123.js?Authorization=Bearer-secret',
      line: 38,
    })
    const sameSafeParts = await errorFingerprint({
      errorType: 'TypeError',
      assetUrl: 'https://other.example/private/assets/map-abc123.js?token=another-secret',
      line: 49,
    })
    const nextLineBucket = await errorFingerprint({
      errorType: 'TypeError',
      assetUrl: 'https://bus.example/assets/map-abc123.js',
      line: 51,
    })

    expect(first).toMatch(/^err_[a-f0-9]{16}$/)
    expect(first).toBe(sameSafeParts)
    expect(first).not.toBe(nextLineBucket)
    expect(first).not.toMatch(/Authorization|Bearer|secret|bus\.example|private/)
  })

  it('collapses arbitrary error labels and non-asset paths to safe fallback values', async () => {
    const arbitrary = await errorFingerprint({
      errorType: 'HomeAddressFromUser',
      assetUrl: 'https://example.test/private/home-address',
      line: 7,
    })
    const fallback = await errorFingerprint({ errorType: 'Error', line: 7 })

    expect(arbitrary).toBe(fallback)
  })
})
