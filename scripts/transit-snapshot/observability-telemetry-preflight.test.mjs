import { describe, expect, it, vi } from 'vitest'
import {
  MAX_TELEMETRY_KEYS,
  probeObservabilityTelemetry,
} from './observability-telemetry-preflight.mjs'

function apiResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('Workers Observability telemetry preflight', () => {
  it('uses the telemetry keys endpoint and reports D1 automatic trace fields without exposing key values', async () => {
    const fetchImpl = vi.fn(async () => apiResponse({
      success: true,
      errors: [],
      messages: [],
      result: [
        { key: '$metadata.service', lastSeenAt: 1, type: 'string' },
        { key: 'cloudflare.d1.response.rows_read', lastSeenAt: 1, type: 'number' },
        { key: 'cloudflare.d1.response.rows_written', lastSeenAt: 1, type: 'number' },
        { key: 'cloudflare.d1.response.sql_duration_ms', lastSeenAt: 1, type: 'number' },
        { key: 'db.query.text', lastSeenAt: 1, type: 'string' },
        { key: 'db.operation.name', lastSeenAt: 1, type: 'string' },
      ],
    }))

    const report = await probeObservabilityTelemetry({
      accountId: 'account-id',
      apiToken: 'secret-token',
      fetchImpl,
      generatedAt: '2026-09-10T05:00:00.000Z',
    })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/account-id/workers/observability/telemetry/keys')
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Bearer secret-token')
    expect(init.body).toBe('{}')
    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedAt: '2026-09-10T05:00:00.000Z',
      outcome: 'authorized',
      authorized: true,
      httpStatus: 200,
      keyCount: 6,
      d1TraceKeys: {
        rowsRead: true,
        rowsWritten: true,
        sqlDurationMs: true,
        queryText: true,
        operationName: true,
      },
      errorDetail: null,
    })
    expect(JSON.stringify(report)).not.toContain('secret-token')
    expect(JSON.stringify(report)).not.toContain('account-id')
  })

  it('records a bounded unauthorized outcome while redacting credentials and account identity', async () => {
    const report = await probeObservabilityTelemetry({
      accountId: 'account-secret',
      apiToken: 'token-secret',
      fetchImpl: async () => apiResponse({
        success: false,
        errors: [{
          code: 10000,
          message: 'token-secret is not authorized for account-secret\nWorkers Observability Write required',
        }],
      }, 403),
      generatedAt: '2026-09-10T05:00:00.000Z',
    })

    expect(report.outcome).toBe('unauthorized')
    expect(report.authorized).toBe(false)
    expect(report.httpStatus).toBe(403)
    expect(report.keyCount).toBeNull()
    expect(report.errorDetail).toContain('[10000]')
    expect(report.errorDetail).toContain('<redacted>')
    expect(report.errorDetail).toContain('Workers Observability Write required')
    expect(report.errorDetail).not.toContain('token-secret')
    expect(report.errorDetail).not.toContain('account-secret')
    expect(report.errorDetail).not.toContain('\n')
  })

  it('treats transport and malformed responses as unavailable evidence instead of fabricating access', async () => {
    const network = await probeObservabilityTelemetry({
      accountId: 'account-id',
      apiToken: 'token',
      fetchImpl: async () => { throw new Error('network details') },
    })
    expect(network).toMatchObject({ outcome: 'network_error', authorized: false })
    expect(network.errorDetail).toBeNull()

    const invalidJson = await probeObservabilityTelemetry({
      accountId: 'account-id',
      apiToken: 'token',
      fetchImpl: async () => new Response('<html>bad</html>', { status: 200 }),
    })
    expect(invalidJson).toMatchObject({ outcome: 'invalid_json', authorized: false, httpStatus: 200 })
  })

  it('fails closed when a successful key payload is unbounded or malformed', async () => {
    const tooMany = await probeObservabilityTelemetry({
      accountId: 'account-id',
      apiToken: 'token',
      fetchImpl: async () => apiResponse({
        success: true,
        result: Array.from({ length: MAX_TELEMETRY_KEYS + 1 }, (_, index) => ({ key: `k${index}` })),
      }),
    })
    expect(tooMany).toMatchObject({ outcome: 'invalid_payload', authorized: false })

    const malformed = await probeObservabilityTelemetry({
      accountId: 'account-id',
      apiToken: 'token',
      fetchImpl: async () => apiResponse({ success: true, result: [{ key: '' }] }),
    })
    expect(malformed).toMatchObject({ outcome: 'invalid_payload', authorized: false })
  })
})
