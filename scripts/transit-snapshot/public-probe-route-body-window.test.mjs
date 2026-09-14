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

  it('captures bounded fallback evidence from the original 5xx response', async () => {
    const routeFailureEmitter = vi.fn()
    const fetchImpl = vi.fn(async () => new Response('{"error":"temporary"}', {
      status: 502,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Mochi-Snapshot-Fallback-Reason': 'manifest_missing',
      },
    }))
    const api = createRouteWindowPublicApi({
      baseUrl: 'https://example.test',
      fetchImpl,
      expensiveIntervalMs: 0,
      sleep: vi.fn(),
      monotonic: () => 0,
      routeFailureEmitter,
    })

    const error = await api
      .getJson('/api/v1/map/route?city=Hsinchu&route=private-route-name')
      .catch((value) => value)

    expect(classifyPublicProbeRequestFailureDetail(error)).toEqual({
      requestFailureReason: 'http_error',
      requestHttpStatusClass: '5xx',
      requestHttpResponseKind: 'json',
    })
    expect(routeFailureEmitter).toHaveBeenCalledOnce()
    expect(routeFailureEmitter).toHaveBeenCalledWith({
      message: 'public_probe_route_failure_response',
      city: 'Hsinchu',
      httpStatusClass: '5xx',
      responseKind: 'json',
      fallbackReason: 'manifest_missing',
    })
    expect(JSON.stringify(routeFailureEmitter.mock.calls[0][0])).not.toContain('private-route-name')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('drops unrecognized fallback headers instead of exposing arbitrary text', async () => {
    const routeFailureEmitter = vi.fn()
    const fetchImpl = vi.fn(async () => new Response('{"error":"temporary"}', {
      status: 503,
      headers: {
        'Content-Type': 'application/json',
        'X-Mochi-Snapshot-Fallback-Reason': 'unbounded-private-detail',
      },
    }))
    const api = createRouteWindowPublicApi({
      baseUrl: 'https://example.test',
      fetchImpl,
      routeFailureEmitter,
    })

    await api.getJson('/api/v1/map/route?city=Hsinchu&route=1').catch(() => undefined)
    expect(routeFailureEmitter).toHaveBeenCalledWith(expect.objectContaining({
      fallbackReason: null,
    }))
    expect(JSON.stringify(routeFailureEmitter.mock.calls[0][0])).not.toContain('unbounded-private-detail')
  })

  it('keeps diagnostics fail-open when the route failure emitter throws', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"error":"temporary"}', {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    }))
    const api = createRouteWindowPublicApi({
      baseUrl: 'https://example.test',
      fetchImpl,
      routeFailureEmitter: () => { throw new Error('diagnostic sink failed') },
    })

    const error = await api.getJson('/api/v1/map/route?city=Hsinchu&route=1').catch((value) => value)
    expect(classifyPublicProbeRequestFailureDetail(error)).toEqual({
      requestFailureReason: 'http_error',
      requestHttpStatusClass: '5xx',
      requestHttpResponseKind: 'json',
    })
  })
})
