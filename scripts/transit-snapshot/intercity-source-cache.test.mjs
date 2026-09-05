import { describe, expect, it, vi } from 'vitest'
import { createIntercitySourceCache, intercityProbeUrl } from './intercity-source-cache.mjs'

const shapeUrl = 'https://tdx.transportdata.tw/api/basic/v2/Bus/Shape/InterCity?$format=JSON'

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

describe('InterCity persistent source cache', () => {
  it('builds a tiny UpdateTime probe from a full endpoint', () => {
    const probe = intercityProbeUrl(shapeUrl)
    expect(probe.pathname).toBe('/api/basic/v2/Bus/Shape/InterCity')
    expect(probe.searchParams.get('$select')).toBe('UpdateTime')
    expect(probe.searchParams.get('$orderby')).toBe('UpdateTime desc')
    expect(probe.searchParams.get('$top')).toBe('1')
    expect(probe.searchParams.get('$format')).toBe('JSON')
    expect([...probe.searchParams.keys()].sort()).toEqual(['$format', '$orderby', '$select', '$top'].sort())
  })

  it('stages a full payload without serving it before promotion', async () => {
    const storage = memoryStorage()
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([
      { UpdateTime: '2026-09-05T00:00:00+08:00' },
    ]), { status: 200 }))
    const cache = createIntercitySourceCache({
      fetchImpl,
      storage,
      logger: { log: vi.fn(), warn: vi.fn() },
    })

    const first = await cache.resolve({ resource: 'Shape', input: shapeUrl, init: {} })
    expect(first).toEqual({ body: null, sourceVersion: '2026-09-05T00:00:00+08:00' })

    const payload = Buffer.from('[{"RouteUID":"THB1","EncodedPolyline":"abc"}]')
    const candidate = await cache.stage({ resource: 'Shape', body: payload, sourceVersion: first.sourceVersion })
    expect(candidate).toBeTruthy()
    expect((await cache.resolve({ resource: 'Shape', input: shapeUrl, init: {} })).body).toBeNull()

    await expect(cache.promote(candidate)).resolves.toBe(true)
    const second = await cache.resolve({ resource: 'Shape', input: shapeUrl, init: {} })
    expect(second.sourceVersion).toBe(first.sourceVersion)
    expect(Buffer.from(second.body).equals(payload)).toBe(true)
  })

  it('misses the old R2 payload when the upstream UpdateTime changes and semantics change', async () => {
    const storage = memoryStorage()
    const versions = [
      '2026-09-05T00:00:00+08:00',
      '2026-09-06T00:00:00+08:00',
      '2026-09-06T00:00:00+08:00',
    ]
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([
      { UpdateTime: versions.shift() },
    ]), { status: 200 }))
    const cache = createIntercitySourceCache({ fetchImpl, storage })

    const first = await cache.resolve({ resource: 'Shape', input: shapeUrl, init: {} })
    const candidate = await cache.stage({
      resource: 'Shape',
      body: Buffer.from('[{"RouteUID":"THB1","EncodedPolyline":"a"}]'),
      sourceVersion: first.sourceVersion,
    })
    await cache.promote(candidate)
    const second = await cache.resolve({ resource: 'Shape', input: shapeUrl, init: {} })
    expect(second).toEqual({ body: null, sourceVersion: '2026-09-06T00:00:00+08:00' })

    const changed = await cache.stage({
      resource: 'Shape',
      body: Buffer.from('[{"RouteUID":"THB1","EncodedPolyline":"b"}]'),
      sourceVersion: second.sourceVersion,
    })
    expect(changed).toBeTruthy()
    const stillUnpromoted = await cache.resolve({ resource: 'Shape', input: shapeUrl, init: {} })
    expect(stillUnpromoted.body).toBeNull()
  })

  it('fails open when the UpdateTime probe cannot be used', async () => {
    const storage = memoryStorage()
    const logger = { log: vi.fn(), warn: vi.fn() }
    const cache = createIntercitySourceCache({
      fetchImpl: vi.fn(async () => new Response('rate limited', { status: 429 })),
      storage,
      logger,
    })

    await expect(cache.resolve({ resource: 'Shape', input: shapeUrl, init: {} }))
      .resolves.toEqual({ body: null, sourceVersion: null })
    await expect(cache.stage({ resource: 'Shape', body: Buffer.from('[{"RouteUID":"THB1"}]'), sourceVersion: null }))
      .resolves.toBeNull()
  })

  it('rejects corrupted cached bytes instead of serving them', async () => {
    const storage = memoryStorage()
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([
      { UpdateTime: '2026-09-05T00:00:00+08:00' },
    ]), { status: 200 }))
    const logger = { log: vi.fn(), warn: vi.fn() }
    const cache = createIntercitySourceCache({ fetchImpl, storage, logger })

    const first = await cache.resolve({ resource: 'Shape', input: shapeUrl, init: {} })
    const candidate = await cache.stage({
      resource: 'Shape', body: Buffer.from('[{"RouteUID":"THB1"}]'), sourceVersion: first.sourceVersion,
    })
    await cache.promote(candidate)
    const stateKey = [...storage.objects.keys()].find((key) => key.endsWith('/state.json'))
    const state = JSON.parse(storage.objects.get(stateKey).toString('utf8'))
    storage.objects.set(state.payloadKey, Buffer.from('[{"RouteUID":"THB2"}]'))

    const resolved = await cache.resolve({ resource: 'Shape', input: shapeUrl, init: {} })
    expect(resolved).toEqual({ body: null, sourceVersion: first.sourceVersion })
    expect(logger.warn).toHaveBeenCalled()
  })

  it('does not stage malformed or empty upstream payloads', async () => {
    const storage = memoryStorage()
    const cache = createIntercitySourceCache({ fetchImpl: vi.fn(), storage })
    await expect(cache.stage({ resource: 'Shape', body: Buffer.from('[]'), sourceVersion: 'v1' }))
      .resolves.toBeNull()
    await expect(cache.stage({ resource: 'Shape', body: Buffer.from('{broken'), sourceVersion: 'v1' }))
      .resolves.toBeNull()
    expect([...storage.objects.keys()].some((key) => key.endsWith('/state.json'))).toBe(false)
  })
})
