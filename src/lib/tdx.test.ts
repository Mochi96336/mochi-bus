import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedBusQuery } from '../domain/bus-query'
import { fetchTDXJson, formatETALabel, formatStopStatus, getCommuteETA, getRouteStopGroups, getTDXToken, isRejectedUserTdxToken, mergeEquivalentStopGroups, resetTDXTestState, tdxCredentialScope, TDXServiceError, withUserTDXAccessToken, type StopGroup, type TDXEnv } from './tdx'

describe('TDX presentation', () => {
  it('formats immediate arrivals', () => {
    expect(formatETALabel(1, 0)).toBe('即將進站')
  })

  it('formats ordinary ETAs', () => {
    expect(formatETALabel(7, 0)).toBe('7 分')
  })

  it('falls back to the TDX stop status', () => {
    expect(formatETALabel(null, 1)).toBe('尚未發車')
    expect(formatStopStatus(4)).toBe('今日未營運')
  })
})

describe('withUserTDXAccessToken', () => {
  const env: TDXEnv = { TDX_CLIENT_ID: 'shared-id', TDX_CLIENT_SECRET: 'shared-secret' }

  it('attaches a short-lived user token without touching the shared credentials', () => {
    const result = withUserTDXAccessToken(env, 'user-token')
    expect(result.TDX_USER_ACCESS_TOKEN).toBe('user-token')
    expect(result.TDX_CLIENT_ID).toBe('shared-id')
    expect(env).not.toHaveProperty('TDX_USER_ACCESS_TOKEN')
  })

  it('keeps the shared environment when no user token is present', () => {
    expect(withUserTDXAccessToken(env)).toBe(env)
    expect(withUserTDXAccessToken(env, null)).toBe(env)
  })

  it('isolates user cooldown and circuit scopes without retaining the raw token', async () => {
    const first = await tdxCredentialScope({ ...env, TDX_USER_ACCESS_TOKEN: 'token-a' })
    const second = await tdxCredentialScope({ ...env, TDX_USER_ACCESS_TOKEN: 'token-b' })

    expect(first).not.toBe(second)
    expect(first).not.toContain('token-a')
    expect(second).not.toContain('token-b')
  })
})

describe('user TDX token rejection', () => {
  it('exposes a refresh signal only for an upstream 401 on a personal token request', () => {
    expect(isRejectedUserTdxToken(new TDXServiceError('rejected', 401), 'Bearer personal-token')).toBe(true)
    expect(isRejectedUserTdxToken(new TDXServiceError('shared rejected', 401))).toBe(false)
    expect(isRejectedUserTdxToken(new TDXServiceError('forbidden', 403), 'Bearer personal-token')).toBe(false)
    expect(isRejectedUserTdxToken(new Error('unrelated'), 'Bearer personal-token')).toBe(false)
  })
})

describe('TDX credential cache resilience', () => {
  beforeEach(() => resetTDXTestState())

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
    resetTDXTestState()
  })

  const tokenResponse = (token: string) => new Response(JSON.stringify({
    access_token: token,
    expires_in: 3600,
  }), { headers: { 'Content-Type': 'application/json' } })

  it('isolates tokens when the same client ID is used with a different secret', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = init?.body as URLSearchParams
      return tokenResponse(`token-${body.get('client_secret')}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const first = await getTDXToken({ TDX_CLIENT_ID: 'same-id', TDX_CLIENT_SECRET: 'secret-a' })
    const second = await getTDXToken({ TDX_CLIENT_ID: 'same-id', TDX_CLIENT_SECRET: 'secret-b' })

    expect(first.token).toBe('token-secret-a')
    expect(second.token).toBe('token-secret-b')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('reuses a token that completed while a concurrent request was fingerprinting credentials', async () => {
    const fetchMock = vi.fn(async () => tokenResponse('one-token'))
    vi.stubGlobal('fetch', fetchMock)
    const env: TDXEnv = { TDX_CLIENT_ID: 'concurrent-id', TDX_CLIENT_SECRET: 'concurrent-secret' }

    const [first, second] = await Promise.all([getTDXToken(env), getTDXToken(env)])

    expect(first.token).toBe('one-token')
    expect(second.token).toBe('one-token')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps the token cache at a hard LRU cap', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = init?.body as URLSearchParams
      return tokenResponse(`token-${body.get('client_id')}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    for (let index = 0; index <= 128; index += 1) {
      await getTDXToken({ TDX_CLIENT_ID: `lru-id-${index}`, TDX_CLIENT_SECRET: `lru-secret-${index}` })
    }
    expect(fetchMock).toHaveBeenCalledTimes(129)

    await getTDXToken({ TDX_CLIENT_ID: 'lru-id-128', TDX_CLIENT_SECRET: 'lru-secret-128' })
    expect(fetchMock).toHaveBeenCalledTimes(129)

    await getTDXToken({ TDX_CLIENT_ID: 'lru-id-0', TDX_CLIENT_SECRET: 'lru-secret-0' })
    expect(fetchMock).toHaveBeenCalledTimes(130)
  })

  it('does not retain in-flight data promises across Worker requests', async () => {
    const cacheMatch = vi.fn(async () => undefined)
    const cachePut = vi.fn(async () => undefined)
    vi.stubGlobal('caches', { default: { match: cacheMatch, put: cachePut } })

    let dataRequests = 0
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/openid-connect/token')) return tokenResponse('data-token')
      dataRequests += 1
      return new Response(JSON.stringify([{ id: 'result' }]), {
        headers: { 'Content-Type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const env: TDXEnv = { TDX_CLIENT_ID: 'data-id', TDX_CLIENT_SECRET: 'data-secret' }
    const url = new URL('https://tdx.transportdata.tw/api/basic/v2/test?case=single-flight')

    const [first, second] = await Promise.all([
      fetchTDXJson<Array<{ id: string }>>(env, url, 30),
      fetchTDXJson<Array<{ id: string }>>(env, url, 30),
    ])

    expect(first).toEqual([{ id: 'result' }])
    expect(second).toEqual(first)
    expect(dataRequests).toBe(2)
    expect(cachePut).toHaveBeenCalledTimes(2)
  })

  it('returns TDX data before a scheduled edge-cache write finishes', async () => {
    let finishWrite!: () => void
    const pendingWrite = new Promise<void>((resolve) => { finishWrite = resolve })
    const cachePut = vi.fn(() => pendingWrite)
    vi.stubGlobal('caches', {
      default: {
        match: vi.fn(async () => undefined),
        put: cachePut,
      },
    })

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/openid-connect/token')) return tokenResponse('background-token')
      return new Response(JSON.stringify([{ id: 'fast-result' }]), {
        headers: { 'Content-Type': 'application/json' },
      })
    }))

    let scheduled: Promise<unknown> | undefined
    const env: TDXEnv = {
      TDX_CLIENT_ID: 'background-id',
      TDX_CLIENT_SECRET: 'background-secret',
      TDX_BACKGROUND_TASKS: (task) => { scheduled = task },
    }

    await expect(fetchTDXJson<Array<{ id: string }>>(
      env,
      new URL('https://tdx.transportdata.tw/api/basic/v2/test?case=background-cache'),
      30,
    )).resolves.toEqual([{ id: 'fast-result' }])

    expect(cachePut).toHaveBeenCalledTimes(1)
    expect(scheduled).toBeDefined()
    finishWrite()
    await scheduled
  })

  it('does not share an in-flight data failure across different secrets', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.stubGlobal('caches', {
      default: {
        match: vi.fn(async () => undefined),
        put: vi.fn(async () => undefined),
      },
    })

    let dataRequests = 0
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/openid-connect/token')) {
        const body = init?.body as URLSearchParams
        return tokenResponse(`token-${body.get('client_secret')}`)
      }

      dataRequests += 1
      const authorization = new Headers(init?.headers).get('Authorization')
      if (authorization === 'Bearer token-secret-a') return new Response('rate limited', { status: 429 })
      return new Response(JSON.stringify([{ id: 'secret-b-result' }]), {
        headers: { 'Content-Type': 'application/json' },
      })
    }))

    const url = new URL('https://tdx.transportdata.tw/api/basic/v2/test?case=credential-isolation')
    const results = await Promise.allSettled([
      fetchTDXJson({ TDX_CLIENT_ID: 'same-id', TDX_CLIENT_SECRET: 'secret-a' }, url, 30),
      fetchTDXJson({ TDX_CLIENT_ID: 'same-id', TDX_CLIENT_SECRET: 'secret-b' }, url, 30),
    ])

    expect(results[0].status).toBe('rejected')
    expect(results[1]).toEqual({ status: 'fulfilled', value: [{ id: 'secret-b-result' }] })
    expect(dataRequests).toBe(2)
  })

  it('applies the six-second timeout signal to token requests and wraps aborts', async () => {
    const timeoutSignal = new AbortController().signal
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutSignal)
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new DOMException('timed out', 'TimeoutError')
    }))

    await expect(getTDXToken({ TDX_CLIENT_ID: 'timeout-id', TDX_CLIENT_SECRET: 'timeout-secret' }))
      .rejects.toBeInstanceOf(TDXServiceError)
    expect(timeoutSpy).toHaveBeenCalledWith(6000)
  })

  it('opens the circuit after three transient failures', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const fetchMock = vi.fn(async () => { throw new TypeError('network unavailable') })
    vi.stubGlobal('fetch', fetchMock)

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(getTDXToken({ TDX_CLIENT_ID: 'circuit-id', TDX_CLIENT_SECRET: 'circuit-secret' }))
        .rejects.toBeInstanceOf(TDXServiceError)
    }
    await expect(getTDXToken({ TDX_CLIENT_ID: 'circuit-id', TDX_CLIENT_SECRET: 'circuit-secret' })).rejects.toMatchObject({
      warning: 'tdx-unavailable',
      status: 503,
    })
    expect(fetchMock).toHaveBeenCalledTimes(6)
  })

  it('keeps data failures separate from a healthy token endpoint', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.stubGlobal('caches', {
      default: {
        match: vi.fn(async () => undefined),
        put: vi.fn(async () => undefined),
      },
    })
    let dataRequests = 0
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/openid-connect/token')) return tokenResponse('healthy-token')
      dataRequests += 1
      throw new TypeError('TDX data unavailable')
    }))
    const env: TDXEnv = { TDX_CLIENT_ID: 'data-circuit-id', TDX_CLIENT_SECRET: 'data-circuit-secret' }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const url = new URL(`https://tdx.transportdata.tw/api/basic/v2/test?failure=${attempt}`)
      await expect(fetchTDXJson(env, url, 30)).rejects.toBeInstanceOf(TDXServiceError)
    }
    await expect(fetchTDXJson(
      env,
      new URL('https://tdx.transportdata.tw/api/basic/v2/test?failure=blocked'),
      30,
    )).rejects.toMatchObject({ warning: 'tdx-unavailable', status: 503 })
    expect(dataRequests).toBe(3)
  })

  it('opens immediately on 429 and honors Retry-After before a half-open probe', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-10T08:00:00Z'))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('rate limited', {
        status: 429,
        headers: { 'Retry-After': '10' },
      }))
      .mockResolvedValueOnce(tokenResponse('recovered-token'))
    vi.stubGlobal('fetch', fetchMock)

    const env: TDXEnv = { TDX_CLIENT_ID: 'retry-id', TDX_CLIENT_SECRET: 'retry-secret' }
    await expect(getTDXToken(env)).rejects.toBeInstanceOf(TDXServiceError)
    await expect(getTDXToken(env)).rejects.toMatchObject({
      warning: 'tdx-rate-limit',
      status: 429,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(10_000)
    await expect(getTDXToken(env)).resolves.toMatchObject({ token: 'recovered-token', isShared: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('TDX upstream failures', () => {
  const env: TDXEnv = { TDX_CLIENT_ID: 'shared-id', TDX_CLIENT_SECRET: 'shared-secret' }
  const query = {
    city: 'Taipei',
    routeName: '307',
    routeUid: 'TPE19108',
    stopName: '捷運西門站',
    stopUid: 'TPE213044',
    direction: 0,
  } satisfies ResolvedBusQuery

  const stubRateLimitedTDX = () => {
    vi.stubGlobal('caches', {
      default: {
        match: vi.fn(async () => undefined),
        put: vi.fn(async () => undefined),
      },
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429 })))
  }

  beforeEach(() => resetTDXTestState())

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    resetTDXTestState()
  })

  it('marks ETA results when the shared TDX pool is rate limited', async () => {
    stubRateLimitedTDX()

    const result = await getCommuteETA(env, query)

    expect(result.warning).toBe('tdx-rate-limit')
    expect(result.label).toBe('暫無預估時間')
  })

  it('escalates to a quota warning when 429 persists past the threshold', async () => {
    stubRateLimitedTDX()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-08T08:00:00+08:00'))

    const first = await getCommuteETA(env, query)
    expect(first.warning).toBe('tdx-rate-limit')

    // 頻率超限幾秒就恢復;429 一路持續超過門檻,就該改判成「共用額度可能已用完」。
    vi.setSystemTime(new Date('2026-07-08T08:15:00+08:00'))
    const second = await getCommuteETA(env, query)
    expect(second.warning).toBe('tdx-quota')
  })

  it('does not let a personal access token contaminate the shared quota tracker', async () => {
    stubRateLimitedTDX()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-08T08:00:00+08:00'))

    await expect(fetchTDXJson(
      { ...env, TDX_USER_ACCESS_TOKEN: 'personal-access-token' },
      new URL('https://tdx.transportdata.tw/api/basic/v2/test?personal=1'),
      30,
    )).rejects.toThrow()
    vi.setSystemTime(new Date('2026-07-08T08:15:00+08:00'))

    const result = await getCommuteETA(env, query)
    expect(result.warning).toBe('tdx-rate-limit')
  })

  it('never writes upstream bodies, credentials, or authorization values to logs', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.stubGlobal('caches', {
      default: {
        match: vi.fn(async () => undefined),
        put: vi.fn(async () => undefined),
      },
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      'sentinel-secret Authorization: Bearer sentinel-token',
      { status: 401 },
    )))

    await expect(getTDXToken({
      TDX_CLIENT_ID: 'sentinel-id',
      TDX_CLIENT_SECRET: 'sentinel-secret',
    })).rejects.toThrow()

    const output = JSON.stringify(log.mock.calls)
    expect(output).not.toMatch(/sentinel-secret|sentinel-token|Authorization/)
  })

  it('recognizes quota responses even when TDX does not use HTTP 429', async () => {
    vi.stubGlobal('caches', {
      default: {
        match: vi.fn(async () => undefined),
        put: vi.fn(async () => undefined),
      },
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('monthly quota exceeded', { status: 403 })))

    const result = await getCommuteETA(env, query)

    expect(result.warning).toBe('tdx-quota')
  })

  it('recognizes quota suspension when TDX rejects the token request outright', async () => {
    vi.stubGlobal('caches', {
      default: {
        match: vi.fn(async () => undefined),
        put: vi.fn(async () => undefined),
      },
    })
    // 額度用完時 TDX 觀察到的實際行為:整個 App 停權,連 token 都換不到,
    // 回標準 OAuth 錯誤(400 unauthorized_client),不是查詢 API 才擋 429。
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'unauthorized_client', error_description: 'Invalid client credentials' }),
      { status: 400 },
    )))

    const result = await getCommuteETA(env, query)

    expect(result.warning).toBe('tdx-quota')
  })
})

describe('route variants', () => {
  const group = (name: string, stops: string[], subRouteUid = name): StopGroup => ({
    direction: 0,
    label: `${stops[0]} → ${stops.at(-1)}`,
    routeUid: 'R1',
    subRouteUid,
    subRouteName: name,
    stops: stops.map((stopName, index) => ({
      routeUid: 'R1',
      subRouteUid,
      subRouteName: name,
      stopUid: `${name}-${index}`,
      stopName,
      direction: 0,
      sequence: index + 1,
    })),
  })

  it('merges duplicate rows with the same identity and complete stop sequence', () => {
    const merged = mergeEquivalentStopGroups([
      group('A支線', ['起點', '中間', '終點'], 'SUB-1'),
      group('A區間', ['起點', '中間', '終點'], 'SUB-1'),
    ])

    expect(merged).toHaveLength(1)
    expect(merged[0].subRouteName).toBe('A支線／A區間')
  })

  it('keeps different SubRouteUIDs even when their stop sequences match', () => {
    const merged = mergeEquivalentStopGroups([
      group('A支線', ['起點', '中間', '終點'], 'SUB-A'),
      group('B支線', ['起點', '中間', '終點'], 'SUB-B'),
    ])

    expect(merged).toHaveLength(2)
  })

  it('keeps variants that take different paths', () => {
    const merged = mergeEquivalentStopGroups([
      group('A支線', ['起點', '中山路', '終點']),
      group('B支線', ['起點', '西藏路', '終點']),
    ])

    expect(merged).toHaveLength(2)
  })
})


describe('TDX circular route directions', () => {
  beforeEach(() => resetTDXTestState())

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    resetTDXTestState()
  })

  it('keeps Direction 2 stop groups instead of dropping circular routes', async () => {
    vi.stubGlobal('caches', {
      default: {
        match: vi.fn(async () => undefined),
        put: vi.fn(async () => undefined),
      },
    })
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/openid-connect/token')) {
        return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify([{
        RouteUID: 'TNN0LEFT',
        RouteName: { Zh_tw: '0左' },
        SubRouteUID: 'TNN0LEFT',
        SubRouteName: { Zh_tw: '0左' },
        Direction: 2,
        Stops: [
          {
            StopUID: 'TNN0001', StopName: { Zh_tw: '臺南火車站' }, StopSequence: 1,
            StopPosition: { PositionLat: 22.997, PositionLon: 120.213 },
          },
          {
            StopUID: 'TNN0002', StopName: { Zh_tw: '成功路' }, StopSequence: 2,
            StopPosition: { PositionLat: 23.001, PositionLon: 120.208 },
          },
          {
            StopUID: 'TNN0003', StopName: { Zh_tw: '臺南火車站' }, StopSequence: 3,
            StopPosition: { PositionLat: 22.997, PositionLon: 120.213 },
          },
        ],
      }]), { headers: { 'Content-Type': 'application/json' } })
    }))

    const groups = await getRouteStopGroups({
      TDX_CLIENT_ID: 'id', TDX_CLIENT_SECRET: 'secret',
    }, 'Tainan', '0左')

    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({
      direction: 2,
      routeUid: 'TNN0LEFT',
      subRouteUid: 'TNN0LEFT',
      label: '臺南火車站 → 臺南火車站',
    })
    expect(groups[0].stops.every((stop) => stop.direction === 2)).toBe(true)
  })
})
