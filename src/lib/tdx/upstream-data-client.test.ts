import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TDXServiceError,
  resetTDXRateLimitTracking,
} from './error-classification'
import {
  createTDXUpstreamDataClient,
  type TDXUpstreamDataClientDependencies,
  type TDXUpstreamRequest,
} from './upstream-data-client'

const availabilityKey = 'data/credential-key/vehicle_positions/City/Taipei'
const rateLimitKey = 'data-limit/credential-key'

function request(overrides: Partial<TDXUpstreamRequest> = {}): TDXUpstreamRequest {
  return {
    url: new URL('https://tdx.transportdata.tw/api/basic/v2/Bus/Route/City/Taipei'),
    maxResponseBytes: 1024,
    operation: 'vehicle_positions',
    token: 'private-token',
    isShared: false,
    credentialKey: 'credential-key',
    ttlSeconds: 30,
    validatesPayload: true,
    ...overrides,
  }
}

function serviceError(
  failureKind: TDXServiceError['failureKind'],
  status?: number,
): TDXServiceError {
  return new TDXServiceError('upstream failed', status, { failureKind })
}

function dependencies(overrides: Partial<TDXUpstreamDataClientDependencies> = {}) {
  const recordCircuitFailure = vi.fn()
  const recordCircuitSuccess = vi.fn()
  const assertCircuitsClosed = vi.fn()
  const responseError = vi.fn(async (_context: string, response: Response) => {
    if (response.status === 429) return serviceError('rate_limited', 429)
    return serviceError(response.status >= 500 ? 'upstream_5xx' : 'upstream_4xx', response.status)
  })
  return {
    value: {
      requestTimeoutMs: 6000,
      assertCircuitsClosed,
      recordCircuitFailure,
      recordCircuitSuccess,
      responseError,
      ...overrides,
    } satisfies TDXUpstreamDataClientDependencies,
    assertCircuitsClosed,
    recordCircuitFailure,
    recordCircuitSuccess,
    responseError,
  }
}

function parsedConsoleCalls(calls: readonly (readonly unknown[])[]): Array<Record<string, unknown>> {
  return calls.flatMap(([value]) => {
    if (typeof value !== 'string') return []
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? [parsed as Record<string, unknown>]
        : []
    } catch {
      return []
    }
  })
}

describe('TDX upstream data client', () => {
  beforeEach(() => {
    resetTDXRateLimitTracking()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    resetTDXRateLimitTracking()
  })

  it('coalesces identical requests, marks one leader, and clears the flight afterward', async () => {
    let release: (response: Response) => void = () => undefined
    const pending = new Promise<Response>((resolve) => { release = resolve })
    const fetcher = vi.fn(() => pending)
    const deps = dependencies({ fetcher })
    const client = createTDXUpstreamDataClient(deps.value)

    const first = client.fetchUpstream(request())
    const second = client.fetchUpstream(request())
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
    release(new Response('[]', { headers: { 'Content-Length': '2' } }))

    const results = await Promise.all([first, second])
    expect(results.map((result) => result.leader)).toEqual([true, false])
    expect(results.every((result) => result.outcome.ok)).toBe(true)
    expect(deps.assertCircuitsClosed).toHaveBeenCalledOnce()
    expect(deps.assertCircuitsClosed).toHaveBeenCalledWith([rateLimitKey, availabilityKey])

    await Promise.resolve()
    await client.fetchUpstream(request())
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(deps.assertCircuitsClosed).toHaveBeenCalledTimes(2)
  })

  it('keeps cache, operation, byte-limit, and validation policies out of the same flight', async () => {
    const releases: Array<(response: Response) => void> = []
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => releases.push(resolve)))
    const deps = dependencies({ fetcher })
    const client = createTDXUpstreamDataClient(deps.value)

    const pending = [
      client.fetchUpstream(request()),
      client.fetchUpstream(request({ ttlSeconds: 60 })),
      client.fetchUpstream(request({ operation: 'tdx_schedule' })),
      client.fetchUpstream(request({ maxResponseBytes: 2048 })),
      client.fetchUpstream(request({ validatesPayload: false })),
    ]
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(5))
    releases.splice(0).forEach((release) => release(new Response('[]')))

    await expect(Promise.all(pending)).resolves.toHaveLength(5)
    expect(deps.assertCircuitsClosed).toHaveBeenCalledTimes(5)
  })

  it('checks both credential cooldown and scoped availability circuits before creating a new flight', async () => {
    const blocked = serviceError('circuit_open', 503)
    const fetcher = vi.fn()
    const deps = dependencies({
      fetcher,
      assertCircuitsClosed: vi.fn(() => { throw blocked }),
    })
    const client = createTDXUpstreamDataClient(deps.value)

    await expect(client.fetchUpstream(request())).rejects.toBe(blocked)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('isolates availability identity by operation and service area', async () => {
    const deps = dependencies({ fetcher: vi.fn(async () => new Response('[]')) })
    const client = createTDXUpstreamDataClient(deps.value)

    const taipei = await client.fetchUpstream(request({
      operation: 'place_arrivals',
      url: new URL('https://tdx.transportdata.tw/api/basic/v2/Bus/EstimatedTimeOfArrival/City/Taipei'),
    }))
    const tainan = await client.fetchUpstream(request({
      operation: 'place_arrivals',
      url: new URL('https://tdx.transportdata.tw/api/basic/v2/Bus/EstimatedTimeOfArrival/City/Tainan'),
    }))
    const vehicles = await client.fetchUpstream(request({
      operation: 'vehicle_positions',
      url: new URL('https://tdx.transportdata.tw/api/basic/v2/Bus/Vehicle/City/Tainan/70'),
    }))

    expect(taipei.circuitKey).toBe('data/credential-key/place_arrivals/City/Taipei')
    expect(tainan.circuitKey).toBe('data/credential-key/place_arrivals/City/Tainan')
    expect(vehicles.circuitKey).toBe('data/credential-key/vehicle_positions/City/Tainan')
  })

  it('retries one timeout for an observed operation and reports recovery metadata', async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'))
      .mockResolvedValueOnce(new Response('[{"id":"ok"}]'))
    const deps = dependencies({ fetcher })
    const client = createTDXUpstreamDataClient(deps.value)

    const result = await client.fetchUpstream(request())
    expect(result.outcome).toMatchObject({
      ok: true,
      retryCount: 1,
      initialFailureClass: 'timeout',
      data: [{ id: 'ok' }],
    })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(deps.recordCircuitFailure).not.toHaveBeenCalled()
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      headers: { Authorization: 'Bearer private-token', Accept: 'application/json' },
    })
  })

  it('does not retry static transport failures or mutate realtime credential cooldown', async () => {
    const fetcher = vi.fn(async () => { throw new TypeError('offline') })
    const deps = dependencies({ fetcher })
    const client = createTDXUpstreamDataClient(deps.value)

    const result = await client.fetchUpstream(request({ operation: undefined }))
    expect(result.outcome).toMatchObject({
      ok: false,
      retryCount: 0,
      error: { failureKind: 'network_error' },
    })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(deps.recordCircuitSuccess).not.toHaveBeenCalledWith(rateLimitKey)
    expect(deps.recordCircuitFailure).toHaveBeenCalledWith(
      'data/credential-key/Route/City/Taipei',
      expect.any(TDXServiceError),
    )
  })

  it('retries one upstream 5xx and records only the final scoped failure', async () => {
    const fetcher = vi.fn(async () => new Response('unavailable', {
      status: 503,
      headers: { 'Retry-After': '7' },
    }))
    const deps = dependencies({ fetcher })
    const client = createTDXUpstreamDataClient(deps.value)

    const result = await client.fetchUpstream(request())
    expect(result.outcome).toMatchObject({
      ok: false,
      retryCount: 1,
      initialFailureClass: 'upstream_5xx',
      error: { failureKind: 'upstream_5xx', status: 503 },
    })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(deps.responseError).toHaveBeenCalledTimes(2)
    expect(deps.recordCircuitFailure).toHaveBeenCalledTimes(1)
    expect(deps.recordCircuitFailure).toHaveBeenCalledWith(
      availabilityKey,
      expect.objectContaining({ status: 503 }),
      '7',
    )
  })

  it('keeps rate-limit cooldown global to the credential', async () => {
    const fetcher = vi.fn(async () => new Response('rate limited', {
      status: 429,
      headers: { 'Retry-After': '9' },
    }))
    const deps = dependencies({ fetcher })
    const client = createTDXUpstreamDataClient(deps.value)

    const result = await client.fetchUpstream(request())
    expect(result.outcome).toMatchObject({
      ok: false,
      retryCount: 0,
      error: { failureKind: 'rate_limited', status: 429 },
    })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(deps.recordCircuitSuccess).toHaveBeenCalledWith(availabilityKey)
    expect(deps.recordCircuitFailure).toHaveBeenCalledWith(
      rateLimitKey,
      expect.objectContaining({ status: 429 }),
      '9',
    )
  })

  it('allows static metadata reads while realtime credential cooldown is active', async () => {
    const fetcher = vi.fn(async () => new Response('[]'))
    const deps = dependencies({ fetcher })
    const client = createTDXUpstreamDataClient(deps.value)

    await client.fetchUpstream(request({
      operation: undefined,
      url: new URL('https://tdx.transportdata.tw/api/basic/v2/Bus/StopOfRoute/City/Taipei/307'),
    }))

    expect(deps.assertCircuitsClosed).toHaveBeenCalledWith([
      'data/credential-key/StopOfRoute/City/Taipei',
    ])
    expect(deps.recordCircuitSuccess).not.toHaveBeenCalledWith(rateLimitKey)
  })

  it('returns parsed byte metadata and a sanitized Bus resource', async () => {
    const body = '[{"id":"one"}]'
    const bytes = new TextEncoder().encode(body).byteLength
    const fetcher = vi.fn(async () => new Response(body, {
      headers: { 'Content-Length': String(bytes) },
    }))
    const deps = dependencies({ fetcher })
    const client = createTDXUpstreamDataClient(deps.value)

    const result = await client.fetchUpstream(request({
      url: new URL('https://tdx.transportdata.tw/api/basic/v2/Bus/Shape/City/Taipei/307?private=query'),
      isShared: true,
    }))
    expect(result).toMatchObject({
      leader: true,
      circuitKey: availabilityKey,
      resource: 'Shape',
      outcome: {
        ok: true,
        status: 200,
        receivedBytes: bytes,
        declaredBytes: bytes,
        retryCount: 0,
      },
    })
    expect(JSON.stringify(result)).not.toContain('private=query')
  })

  it('wraps invalid JSON and records a scoped availability failure', async () => {
    const fetcher = vi.fn(async () => new Response('{'))
    const deps = dependencies({ fetcher })
    const client = createTDXUpstreamDataClient(deps.value)

    const result = await client.fetchUpstream(request())
    expect(result.outcome).toMatchObject({
      ok: false,
      error: { failureKind: 'invalid_json', status: 502 },
    })
    expect(deps.recordCircuitSuccess).toHaveBeenCalledWith(rateLimitKey)
    expect(deps.recordCircuitFailure).toHaveBeenCalledWith(
      availabilityKey,
      expect.objectContaining({ failureKind: 'invalid_json' }),
    )
  })

  it('treats payload-size rejection as an available upstream and logs no identity', async () => {
    let cancelCount = 0
    const fetcher = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      cancel() { cancelCount += 1 },
    }), {
      headers: { 'Content-Length': '4096' },
    }))
    const deps = dependencies({ fetcher })
    const client = createTDXUpstreamDataClient(deps.value)

    const result = await client.fetchUpstream(request({
      url: new URL('https://tdx.transportdata.tw/api/basic/v2/Bus/Route/City/Taipei?private=query'),
      maxResponseBytes: 128,
    }))
    expect(result.outcome).toMatchObject({
      ok: false,
      error: {
        failureKind: 'invalid_schema',
        maxBytes: 128,
        sizeSource: 'content_length',
        declaredBytes: 4096,
      },
    })
    expect(cancelCount).toBe(1)
    expect(deps.recordCircuitSuccess).toHaveBeenCalledWith(rateLimitKey)
    expect(deps.recordCircuitSuccess).toHaveBeenCalledWith(availabilityKey)
    expect(deps.recordCircuitFailure).not.toHaveBeenCalled()

    const logged = parsedConsoleCalls(vi.mocked(console.error).mock.calls)
      .find((entry) => entry.message === 'tdx_response_too_large')
    expect(logged).toMatchObject({
      resource: 'Route',
      credentialScope: 'byok',
      maxBytes: 128,
      declaredBytes: 4096,
    })
    expect(JSON.stringify(logged)).not.toMatch(/private=query|private-token|credential-key/)
  })

  it('resolves global fetch at request time', async () => {
    const deps = dependencies()
    const client = createTDXUpstreamDataClient(deps.value)
    const fetchMock = vi.fn(async () => new Response('[]'))
    vi.stubGlobal('fetch', fetchMock)

    await expect(client.fetchUpstream(request())).resolves.toMatchObject({
      outcome: { ok: true, data: [] },
    })
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})
