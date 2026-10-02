import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createIntercitySourceCache, intercityProbeUrl } from './intercity-source-cache.mjs'

const shapeUrl = 'https://tdx.transportdata.tw/api/basic/v2/Bus/Shape/InterCity?$format=JSON'

function memoryStorage() {
  const objects = new Map()
  const reads = []
  return {
    objects,
    reads,
    async getJson(key) {
      const value = objects.get(key)
      return value === undefined ? null : JSON.parse(Buffer.from(value).toString('utf8'))
    },
    async getBuffer(key, maximumBytes) {
      reads.push({ key, maximumBytes })
      const value = objects.get(key)
      if (value === undefined) return null
      const body = Buffer.isBuffer(value) ? value : Buffer.from(value)
      if (maximumBytes !== undefined && body.byteLength > maximumBytes) {
        throw new Error(`test storage read exceeds ${maximumBytes} bytes`)
      }
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

  it('serves a verified legacy oversized promoted payload without probing or restaging it', async () => {
    const storage = memoryStorage()
    const logger = { log: vi.fn(), warn: vi.fn() }
    const nowMs = Date.parse('2026-10-02T00:00:00.000Z')
    const payload = Buffer.alloc(64 * 1024 * 1024 + 1, 0x61)
    const digest = createHash('sha256').update(payload).digest('hex')
    const payloadKey = `tdx-source-cache/v1/intercity/Shape/payload-${digest}.json`
    storage.objects.set(payloadKey, payload)
    storage.objects.set('tdx-source-cache/v1/intercity/Shape/state.json', Buffer.from(JSON.stringify({
      schemaVersion: 1,
      resource: 'Shape',
      sourceVersion: '2026-09-05T00:00:00+08:00',
      payloadKey,
      sha256: digest,
      bytes: payload.byteLength,
      refreshedAt: new Date(nowMs).toISOString(),
    })))

    const fetchImpl = vi.fn()
    const cache = createIntercitySourceCache({
      fetchImpl,
      storage,
      logger,
      env: { SNAPSHOT_INTERCITY_SHAPE_REFRESH_DAYS: '56' },
      now: () => nowMs,
    })

    const resolved = await cache.resolve({ resource: 'Shape', input: shapeUrl, init: {} })
    expect(resolved.sourceVersion).toBe('2026-09-05T00:00:00+08:00')
    expect(resolved.body).toBe(payload)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(storage.reads).toContainEqual({ key: payloadKey, maximumBytes: payload.byteLength })
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('"legacyOversize":true'))

    await expect(cache.stage({
      resource: 'Shape',
      body: payload,
      sourceVersion: '2026-10-02T00:00:00+08:00',
    })).resolves.toBeNull()
  })

  it('blocks upstream fallback when a legacy oversized promoted payload fails integrity verification', async () => {
    const storage = memoryStorage()
    const logger = { log: vi.fn(), warn: vi.fn() }
    const nowMs = Date.parse('2026-10-02T00:00:00.000Z')
    const body = Buffer.from('[{"RouteUID":"THB1"}]')
    const digest = createHash('sha256').update(body).digest('hex')
    const payloadKey = `tdx-source-cache/v1/intercity/Shape/payload-${digest}.json`
    storage.objects.set(payloadKey, body)
    storage.objects.set('tdx-source-cache/v1/intercity/Shape/state.json', Buffer.from(JSON.stringify({
      schemaVersion: 1,
      resource: 'Shape',
      sourceVersion: '2026-09-05T00:00:00+08:00',
      payloadKey,
      sha256: digest,
      bytes: 64 * 1024 * 1024 + 1,
      refreshedAt: new Date(nowMs).toISOString(),
    })))

    const fetchImpl = vi.fn()
    const cache = createIntercitySourceCache({
      fetchImpl,
      storage,
      logger,
      env: { SNAPSHOT_INTERCITY_SHAPE_REFRESH_DAYS: '56' },
      now: () => nowMs,
    })

    await expect(cache.resolve({ resource: 'Shape', input: shapeUrl, init: {} })).resolves.toEqual({
      body: null,
      sourceVersion: '2026-09-05T00:00:00+08:00',
      blockUpstream: true,
      cacheFailure: 'oversize_cache_unreadable',
    })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('integrity mismatch'))
  })

  it('blocks upstream fallback when a legacy oversized promoted payload exceeds the compatibility cap', async () => {
    const storage = memoryStorage()
    const logger = { log: vi.fn(), warn: vi.fn() }
    const nowMs = Date.parse('2026-10-02T00:00:00.000Z')
    const payloadKey = `tdx-source-cache/v1/intercity/Shape/payload-${'0'.repeat(64)}.json`
    storage.objects.set('tdx-source-cache/v1/intercity/Shape/state.json', Buffer.from(JSON.stringify({
      schemaVersion: 1,
      resource: 'Shape',
      sourceVersion: '2026-09-05T00:00:00+08:00',
      payloadKey,
      sha256: '0'.repeat(64),
      bytes: 256 * 1024 * 1024 + 1,
      refreshedAt: new Date(nowMs).toISOString(),
    })))

    const fetchImpl = vi.fn()
    const cache = createIntercitySourceCache({
      fetchImpl,
      storage,
      logger,
      env: { SNAPSHOT_INTERCITY_SHAPE_REFRESH_DAYS: '56' },
      now: () => nowMs,
    })

    await expect(cache.resolve({ resource: 'Shape', input: shapeUrl, init: {} })).resolves.toEqual({
      body: null,
      sourceVersion: '2026-09-05T00:00:00+08:00',
      blockUpstream: true,
      cacheFailure: 'oversize_cache_unreadable',
    })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(storage.reads.some(({ key }) => key === payloadKey)).toBe(false)
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
