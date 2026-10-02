import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createIntercityFetchCache,
  intercityCacheResource,
  intercityCacheScope,
  isCacheableIntercityRequest,
} from './intercity-fetch-cache.mjs'
import { createIntercitySourceCache } from './intercity-source-cache.mjs'
import {
  promotePendingTdxStaticSources,
  registerTdxStaticSourceCandidate,
} from './tdx-static-source-promotion.mjs'

const roots = []
afterEach(async () => {
  vi.restoreAllMocks()
  await promotePendingTdxStaticSources({ logger: { log: vi.fn(), warn: vi.fn() } })
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('intercity fetch cache', () => {
  it('only admits full static InterCity JSON endpoints', () => {
    const shape = 'https://tdx.transportdata.tw/api/basic/v2/Bus/Shape/InterCity?$format=JSON'
    expect(isCacheableIntercityRequest(shape)).toBe(true)
    expect(intercityCacheResource(shape)).toBe('Shape')

    expect(isCacheableIntercityRequest(
      'https://tdx.transportdata.tw/api/basic/v2/Bus/Shape/City/Taipei?$format=JSON',
    )).toBe(false)
    expect(isCacheableIntercityRequest(
      'https://tdx.transportdata.tw/api/basic/v2/Bus/EstimatedTimeOfArrival/InterCity?$format=JSON',
    )).toBe(false)
    expect(isCacheableIntercityRequest(
      'https://tdx.transportdata.tw/api/basic/v2/Bus/Shape/InterCity?$format=JSON&$top=1',
    )).toBe(false)
    expect(isCacheableIntercityRequest(shape, { method: 'POST' })).toBe(false)
  })

  it('uses one upstream download per resource within a workflow attempt when persistent R2 is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mochi-intercity-cache-'))
    roots.push(root)
    const upstream = vi.fn(async () => new Response(JSON.stringify([{ RouteUID: 'THB1' }]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const fetchCached = createIntercityFetchCache({
      fetchImpl: upstream,
      root,
      scope: 'run-1',
      logger: { log: vi.fn(), warn: vi.fn() },
    })
    const url = 'https://tdx.transportdata.tw/api/basic/v2/Bus/Shape/InterCity?$format=JSON'

    await expect((await fetchCached(url, { headers: { Authorization: 'Bearer first' } })).json())
      .resolves.toEqual([{ RouteUID: 'THB1' }])
    await expect((await fetchCached(url, { headers: { Authorization: 'Bearer second' } })).json())
      .resolves.toEqual([{ RouteUID: 'THB1' }])

    expect(upstream).toHaveBeenCalledTimes(1)
  })

  it('hydrates the run cache from promoted persistent storage before downloading the full endpoint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mochi-intercity-cache-'))
    roots.push(root)
    const upstream = vi.fn()
    const persistent = {
      resolve: vi.fn(async () => ({
        body: Buffer.from('[{"RouteUID":"THB1"}]'),
        sourceVersion: '2026-09-05T00:00:00+08:00',
      })),
      stage: vi.fn(),
      promote: vi.fn(),
    }
    const fetchCached = createIntercityFetchCache({
      fetchImpl: upstream,
      root,
      scope: 'run-persistent',
      persistent,
      logger: { log: vi.fn(), warn: vi.fn() },
    })
    const url = 'https://tdx.transportdata.tw/api/basic/v2/Bus/Shape/InterCity?$format=JSON'

    await expect((await fetchCached(url)).json()).resolves.toEqual([{ RouteUID: 'THB1' }])
    await expect((await fetchCached(url)).json()).resolves.toEqual([{ RouteUID: 'THB1' }])

    expect(persistent.resolve).toHaveBeenCalledTimes(1)
    expect(persistent.stage).not.toHaveBeenCalled()
    expect(upstream).not.toHaveBeenCalled()
  })

  it('does not hit upstream when persistent storage blocks an unsafe oversized fallback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mochi-intercity-cache-'))
    roots.push(root)
    const upstream = vi.fn()
    const persistent = {
      resolve: vi.fn(async () => ({
        body: null,
        sourceVersion: 'v1',
        blockUpstream: true,
        cacheFailure: 'oversize_cache_unreadable',
      })),
      stage: vi.fn(),
    }
    const fetchCached = createIntercityFetchCache({
      fetchImpl: upstream,
      root,
      scope: 'run-blocked',
      persistent,
      logger: { log: vi.fn(), warn: vi.fn() },
    })
    const url = 'https://tdx.transportdata.tw/api/basic/v2/Bus/Shape/InterCity?$format=JSON'

    const response = await fetchCached(url)
    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      error: 'persistent_cache_unavailable',
      failureClass: 'oversize_cache_unreadable',
    })
    expect(upstream).not.toHaveBeenCalled()
    expect(persistent.stage).not.toHaveBeenCalled()
  })

  it('does not put an unvalidated upstream candidate into the cross-process run cache', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mochi-intercity-cache-'))
    roots.push(root)
    const upstream = vi.fn(async () => new Response('[{"RouteUID":"THB2"}]', { status: 200 }))
    const candidate = { resource: 'Shape', sourceVersion: 'v2', payloadKey: 'candidate' }
    const persistent = {
      resolve: vi.fn(async () => ({ body: null, sourceVersion: 'v2' })),
      stage: vi.fn(async () => candidate),
      promote: vi.fn(),
    }
    const registerCandidate = vi.fn()
    const fetchCached = createIntercityFetchCache({
      fetchImpl: upstream,
      root,
      scope: 'run-candidate',
      persistent,
      registerCandidate,
      logger: { log: vi.fn(), warn: vi.fn() },
    })
    const url = 'https://tdx.transportdata.tw/api/basic/v2/Bus/Shape/InterCity?$format=JSON'

    await expect((await fetchCached(url)).json()).resolves.toEqual([{ RouteUID: 'THB2' }])
    expect(registerCandidate).toHaveBeenCalledWith({ cache: persistent, candidate, resource: 'Shape' })
    await expect(readFile(join(root, 'run-candidate', 'Shape.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(persistent.promote).not.toHaveBeenCalled()
  })

  it('reuses an awaited promoted InterCity source across sequential city processes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mochi-intercity-cache-'))
    roots.push(root)
    const objects = new Map()
    const storage = {
      async getJson(key) {
        const value = objects.get(key)
        return value === undefined ? null : JSON.parse(Buffer.from(value).toString('utf8'))
      },
      async getBuffer(key, maximumBytes) {
        const value = objects.get(key)
        if (value === undefined) return null
        const body = Buffer.from(value)
        if (body.byteLength > maximumBytes) throw new Error('test payload exceeds read bound')
        return body
      },
      async putBuffer(key, body) {
        objects.set(key, Buffer.from(body))
      },
      async putJson(key, value) {
        objects.set(key, Buffer.from(JSON.stringify(value)))
      },
      async deleteObject(key) {
        objects.delete(key)
      },
    }

    const version = '2026-10-02T00:00:00+08:00'
    const payload = JSON.stringify([{
      RouteUID: 'THB1',
      Direction: 0,
      EncodedPolyline: 'abc',
      UpdateTime: version,
    }])
    let fullDownloads = 0
    const sourceFetch = vi.fn(async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.searchParams.get('$top') === '1' && url.searchParams.get('$select') === 'UpdateTime') {
        return new Response(JSON.stringify([{ UpdateTime: version }]), { status: 200 })
      }
      fullDownloads += 1
      return new Response(payload, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    const cacheOptions = {
      fetchImpl: sourceFetch,
      storage,
      env: { SNAPSHOT_INTERCITY_SHAPE_REFRESH_DAYS: '56' },
      now: () => Date.parse('2026-10-02T00:00:00.000Z'),
      logger: { log: vi.fn(), warn: vi.fn() },
    }
    const url = 'https://tdx.transportdata.tw/api/basic/v2/Bus/Shape/InterCity?$format=JSON'

    const firstPersistent = createIntercitySourceCache(cacheOptions)
    const firstCityFetch = createIntercityFetchCache({
      fetchImpl: sourceFetch,
      root,
      scope: 'sequential-cities',
      persistent: firstPersistent,
      registerCandidate: registerTdxStaticSourceCandidate,
      logger: { log: vi.fn(), warn: vi.fn() },
    })
    await expect((await firstCityFetch(url)).json()).resolves.toEqual(JSON.parse(payload))
    expect(fullDownloads).toBe(1)

    const promotion = await promotePendingTdxStaticSources({ logger: { log: vi.fn(), warn: vi.fn() } })
    expect(promotion.promoted).toBe(1)

    const secondPersistent = createIntercitySourceCache(cacheOptions)
    const secondCityFetch = createIntercityFetchCache({
      fetchImpl: sourceFetch,
      root,
      scope: 'sequential-cities',
      persistent: secondPersistent,
      registerCandidate: registerTdxStaticSourceCandidate,
      logger: { log: vi.fn(), warn: vi.fn() },
    })
    await expect((await secondCityFetch(url)).json()).resolves.toEqual(JSON.parse(payload))

    expect(fullDownloads).toBe(1)
    expect(sourceFetch).toHaveBeenCalledTimes(2)
  })

  it('keeps cache scope inside one GitHub workflow attempt', () => {
    expect(intercityCacheScope({ GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2' }))
      .toBe('github-123-2')
    expect(intercityCacheScope({
      GITHUB_RUN_ID: '123',
      GITHUB_RUN_ATTEMPT: '2',
      MOCHI_TDX_INTERCITY_CACHE_SCOPE: 'manual scope',
    })).toBe('manual_scope')
    expect(intercityCacheScope({})).toBeNull()
  })

  it('does not cache failed upstream responses', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mochi-intercity-cache-'))
    roots.push(root)
    const upstream = vi.fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(new Response('[]', { status: 200 }))
    const fetchCached = createIntercityFetchCache({
      fetchImpl: upstream,
      root,
      scope: 'run-2',
      logger: { log: vi.fn(), warn: vi.fn() },
    })
    const url = 'https://tdx.transportdata.tw/api/basic/v2/Bus/Stop/InterCity?$format=JSON'

    expect((await fetchCached(url)).status).toBe(429)
    expect((await fetchCached(url)).status).toBe(200)
    expect(upstream).toHaveBeenCalledTimes(2)
  })
})
