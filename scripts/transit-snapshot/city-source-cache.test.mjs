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

  it('reuses a city payload while its source UpdateTime is unchanged', async () => {
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
    await expect(cache.store({ resource: 'Route', body: payload, sourceVersion: first.sourceVersion }))
      .resolves.toBe(true)

    const second = await cache.resolve({ resource: 'Route', input: routeUrl, init: {} })
    expect(Buffer.from(second.body).equals(payload)).toBe(true)
    expect(second.sourceVersion).toBe(first.sourceVersion)
    expect([...storage.objects.keys()].some((key) => key.startsWith('tdx-source-cache/v1/city/Taipei/Route/')))
      .toBe(true)
  })

  it('keeps different cities in independent R2 namespaces', async () => {
    const storage = memoryStorage()
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([
      { UpdateTime: '2026-09-05T00:00:00+08:00' },
    ]), { status: 200 }))
    const taipei = createCitySourceCache({ city: 'Taipei', fetchImpl, storage })
    const newTaipei = createCitySourceCache({ city: 'NewTaipei', fetchImpl, storage })

    const version = '2026-09-05T00:00:00+08:00'
    await taipei.store({ resource: 'Route', body: Buffer.from('[1]'), sourceVersion: version })
    await newTaipei.store({ resource: 'Route', body: Buffer.from('[2]'), sourceVersion: version })

    const keys = [...storage.objects.keys()]
    expect(keys.some((key) => key.includes('/city/Taipei/Route/'))).toBe(true)
    expect(keys.some((key) => key.includes('/city/NewTaipei/Route/'))).toBe(true)
  })

  it('rejects invalid city codes before they can become storage keys', () => {
    expect(() => createCitySourceCache({
      city: '../Taipei',
      fetchImpl: vi.fn(),
      storage: memoryStorage(),
    })).toThrow('Invalid TDX city code')
  })
})
