import { describe, expect, it, vi } from 'vitest'
import {
  cityCacheIdentity,
  createCityFetchCache,
  isCacheableCityRequest,
} from './city-fetch-cache.mjs'

const routeUrl = 'https://tdx.transportdata.tw/api/basic/v2/Bus/Route/City/Taipei?$format=JSON'

describe('City fetch cache', () => {
  it('only admits exact full static City JSON endpoints', () => {
    expect(isCacheableCityRequest(routeUrl)).toBe(true)
    expect(cityCacheIdentity(routeUrl)).toEqual({ resource: 'Route', city: 'Taipei' })

    expect(isCacheableCityRequest(
      'https://tdx.transportdata.tw/api/basic/v2/Bus/StopOfRoute/City/Chiayi?$format=JSON',
    )).toBe(true)
    expect(isCacheableCityRequest(
      'https://tdx.transportdata.tw/api/basic/v2/Bus/Stop/City/Taipei?$format=JSON',
    )).toBe(false)
    expect(isCacheableCityRequest(
      'https://tdx.transportdata.tw/api/basic/v2/Bus/Route/City/Taipei?$format=JSON&$top=1',
    )).toBe(false)
    expect(isCacheableCityRequest(routeUrl, { method: 'POST' })).toBe(false)
  })

  it('serves a persistent hit without downloading the full City payload', async () => {
    const upstream = vi.fn()
    const persistent = {
      resolve: vi.fn(async () => ({
        body: Buffer.from('[{"RouteUID":"TPE1"}]'),
        sourceVersion: 'v1',
      })),
      stage: vi.fn(),
      promote: vi.fn(),
    }
    const registerCandidate = vi.fn()
    const cachedFetch = createCityFetchCache({
      fetchImpl: upstream,
      persistentForCity: (city) => city === 'Taipei' ? persistent : null,
      registerCandidate,
      logger: { log: vi.fn(), warn: vi.fn() },
    })

    const response = await cachedFetch(routeUrl, { headers: { Authorization: 'Bearer token' } })
    await expect(response.json()).resolves.toEqual([{ RouteUID: 'TPE1' }])
    expect(upstream).not.toHaveBeenCalled()
    expect(persistent.resolve).toHaveBeenCalledTimes(1)
    expect(persistent.stage).not.toHaveBeenCalled()
    expect(registerCandidate).not.toHaveBeenCalled()
  })

  it('stages and registers a full payload after a persistent miss without promoting it', async () => {
    const upstream = vi.fn(async () => new Response('[{"RouteUID":"TPE2"}]', { status: 200 }))
    const candidate = { resource: 'Route', sourceVersion: 'v2', payloadKey: 'candidate' }
    const persistent = {
      resolve: vi.fn(async () => ({ body: null, sourceVersion: 'v2' })),
      stage: vi.fn(async () => candidate),
      promote: vi.fn(),
    }
    const registerCandidate = vi.fn()
    const cachedFetch = createCityFetchCache({
      fetchImpl: upstream,
      persistentForCity: () => persistent,
      registerCandidate,
      logger: { log: vi.fn(), warn: vi.fn() },
    })

    await expect((await cachedFetch(routeUrl)).json()).resolves.toEqual([{ RouteUID: 'TPE2' }])
    expect(upstream).toHaveBeenCalledTimes(1)
    expect(persistent.stage).toHaveBeenCalledWith(expect.objectContaining({
      resource: 'Route',
      sourceVersion: 'v2',
    }))
    expect(registerCandidate).toHaveBeenCalledWith({
      cache: persistent,
      candidate,
      city: 'Taipei',
      resource: 'Route',
    })
    expect(persistent.promote).not.toHaveBeenCalled()
  })

  it('leaves filtered and dynamic requests untouched', async () => {
    const upstream = vi.fn(async () => new Response('[]', { status: 200 }))
    const factory = vi.fn()
    const cachedFetch = createCityFetchCache({ fetchImpl: upstream, persistentForCity: factory })
    const filtered = `${routeUrl}&$top=1`

    expect((await cachedFetch(filtered)).status).toBe(200)
    expect(factory).not.toHaveBeenCalled()
    expect(upstream).toHaveBeenCalledTimes(1)
  })
})
