import { describe, expect, it, vi } from 'vitest'
import { createTDXUpstreamDataClient } from './upstream-data-client'

describe('TDX realtime vehicle resource classification', () => {
  it('reports RealTimeByFrequency instead of other', async () => {
    const client = createTDXUpstreamDataClient({
      requestTimeoutMs: 1000,
      assertCircuitsClosed: vi.fn(),
      recordCircuitFailure: vi.fn(),
      recordCircuitSuccess: vi.fn(),
      responseError: vi.fn(async () => { throw new Error('unexpected response error') }),
      fetcher: vi.fn(async () => new Response('[]', { status: 200 })),
    })

    const result = await client.fetchUpstream({
      url: new URL('https://tdx.transportdata.tw/api/basic/v2/Bus/RealTimeByFrequency/City/Taipei/307'),
      maxResponseBytes: 1024,
      operation: 'vehicle_positions',
      token: 'token',
      isShared: true,
      credentialKey: 'shared-key',
      ttlSeconds: 30,
      validatesPayload: true,
    })

    expect(result.resource).toBe('RealTimeByFrequency')
    expect(result.circuitKey).toBe('data/shared-key/vehicle_positions/City/Taipei')
    expect(result.outcome.ok).toBe(true)
  })
})
