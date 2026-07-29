import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TelemetryEnvelope } from '../../observability/telemetry'
import { resetMemoryCacheForTests } from '../memory-cache'
import { TDXServiceError } from './error-classification'
import { createTDXResolutionCache, type TDXEnv, type TDXResolutionCacheDependencies } from './resolution-cache'
import type { TDXUpstreamResult } from './upstream-data-client'

const url = new URL('https://tdx.transportdata.tw/api/basic/v2/Bus/Route/City/Taipei?case=resolution')
const validate = (value: unknown): value is Array<{ id: string }> => (
  Array.isArray(value) && value.every((item) => item !== null && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string')
)

function environment(events: TelemetryEnvelope[] = []): TDXEnv {
  return {
    TDX_TELEMETRY: {
      now: () => 120_000,
      random: () => 0,
      emitter: (event: TelemetryEnvelope) => events.push(event),
    },
  } as unknown as TDXEnv
}

function success(data: unknown = [{ id: 'fresh' }], leader = true): TDXUpstreamResult {
  return {
    outcome: { ok: true, data, status: 200, receivedBytes: 16, declaredBytes: 16, retryCount: 0 },
    leader,
    circuitKey: 'data/fixture',
    resource: 'Route',
  }
}

function setup(overrides: Partial<TDXResolutionCacheDependencies> = {}) {
  const getTDXToken = vi.fn(async () => ({ token: 'fixture', isShared: false, credentialKey: 'fixture' }))
  const fetchUpstream = vi.fn(async () => success())
  const recordCircuitFailure = vi.fn()
  const recordCircuitSuccess = vi.fn()
  const dependencies = {
    getTDXToken,
    fetchUpstream,
    recordCircuitFailure,
    recordCircuitSuccess,
    ...overrides,
  } satisfies TDXResolutionCacheDependencies
  return {
    resolver: createTDXResolutionCache(dependencies),
    getTDXToken,
    fetchUpstream,
    recordCircuitFailure,
    recordCircuitSuccess,
  }
}

function stubCache(
  match: (request: Request) => Promise<Response | undefined> = vi.fn(async () => undefined),
) {
  const put = vi.fn(async () => undefined)
  vi.stubGlobal('caches', { default: { match, put } })
  return { match, put }
}

describe('TDX resolution cache boundary', () => {
  beforeEach(() => {
    resetMemoryCacheForTests()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
  })

  afterEach(() => {
    resetMemoryCacheForTests()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('uses upstream once, writes edge as leader, then serves memory', async () => {
    const events: TelemetryEnvelope[] = []
    const cache = stubCache()
    const state = setup()
    const options = { operation: 'vehicle_positions' as const, city: 'Taipei' as const, validate }

    await expect(state.resolver.resolveTDXJson(environment(events), url, 30, options)).resolves.toMatchObject({ resolution: 'upstream' })
    await expect(state.resolver.resolveTDXJson(environment(events), url, 30, options)).resolves.toMatchObject({ resolution: 'memory' })

    expect(state.getTDXToken).toHaveBeenCalledOnce()
    expect(state.fetchUpstream).toHaveBeenCalledOnce()
    expect(state.recordCircuitSuccess).toHaveBeenCalledWith('data/fixture')
    expect(cache.put).toHaveBeenCalledOnce()
    expect(events.map((event) => event.resolution)).toEqual(['upstream', 'memory'])
  })

  it('serves edge, reports age, and warms memory before token acquisition', async () => {
    const events: TelemetryEnvelope[] = []
    const match = vi.fn(async () => new Response(JSON.stringify([{ id: 'edge' }]), {
      headers: { 'X-Mochi-Cached-At': '30000' },
    }))
    stubCache(match)
    const state = setup()
    const options = { operation: 'vehicle_positions' as const, city: 'Taipei' as const, validate }

    await expect(state.resolver.fetchTDXJson(environment(events), url, 30, options)).resolves.toEqual([{ id: 'edge' }])
    await expect(state.resolver.resolveTDXJson(environment(events), url, 30, options)).resolves.toMatchObject({ resolution: 'memory' })

    expect(match).toHaveBeenCalledOnce()
    expect(state.getTDXToken).not.toHaveBeenCalled()
    expect(events[0]).toMatchObject({ resolution: 'edge', dataAgeBucket: '1_5m' })
  })

  it('uses stale data for cooldown without token or upstream work', async () => {
    const events: TelemetryEnvelope[] = []
    stubCache()
    const state = setup()
    const result = await state.resolver.resolveTDXJson(environment(events), url, 30, {
      operation: 'vehicle_positions',
      validate,
      blockedFailureClass: 'rate_limited',
      staleFallback: async () => ({ data: [{ id: 'stale' }], dataAgeMilliseconds: 7 * 60_000 }),
    })

    expect(result).toMatchObject({ resolution: 'stale_replay', degraded: true })
    expect(state.getTDXToken).not.toHaveBeenCalled()
    expect(state.fetchUpstream).not.toHaveBeenCalled()
    expect(events[0]).toMatchObject({ result: 'degraded', failureClass: 'rate_limited', dataAgeBucket: '5_30m' })
  })

  it('reports token circuit-open without claiming upstream resolution', async () => {
    const events: TelemetryEnvelope[] = []
    stubCache()
    const error = new TDXServiceError('circuit open', 429, { failureKind: 'circuit_open' })
    const state = setup({ getTDXToken: vi.fn(async () => { throw error }) })

    await expect(state.resolver.fetchTDXJson(environment(events), url, 30, {
      operation: 'vehicle_positions', validate,
    })).rejects.toBe(error)

    expect(state.fetchUpstream).not.toHaveBeenCalled()
    expect(events[0]).toMatchObject({ resolution: 'circuit_open', result: 'error', failureClass: 'circuit_open' })
  })

  it('reports leader schema failure, clears the data circuit, and skips cache writes', async () => {
    const events: TelemetryEnvelope[] = []
    const cache = stubCache()
    const state = setup({ fetchUpstream: vi.fn(async () => success({ id: 'wrong-shape' })) })

    await expect(state.resolver.fetchTDXJson(environment(events), url, 30, {
      operation: 'vehicle_positions', validate,
    })).rejects.toMatchObject({ failureKind: 'invalid_schema' })

    expect(state.recordCircuitSuccess).toHaveBeenCalledWith('data/fixture')
    expect(state.recordCircuitFailure).not.toHaveBeenCalled()
    expect(cache.put).not.toHaveBeenCalled()
    expect(events[0]).toMatchObject({ resolution: 'upstream', result: 'error', failureClass: 'invalid_schema' })
  })

  it('lets a follower warm memory without closing circuit or writing edge', async () => {
    const cache = stubCache()
    const fetchUpstream = vi.fn(async () => success([{ id: 'follower' }], false))
    const state = setup({ fetchUpstream })

    await expect(state.resolver.fetchTDXJson(environment(), url, 30, { validate })).resolves.toEqual([{ id: 'follower' }])
    await expect(state.resolver.resolveTDXJson(environment(), url, 30, { validate })).resolves.toMatchObject({ resolution: 'memory' })

    expect(fetchUpstream).toHaveBeenCalledOnce()
    expect(state.recordCircuitSuccess).not.toHaveBeenCalled()
    expect(state.recordCircuitFailure).not.toHaveBeenCalled()
    expect(cache.put).not.toHaveBeenCalled()
  })
})
