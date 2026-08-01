import type { MiddlewareHandler } from 'hono'
import { instanceId } from './instance-runtime'

type RateLimitBindingName =
  | 'API_STANDARD_RATE_LIMITER'
  | 'API_EXPENSIVE_RATE_LIMITER'

export type RateLimitBindings = Pick<CloudflareBindings, RateLimitBindingName>
type Env = { Bindings: RateLimitBindings }

export type ApiRateLimitPolicy = {
  binding: RateLimitBindingName
  scope: 'standard' | 'expensive'
}

const NO_LIMIT_PATHS = new Set([
  '/api/v1/health/release',
  '/api/v1/map/cities',
  '/api/v1/map/locate',
])

const EXPENSIVE_PATHS = new Set([
  '/api/v1/map/network',
  '/api/v1/map/direct',
  '/api/v1/map/transfer',
  '/api/v1/map/journey-eta',
])

export function apiRateLimitPolicy(method: string, pathname: string): ApiRateLimitPolicy | undefined {
  if (!pathname.startsWith('/api/')) return undefined
  if (NO_LIMIT_PATHS.has(pathname)) return undefined
  if (
    EXPENSIVE_PATHS.has(pathname)
    || /^\/api\/v1\/map\/place\/[^/]+\/arrivals$/.test(pathname)
    || (method === 'POST' && pathname === '/api/v1/map/journey-eta')
  ) {
    return { binding: 'API_EXPENSIVE_RATE_LIMITER', scope: 'expensive' }
  }
  return { binding: 'API_STANDARD_RATE_LIMITER', scope: 'standard' }
}

function actorKey(request: Request): string {
  // 公開、免登入服務沒有 user ID；只能使用 Cloudflare 寫入且用戶無法偽造的來源 IP。
  // 原值只送進 Rate Limiting counter key，不寫入 log、analytics 或回應。
  const ip = request.headers.get('cf-connecting-ip')?.trim()
  return ip && ip.length <= 64 ? ip : 'unknown'
}

export function apiRateLimit(): MiddlewareHandler<Env> {
  return async (c, next) => {
    const policy = apiRateLimitPolicy(c.req.method, c.req.path)
    if (!policy) return next()

    try {
      const outcome = await c.env[policy.binding].limit({
        key: `${instanceId}:${policy.scope}:${actorKey(c.req.raw)}`,
      })
      if (!outcome.success) {
        return c.json({
          error: '請求過於頻繁，請稍後再試',
          code: 'rate_limited',
        }, 429, {
          'Cache-Control': 'no-store',
          'Retry-After': '60',
        })
      }
    } catch (error) {
      // 限流服務本身異常時 fail-open，避免保護層成為全站單點故障；不記錄 actor key。
      console.error(JSON.stringify({
        message: 'api_rate_limit_binding_failed',
        scope: policy.scope,
        error: error instanceof Error ? error.message : String(error),
      }))
    }

    return next()
  }
}
