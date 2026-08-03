import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { instanceId } from './instance-runtime'
import { apiRateLimit, apiRateLimitPolicy, type RateLimitBindings } from './rate-limit'

const rateLimiter = (success: boolean): RateLimit => ({
  limit: vi.fn(async () => ({ success })),
})

function bindings(overrides: Partial<RateLimitBindings> = {}): RateLimitBindings {
  return {
    API_STANDARD_RATE_LIMITER: rateLimiter(true),
    API_EXPENSIVE_RATE_LIMITER: rateLimiter(true),
    ...overrides,
  }
}

describe('API rate-limit policy', () => {
  it('leaves pages and lightweight metadata endpoints unmetered', () => {
    expect(apiRateLimitPolicy('GET', '/')).toBeUndefined()
    expect(apiRateLimitPolicy('GET', '/api/v1/health/release')).toBeUndefined()
    expect(apiRateLimitPolicy('GET', '/api/v1/map/cities')).toBeUndefined()
    expect(apiRateLimitPolicy('GET', '/api/v1/map/locate')).toBeUndefined()
  })

  it('uses a dedicated policy for expensive routes', () => {
    expect(apiRateLimitPolicy('POST', '/api/v1/map/journey-eta')).toEqual({
      binding: 'API_EXPENSIVE_RATE_LIMITER', scope: 'expensive',
    })
    expect(apiRateLimitPolicy('GET', '/api/v1/map/place/a/arrivals')).toEqual({
      binding: 'API_EXPENSIVE_RATE_LIMITER', scope: 'expensive',
    })
  })

  it('protects other API routes with the standard policy by default', () => {
    expect(apiRateLimitPolicy('GET', '/api/v1/map/nearby')).toEqual({
      binding: 'API_STANDARD_RATE_LIMITER', scope: 'standard',
    })
    expect(apiRateLimitPolicy('GET', '/api/future')).toEqual({
      binding: 'API_STANDARD_RATE_LIMITER', scope: 'standard',
    })
  })
})

describe('API rate-limit middleware', () => {
  afterEach(() => vi.restoreAllMocks())

  function testApp(env: RateLimitBindings, handler = vi.fn(() => new Response('ok'))) {
    const app = new Hono<{ Bindings: RateLimitBindings }>()
    app.use('/api/*', apiRateLimit())
    app.all('/api/*', handler)
    return { app, env, handler }
  }

  it('uses the trusted Cloudflare IP and continues when allowed', async () => {
    const standard = rateLimiter(true)
    const test = testApp(bindings({ API_STANDARD_RATE_LIMITER: standard }))
    const response = await test.app.request('/api/v1/map/nearby', {
      headers: { 'cf-connecting-ip': '203.0.113.8' },
    }, test.env)

    expect(response.status).toBe(200)
    expect(standard.limit).toHaveBeenCalledWith({
      key: `${instanceId}:standard:203.0.113.8`,
    })
    expect(test.handler).toHaveBeenCalledOnce()
  })

  it('returns a non-cacheable 429 without calling the route', async () => {
    const expensive = rateLimiter(false)
    const test = testApp(bindings({ API_EXPENSIVE_RATE_LIMITER: expensive }))
    const response = await test.app.request('/api/v1/map/network', {}, test.env)

    expect(response.status).toBe(429)
    expect(response.headers.get('Retry-After')).toBe('60')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(await response.json()).toEqual({
      error: '請求過於頻繁，請稍後再試',
      code: 'rate_limited',
    })
    expect(test.handler).not.toHaveBeenCalled()
  })

  it('fails open and emits a structured error without the actor key', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const failing: RateLimit = { limit: vi.fn(async () => { throw new Error('binding unavailable') }) }
    const test = testApp(bindings({ API_STANDARD_RATE_LIMITER: failing }))
    const response = await test.app.request('/api/v1/routes', {
      headers: { 'cf-connecting-ip': '203.0.113.9' },
    }, test.env)

    expect(response.status).toBe(200)
    expect(log).toHaveBeenCalledOnce()
    expect(log.mock.calls[0][0]).not.toContain('203.0.113.9')
  })
})
