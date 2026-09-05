import { describe, expect, it, vi } from 'vitest'
import { cityProbeUrl, createCitySourceCache } from './city-source-cache.mjs'

const routeUrl = 'https://tdx.transportdata.tw/api/basic/v2/Bus/Route/City/Taipei?$format=JSON'

function memoryStorage() {
  const objects = new Map()
  return {
    objects,
    async getJson(key) {
      const value = objects.get(key)
      return value === undefined ? null : JSON.parse(Buffer.from(value).toString('utf8'))
    },
    async getBuffer(key) {
      const value = objects.get(key)
      return value === undefined ? null : Buffer.from(value)
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
}

describe('City persistent source cache', () => {
  it('builds the same tiny UpdateTime probe for City endpoints', () => {
    const probe = cityProbeUrl(routeUrl)
    expect(probe.pathname).toBe('/api/basic/v2/Bus/Route/City/Taipei')
    expect(probe.searchParams.get('$select')).toBe('UpdateTime')
    expect(probe.searchParams.get('$orderby')).toBe('UpdateTime desc')
    expect(probe.searchParams.get('$top')).toBe('1')
    expect(probe.searchParams.get('$format')).toBe('JSON')
  })

  it('does not serve a fresh payload until its staged candidate is promoted', async () => {
    const storage = memoryStorage()
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([
      { UpdateTime: '2026-09-05T00:00:00+08:00' },
    ]), { status: 200 }))
    const cache = createCitySourceCache({
      city: 'Taipei',
      fetchImpl,
      storage,
      logger: { log: vi.fn(), warn: vi.fn() },
    })

    const first = await cache.resolve({ resource: 'Route', input: routeUrl, init: {} })
    expect(first).toEqual({ body: null, sourceVersion: '2026-09-05T00:00:00+08:00' })
    const payload = Buffer.from('[{"RouteUID":"TPE1"}]')
    const candidate = await cache.stage({ resource: 'Route', body: payload, sourceVersion: first.sourceVersion })
    expect(candidate).toBeTruthy()

    const beforePromotion = await cache.resolve({ resource: 'Route', input: routeUrl, init: {} })
    expect(beforePromotion.body).toBeNull()
    await expect(cache.promote(candidate)).resolves.toBe(true)

    const second = await cache.resolve({ resource: 'Route', input: routeUrl, init: {} })
    expect(Buffer.from(second.body).equals(payload)).toBe(true)
    expect(second.sourceVersion).toBe(first.sourceVersion)
    expect([...storage.objects.keys()].some((key) => key.startsWith('tdx-source-cache/v1/city/Taipei/Route/')))
      .toBe(true)
  })

  it('auto-promotes UpdateTime-only refreshes and garbage-collects the old payload', async () => {
    const storage = memoryStorage()
    const versions = ['2026-09-05T00:00:00+08:00', '2026-09-06T00:00:00+08:00']
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([
      { UpdateTime: versions.shift() ?? '2026-09-06T00:00:00+08:00' },
    ]), { status: 200 }))
    const cache = createCitySourceCache({ city: 'Taipei', fetchImpl, storage })

    const first = await cache.resolve({ resource: 'Route', input: routeUrl, init: {} })
    const firstCandidate = await cache.stage({
      resource: 'Route',
      body: Buffer.from('[{"RouteUID":"TPE1","UpdateTime":"old"}]'),
      sourceVersion: first.sourceVersion,
    })
    await cache.promote(firstCandidate)
    const oldPayloadKey = firstCandidate.payloadKey

    const changedVersion = await cache.resolve({ resource: 'Route', input: routeUrl, init: {} })
    expect(changedVersion.body).toBeNull()
    const equivalent = await cache.stage({
      resource: 'Route',
      body: Buffer.from('[{"RouteUID":"TPE1","UpdateTime":"new"}]'),
      sourceVersion: changedVersion.sourceVersion,
    })
    expect(equivalent).toBeTruthy()

    const resolved = await cache.resolve({ resource: 'Route', input: routeUrl, init: {} })
    expect(resolved.body).not.toBeNull()
    expect(storage.objects.has(oldPayloadKey)).toBe(false)
  })

  it('keeps different cities in independent R2 namespaces', async () => {
    const storage = memoryStorage()
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([
      { UpdateTime: '2026-09-05T00:00:00+08:00' },
    ]), { status: 200 }))
    const taipei = createCitySourceCache({ city: 'Taipei', fetchImpl, storage })
    const newTaipei = createCitySourceCache({ city: 'NewTaipei', fetchImpl, storage })

    const version = '2026-09-05T00:00:00+08:00'
    const taipeiCandidate = await taipei.stage({
      resource: 'Route', body: Buffer.from('[{"RouteUID":"TPE1"}]'), sourceVersion: version,
    })
    const newTaipeiCandidate = await newTaipei.stage({
      resource: 'Route', body: Buffer.from('[{"RouteUID":"NWT1"}]'), sourceVersion: version,
    })
    await taipei.promote(taipeiCandidate)
    await newTaipei.promote(newTaipeiCandidate)

    const keys = [...storage.objects.keys()]
    expect(keys.some((key) => key.includes('/city/Taipei/Route/'))).toBe(true)
    expect(keys.some((key) => key.includes('/city/NewTaipei/Route/'))).toBe(true)
  })

  it('rejects malformed or empty payloads before they can become cache authority', async () => {
    const storage = memoryStorage()
    const cache = createCitySourceCache({ city: 'Taipei', fetchImpl: vi.fn(), storage })
    await expect(cache.stage({ resource: 'Route', body: Buffer.from('{oops'), sourceVersion: 'v1' }))
      .resolves.toBeNull()
    await expect(cache.stage({ resource: 'Route', body: Buffer.from('[]'), sourceVersion: 'v1' }))
      .resolves.toBeNull()
    expect([...storage.objects.keys()].some((key) => key.endsWith('/state.json'))).toBe(false)
  })

  it('rejects invalid city codes before they can become storage keys', () => {
    expect(() => createCitySourceCache({
      city: '../Taipei',
      fetchImpl: vi.fn(),
      storage: memoryStorage(),
    })).toThrow('Invalid TDX city code')
  })
})
