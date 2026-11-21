import { afterEach, describe, expect, it, vi } from 'vitest'
import { TDXServiceError } from './error-classification'
import { createEdgeSharedTokenStore, type SharedTokenEntry, type SharedTokenStore } from './shared-token-store'
import { createTDXTokenClient, type TDXTokenClientDependencies } from './token-client'

const env = { TDX_CLIENT_ID: 'shared-id', TDX_CLIENT_SECRET: 'shared-secret' }

const tokenResponse = (token: string, expiresIn = 86400): Response => new Response(JSON.stringify({
  access_token: token,
  expires_in: expiresIn,
}), { headers: { 'Content-Type': 'application/json' } })

function memoryStore(): SharedTokenStore & { entries: Map<string, SharedTokenEntry> } {
  const entries = new Map<string, SharedTokenEntry>()
  return {
    entries,
    read: vi.fn(async (key: string) => entries.get(key)),
    write: vi.fn(async (key: string, entry: SharedTokenEntry) => { entries.set(key, entry) }),
  }
}

// 每次呼叫都是一個全新的 token client，等同 Cloudflare 開出的新 isolate。
function isolate(options: {
  store: SharedTokenStore
  fetcher?: ReturnType<typeof vi.fn>
  now?: () => number
  assertCircuitClosed?: (key: string) => void
}) {
  const fetcher = options.fetcher ?? vi.fn(async () => tokenResponse('fresh-token'))
  const dependencies: TDXTokenClientDependencies = {
    requestTimeoutMs: 6000,
    assertCircuitClosed: options.assertCircuitClosed ?? vi.fn(),
    recordCircuitFailure: vi.fn(),
    recordCircuitSuccess: vi.fn(),
    responseError: vi.fn(async (_context: string, response: Response) => (
      new TDXServiceError(`token failed (${response.status})`, response.status)
    )),
    readJsonResponse: async (response: Response) => {
      const text = await response.text()
      return { data: JSON.parse(text), receivedBytes: text.length }
    },
    isPayloadTooLargeError: (_error): _error is TDXServiceError => false,
    logResponseTooLarge: vi.fn(),
    logResponseSize: vi.fn(),
    logRequestFailure: vi.fn(),
    fetcher: fetcher as typeof fetch,
    now: options.now,
    sleep: async () => undefined,
    sharedTokenStore: options.store,
  }
  return { client: createTDXTokenClient(dependencies), fetcher }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('shared TDX token cache across isolates', () => {
  it('lets a new isolate reuse the token another isolate already obtained', async () => {
    const store = memoryStore()
    const first = isolate({ store })
    const second = isolate({ store })

    await expect(first.client.getTDXToken(env)).resolves.toMatchObject({ token: 'fresh-token', isShared: true })
    await expect(second.client.getTDXToken(env)).resolves.toMatchObject({ token: 'fresh-token', isShared: true })

    expect(first.fetcher).toHaveBeenCalledTimes(1)
    expect(second.fetcher).not.toHaveBeenCalled()
  })

  it('keeps the credential out of the shared cache key', async () => {
    const store = memoryStore()
    await isolate({ store }).client.getTDXToken(env)

    const [key] = [...store.entries.keys()]
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(key).not.toContain('shared-id')
    expect(key).not.toContain('shared-secret')
  })

  it('uses a shared token even while this isolate has the token circuit open', async () => {
    const store = memoryStore()
    await isolate({ store }).client.getTDXToken(env)
    const openCircuit = vi.fn(() => { throw new TDXServiceError('TDX circuit breaker is open', 429) })

    const next = isolate({ store, assertCircuitClosed: openCircuit })
    await expect(next.client.getTDXToken(env)).resolves.toMatchObject({ token: 'fresh-token' })
    expect(openCircuit).not.toHaveBeenCalled()
    expect(next.fetcher).not.toHaveBeenCalled()
  })

  it('ignores an expired shared token and refreshes it', async () => {
    let clock = 1_000_000
    const store = memoryStore()
    await isolate({ store, now: () => clock }).client.getTDXToken(env)
    clock += 2 * 86400 * 1000

    const fetcher = vi.fn(async () => tokenResponse('renewed-token'))
    const next = isolate({ store, fetcher, now: () => clock })
    await expect(next.client.getTDXToken(env)).resolves.toMatchObject({ token: 'renewed-token' })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect([...store.entries.values()][0]?.value).toBe('renewed-token')
  })

  it('fails open when the shared cache throws', async () => {
    const store: SharedTokenStore = {
      read: vi.fn(async () => { throw new Error('cache down') }),
      write: vi.fn(async () => { throw new Error('cache down') }),
    }
    const { client, fetcher } = isolate({ store })

    await expect(client.getTDXToken(env)).resolves.toMatchObject({ token: 'fresh-token' })
    await expect(client.getTDXToken(env)).resolves.toMatchObject({ token: 'fresh-token' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('never reads or writes BYOK tokens through the shared cache', async () => {
    const store = memoryStore()
    const { client, fetcher } = isolate({ store })

    await client.getTDXToken({ ...env, TDX_USER_ACCESS_TOKEN: 'personal-token' })
    expect(store.read).not.toHaveBeenCalled()
    expect(store.write).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('joins concurrent misses into a single token request', async () => {
    const store = memoryStore()
    const { client, fetcher } = isolate({ store })

    await Promise.all([client.getTDXToken(env), client.getTDXToken(env), client.getTDXToken(env)])
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(store.read).toHaveBeenCalledTimes(1)
  })
})

describe('edge (Cache API) shared token store', () => {
  const fakeCache = () => {
    const entries = new Map<string, Response>()
    const cache = {
      match: vi.fn(async (key: Request) => entries.get(key.url)?.clone()),
      put: vi.fn(async (key: Request, response: Response) => { entries.set(key.url, response) }),
    }
    return { cache: cache as unknown as Cache, raw: cache, entries }
  }

  it('round-trips an entry under a non-routable key with a public TTL', async () => {
    const { cache, raw, entries } = fakeCache()
    const now = 1_000_000
    const store = createEdgeSharedTokenStore(() => cache, () => now)

    await store.write('abc', { value: 'tok', expiresAt: now + 3600 * 1000 })
    const [key] = [...entries.keys()]
    expect(key).toBe('https://mochi-cache.invalid/tdx/token/abc')
    const stored = raw.put.mock.calls[0]?.[1] as Response
    expect(stored.headers.get('Cache-Control')).toBe('public, max-age=3600')

    await expect(store.read('abc')).resolves.toEqual({ value: 'tok', expiresAt: now + 3600 * 1000 })
  })

  it('does not share tokens that are about to expire', async () => {
    const { cache, raw } = fakeCache()
    const now = 1_000_000
    const store = createEdgeSharedTokenStore(() => cache, () => now)

    await store.write('abc', { value: 'tok', expiresAt: now + 10 * 1000 })
    expect(raw.put).not.toHaveBeenCalled()
  })

  it('treats malformed cached bodies as a miss', async () => {
    const { cache, entries } = fakeCache()
    entries.set('https://mochi-cache.invalid/tdx/token/abc', new Response('{"value":42}'))
    const store = createEdgeSharedTokenStore(() => cache)

    await expect(store.read('abc')).resolves.toBeUndefined()
  })

  it('hands the write to the background scheduler when one is given', async () => {
    const { cache, raw } = fakeCache()
    const now = 1_000_000
    const scheduled: Array<Promise<unknown>> = []
    const store = createEdgeSharedTokenStore(() => cache, () => now)

    await store.write('abc', { value: 'tok', expiresAt: now + 3600 * 1000 }, (task) => { scheduled.push(task) })
    expect(scheduled).toHaveLength(1)
    await Promise.all(scheduled)
    expect(raw.put).toHaveBeenCalledTimes(1)
  })

  it('is a no-op where the Cache API is unavailable', async () => {
    const store = createEdgeSharedTokenStore(() => undefined)
    await expect(store.write('abc', { value: 'tok', expiresAt: Date.now() + 3600 * 1000 })).resolves.toBeUndefined()
    await expect(store.read('abc')).resolves.toBeUndefined()
  })
})
