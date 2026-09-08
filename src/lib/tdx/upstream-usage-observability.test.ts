import { describe, expect, it, vi } from 'vitest'
import { TDXServiceError } from './error-classification'
import {
  createTDXUpstreamDataClient,
  type TDXUpstreamRequest,
  type TDXUpstreamUsageEvent,
} from './upstream-data-client'

function request(overrides: Partial<TDXUpstreamRequest> = {}): TDXUpstreamRequest {
  return {
    url: new URL('https://tdx.transportdata.tw/api/basic/v2/Bus/EstimatedTimeOfArrival/City/Taipei?$filter=private'),
    maxResponseBytes: 1024,
    operation: 'place_arrivals',
    token: 'private-token',
    isShared: true,
    credentialKey: 'credential-key',
    ttlSeconds: 45,
    validatesPayload: true,
    ...overrides,
  }
}

function client(fetcher: typeof fetch, usageLogger: (event: TDXUpstreamUsageEvent) => void) {
  return createTDXUpstreamDataClient({
    requestTimeoutMs: 1000,
    assertCircuitsClosed: vi.fn(),
    recordCircuitFailure: vi.fn(),
    recordCircuitSuccess: vi.fn(),
    responseError: vi.fn(async (_context, response) => new TDXServiceError(
      'TDX request failed',
      response.status,
      { failureKind: response.status >= 500 ? 'upstream_5xx' : 'upstream_4xx' },
    )),
    fetcher,
    usageLogger,
  })
}

describe('TDX upstream quota observability', () => {
  it('emits one identity-safe exact event for each successful upstream call', async () => {
    const body = '[{"EstimateTime":30}]'
    const bytes = new TextEncoder().encode(body).byteLength
    const usageLogger = vi.fn()
    const upstream = client(vi.fn(async () => new Response(body, {
      headers: { 'Content-Length': String(bytes) },
    })), usageLogger)

    await expect(upstream.fetchUpstream(request())).resolves.toMatchObject({
      outcome: { ok: true, receivedBytes: bytes },
    })

    expect(usageLogger).toHaveBeenCalledOnce()
    expect(usageLogger).toHaveBeenCalledWith({
      message: 'tdx_upstream_usage',
      operation: 'place_arrivals',
      resource: 'EstimatedTimeOfArrival',
      scope: 'City/Taipei',
      credentialScope: 'shared',
      result: 'success',
      status: 200,
      attempt: 1,
      receivedBytes: bytes,
      declaredBytes: bytes,
      failureClass: 'none',
    })
    expect(JSON.stringify(usageLogger.mock.calls)).not.toMatch(/private-token|credential-key|\$filter=private/)
  })

  it('records retries as separate upstream attempts so request counts are reconstructable', async () => {
    const usage: TDXUpstreamUsageEvent[] = []
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'))
      .mockResolvedValueOnce(new Response('[]', { headers: { 'Content-Length': '2' } }))
    const upstream = client(fetcher, (event) => usage.push(event))

    await expect(upstream.fetchUpstream(request())).resolves.toMatchObject({
      outcome: { ok: true, retryCount: 1 },
    })

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(usage).toEqual([
      expect.objectContaining({ result: 'transport_error', attempt: 1, failureClass: 'timeout' }),
      expect.objectContaining({ result: 'success', attempt: 2, receivedBytes: 2 }),
    ])
  })

  it('keeps usage logging fail-open', async () => {
    const upstream = client(
      vi.fn(async () => new Response('[]')),
      () => { throw new Error('logger unavailable') },
    )

    await expect(upstream.fetchUpstream(request())).resolves.toMatchObject({
      outcome: { ok: true, data: [] },
    })
  })
})
