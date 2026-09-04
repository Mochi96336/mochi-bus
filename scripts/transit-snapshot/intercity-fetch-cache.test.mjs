import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createIntercityFetchCache,
  intercityCacheResource,
  intercityCacheScope,
  isCacheableIntercityRequest,
} from './intercity-fetch-cache.mjs'

const roots = []
afterEach(async () => {
  vi.restoreAllMocks()
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

  it('uses one upstream download per resource within a workflow attempt', async () => {
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

  it('hydrates the run cache from persistent storage before downloading the full endpoint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mochi-intercity-cache-'))
    roots.push(root)
    const upstream = vi.fn()
    const persistent = {
      resolve: vi.fn(async () => ({
        body: Buffer.from('[{"RouteUID":"THB1"}]'),
        sourceVersion: '2026-09-05T00:00:00+08:00',
      })),
      store: vi.fn(),
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
    expect(persistent.store).not.toHaveBeenCalled()
    expect(upstream).not.toHaveBeenCalled()
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
