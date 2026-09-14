import { describe, expect, it, vi } from 'vitest'
import { classifyPublicProbeRequestFailureDetail } from './run-public-probe.mjs'
import {
  createRouteWindowPublicApi,
  ROUTE_RESPONSE_MAX_BYTES,
} from './run-public-probe-route-window.mjs'

const MIB = 1024 * 1024

function paddedJson(bytes) {
  const prefix = '{"payload":"'
  const suffix = '"}'
  return `${prefix}${'x'.repeat(bytes - prefix.length - suffix.length)}${suffix}`
}

describe('public probe route response window', () => {
  it('accepts an ordinary route response above 2 MiB while staying bounded at 4 MiB', async () => {
    const fetchImpl = vi.fn(async () => new Response(paddedJson(3 * MIB), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const api = createRouteWindowPublicApi({
      baseUrl: 'https://example.test',
      fetchImpl,
      expensiveIntervalMs: 0,
      sleep: vi.fn(),
      monotonic: () => 0,
    })

    await expect(api.getJson('/api/v1/map/route?city=Hsinchu&route=1'))
      .resolves.toMatchObject({ payload: expect.any(String) })
    expect(ROUTE_RESPONSE_MAX_BYTES).toBe(4 * MIB)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('keeps non-route public JSON responses on the existing 2 MiB bound', async () => {
    const fetchImpl = vi.fn(async () => new Response(paddedJson(3 * MIB), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const api = createRouteWindowPublicApi({
      baseUrl: 'https://example.test',
      fetchImpl,
      expensiveIntervalMs: 0,
      sleep: vi.fn(),
      monotonic: () => 0,
    })

    await expect(api.getJson('/api/v1/map/routes?city=Hsinchu'))
      .rejects.toThrow('Bounded response is too large')
  })

  it('preserves bounded 5xx JSON attribution on the widened route path', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"error":"temporary"}', {
      status: 502,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    }))
    const api = createRouteWindowPublicApi({
      baseUrl: 'https://example.test',
      fetchImpl,
      expensiveIntervalMs: 0,
      sleep: vi.fn(),
      monotonic: () => 0,
    })

    const error = await api.getJson('/api/v1/map/route?city=Hsinchu&route=1').catch((value) => value)
    expect(classifyPublicProbeRequestFailureDetail(error)).toEqual({
      requestFailureReason: 'http_error',
      requestHttpStatusClass: '5xx',
      requestHttpResponseKind: 'json',
    })
  })
})
