import { cacheMatchFailOpen, cachePutFailOpen, type BackgroundTaskScheduler } from '../edge-cache'

export type SharedTokenEntry = { value: string; expiresAt: number }

export type SharedTokenStore = {
  read: (credentialKey: string) => Promise<SharedTokenEntry | undefined>
  // 有 schedule（Worker 的 waitUntil）就交給背景寫入，不讓慢的 cache.put 拖住這次請求。
  write: (credentialKey: string, entry: SharedTokenEntry, schedule?: BackgroundTaskScheduler) => Promise<void>
}

// 共用憑證的 token 只放在 isolate 記憶體時，每個新 isolate 都要重新向 TDX 換一次 token；
// TDX 的 token 端點限流比資料 API 嚴，線上曾因此整站卡在 token 429。
// 這裡把 token 放進同機房的 Cache API，讓同機房所有 isolate 共用同一張 token。
// 鍵只含憑證指紋（SHA-256），不含 Client ID/Secret；.invalid 主機名稱確保外部請求無法命中。
// 讀寫失敗一律 fail-open：退回原本「自己換 token」的行為，不讓快取層變成新的故障點。
const SHARED_TOKEN_URL_PREFIX = 'https://mochi-cache.invalid/tdx/token/'
// 至少要剩這麼久才值得共用，避免把快過期的 token 發給別的 isolate。
const MIN_SHARED_TTL_MS = 30 * 1000

export function createEdgeSharedTokenStore(
  resolveCache: () => Cache | undefined = defaultEdgeCache,
  now: () => number = () => Date.now(),
): SharedTokenStore {
  return {
    read: async (credentialKey) => {
      const cache = resolveCache()
      if (!cache) return undefined
      const response = await cacheMatchFailOpen(cache, tokenKey(credentialKey), 'tdx_shared_token')
      if (!response) return undefined
      try {
        const entry = parseEntry(await response.json())
        if (!entry || entry.expiresAt - now() < MIN_SHARED_TTL_MS) return undefined
        return entry
      } catch {
        return undefined
      }
    },
    write: async (credentialKey, entry, schedule) => {
      const cache = resolveCache()
      if (!cache) return
      const ttlSeconds = Math.floor((entry.expiresAt - now()) / 1000)
      if (ttlSeconds * 1000 < MIN_SHARED_TTL_MS) return
      await cachePutFailOpen(cache, tokenKey(credentialKey), new Response(JSON.stringify(entry), {
        headers: {
          'Content-Type': 'application/json',
          // Cloudflare Cache API 不存 private；.invalid 鍵本來就無法被外部請求命中。
          'Cache-Control': `public, max-age=${ttlSeconds}`,
        },
      }), 'tdx_shared_token', schedule)
    },
  }
}

function tokenKey(credentialKey: string): Request {
  return new Request(`${SHARED_TOKEN_URL_PREFIX}${credentialKey}`)
}

function parseEntry(value: unknown): SharedTokenEntry | undefined {
  if (!value || typeof value !== 'object') return undefined
  const { value: token, expiresAt } = value as Record<string, unknown>
  if (typeof token !== 'string' || token.length === 0) return undefined
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return undefined
  return { value: token, expiresAt }
}

function defaultEdgeCache(): Cache | undefined {
  try {
    return typeof caches === 'undefined'
      ? undefined
      : (caches as CacheStorage & { default?: Cache }).default
  } catch {
    return undefined
  }
}
