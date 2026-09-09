import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TelemetryEnvelope } from '../../observability/telemetry'
import { resetMemoryCacheForTests } from '../memory-cache'
import { TDXServiceError } from './error-classification'
import { createTDXResolutionCache, type TDXEnv, type TDXResolutionCacheDependencies } from './resolution-cache'
import type { TDXUpstreamResult } from './upstream-data-client'

const url = new URL('https://tdx.transportdata.tw/api/basic/v2/Bus/Route/City/Taipei?case=resolution')
const sharedQuotaCooldownUrl = 'https://mochi-cache.invalid/tdx/shared-quota-cooldown'
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

function personalEnvironment(accessToken: string, events: TelemetryEnvelope[] = []): TDXEnv {
  return { ...environment(events), TDX_USER_ACCESS_TOKEN: accessToken }
}

function success(data: unknown = [{ id: 'fresh' }], leader = true): TDXUpstreamResult {
  return {
    outcome: { ok: true, data, status: 200, receivedBytes: 16, declaredBytes: 16, retryCount: 0 },
    leader,
    circuitKey: 'data/fixture',
    resource: 'Route',
  }
}

function failed(error: TDXServiceError): TDXUpstreamResult {
  return {
    outcome: { ok: false, error, retryCount: 0 },
    leader: true,
    circuitKey: 'data/fixture',
    resource: 'Route',
  }
}

function quotaError(): TDXServiceError {
  const error = new TDXServiceError('quota exhausted', 429, { failureKind: 'quota' })
  error.warning = 'tdx-quota'
  return error
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
  const put = vi.fn(async (_request: Request, _response: Response) => undefined)
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

  it('isolates shared and personal cache entries by credential identity', async () => {
    const cache = stubCache()
    let requestNumber = 0
    const fetchUpstream = vi.fn(async () => success([{ id: `fresh-${++requestNumber}` }]))
    const state = setup({ fetchUpstream })

    await expect(state.resolver.fetchTDXJson(environment(), url, 30, { validate }))
      .resolves.toEqual([{ id: 'fresh-1' }])
    await expect(state.resolver.fetchTDXJson(personalEnvironment('token-a'), url, 30, { validate }))
      .resolves.toEqual([{ id: 'fresh-2' }])
    await expect(state.resolver.resolveTDXJson(personalEnvironment('token-a'), url, 30, { validate }))
      .resolves.toMatchObject({ resolution: 'memory', data: [{ id: 'fresh-2' }] })
    await expect(state.resolver.fetchTDXJson(personalEnvironment('token-b'), url, 30, { validate }))
      .resolves.toEqual([{ id: 'fresh-3' }])

    expect(fetchUpstream).toHaveBeenCalledTimes(3)
    expect(state.getTDXToken).toHaveBeenCalledTimes(3)
    expect(cache.match).toHaveBeenCalledTimes(4)
    const cacheUrls = vi.mocked(cache.match).mock.calls.map(([request]) => request.url)
    expect(new Set(cacheUrls).size).toBe(4)
    expect(cacheUrls[0]).toBe(`https://mochi-cache.invalid/tdx/${encodeURIComponent(url.toString())}`)
    expect(cacheUrls[1]).toBe(sharedQuotaCooldownUrl)
    expect(cacheUrls.join('\n')).not.toContain('token-a')
    expect(cacheUrls.join('\n')).not.toContain('token-b')
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

  it('persists a five-minute edge marker when shared token acquisition reports quota exhaustion', async () => {
    const events: TelemetryEnvelope[] = []
    const cache = stubCache()
    const error = quotaError()
    const state = setup({ getTDXToken: vi.fn(async () => { throw error }) })

    await expect(state.resolver.fetchTDXJson(environment(events), url, 30, {
      operation: 'vehicle_positions', validate,
    })).rejects.toBe(error)

    expect(state.fetchUpstream).not.toHaveBeenCalled()
    expect(cache.put).toHaveBeenCalledOnce()
    const firstPut = vi.mocked(cache.put).mock.calls[0]
    expect(firstPut).toBeDefined()
    const [key, response] = firstPut!
    expect(key.url).toBe(sharedQuotaCooldownUrl)
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=300')
    expect(events[0]).toMatchObject({ resolution: 'upstream', result: 'error', failureClass: 'quota' })
  })

  it('persists the same edge marker when a shared data request reports quota exhaustion', async () => {
    const cache = stubCache()
    const error = quotaError()
    const state = setup({ fetchUpstream: vi.fn(async () => failed(error)) })

    await expect(state.resolver.fetchTDXJson(environment(), url, 30, { validate })).rejects.toBe(error)

    expect(cache.put).toHaveBeenCalledOnce()
    const firstPut = vi.mocked(cache.put).mock.calls[0]
    expect(firstPut).toBeDefined()
    expect(firstPut![0].url).toBe(sharedQuotaCooldownUrl)
  })

  it('uses a shared edge quota marker before token acquisition while preserving stale fallback', async () => {
    const events: TelemetryEnvelope[] = []
    const match = vi.fn(async (request: Request) => (
      request.url === sharedQuotaCooldownUrl ? new Response('1') : undefined
    ))
    stubCache(match)
    const state = setup()

    const result = await state.resolver.resolveTDXJson(environment(events), url, 30, {
      operation: 'vehicle_positions',
      validate,
      staleFallback: async () => ({ data: [{ id: 'stale' }], dataAgeMilliseconds: 8 * 60_000 }),
    })

    expect(result).toMatchObject({ resolution: 'stale_replay', degraded: true, data: [{ id: 'stale' }] })
    expect(state.getTDXToken).not.toHaveBeenCalled()
    expect(state.fetchUpstream).not.toHaveBeenCalled()
    expect(match).toHaveBeenCalledTimes(2)
    expect(events[0]).toMatchObject({ result: 'degraded', failureClass: 'quota', dataAgeBucket: '5_30m' })
  })

  it('never applies the shared quota marker to BYOK requests', async () => {
    const match = vi.fn(async (request: Request) => (
      request.url === sharedQuotaCooldownUrl ? new Response('1') : undefined
    ))
    stubCache(match)
    const state = setup()

    await expect(state.resolver.fetchTDXJson(personalEnvironment('token-a'), url, 30, { validate }))
      .resolves.toEqual([{ id: 'fresh' }])

    expect(match).toHaveBeenCalledOnce()
    expect(match.mock.calls[0][0].url).not.toBe(sharedQuotaCooldownUrl)
    expect(state.getTDXToken).toHaveBeenCalledOnce()
    expect(state.fetchUpstream).toHaveBeenCalledOnce()
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
