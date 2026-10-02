import { describe, expect, it, vi } from 'vitest'
import { createTdxStaticSourceCache } from './tdx-static-source-cache.mjs'

const cachePrefix = 'tdx-source-cache/v1/intercity'
const shapeUrl = 'https://tdx.transportdata.tw/api/basic/v2/Bus/Shape/InterCity?$format=JSON'
const sourceVersion = '2026-10-02T00:00:00+08:00'

function memoryStorage({ failChunkPutAt = null } = {}) {
  const objects = new Map()
  const reads = []
  const deletes = []
  let chunkPuts = 0
  return {
    objects,
    reads,
    deletes,
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
      if (key.includes('/chunks/')) {
        chunkPuts += 1
        if (failChunkPutAt === chunkPuts) throw new Error('injected chunk put failure')
      }
      objects.set(key, Buffer.from(body))
    },
    async putJson(key, value) {
      objects.set(key, Buffer.from(JSON.stringify(value)))
    },
    async deleteObject(key) {
      deletes.push(key)
      objects.delete(key)
    },
  }
}

function cacheFor(storage, overrides = {}) {
  return createTdxStaticSourceCache({
    fetchImpl: overrides.fetchImpl ?? vi.fn(),
    storage,
    cachePrefix,
    sourceLabel: 'InterCity',
    eventName: 'tdx_intercity_persistent_cache',
    logger: overrides.logger ?? { log: vi.fn(), warn: vi.fn() },
    minimumRefreshMsForResource: () => 60_000,
    now: overrides.now ?? (() => Date.parse('2026-10-02T00:00:00.000Z')),
    singleBlobMaxBytes: 32,
    chunkBytes: 16,
    promotedPayloadMaxBytes: 256,
  })
}

function chunkedPayload(routeUid = 'THB1', fill = 'abcdefghijklmnopqrstuvwxyz0123456789') {
  return Buffer.from(JSON.stringify([{ RouteUID: routeUid, EncodedPolyline: fill }]))
}

describe('TDX static source chunked payload storage', () => {
  it('stages oversized bytes as chunks and serves them only after atomic state promotion', async () => {
    const storage = memoryStorage()
    const fetchImpl = vi.fn()
    const cache = cacheFor(storage, { fetchImpl })
    const payload = chunkedPayload()
    expect(payload.byteLength).toBeGreaterThan(32)

    const candidate = await cache.stage({ resource: 'Shape', body: payload, sourceVersion })
    expect(candidate).toMatchObject({
      schemaVersion: 2,
      resource: 'Shape',
      sourceVersion,
      bytes: payload.byteLength,
    })
    expect(candidate.chunks.length).toBeGreaterThan(1)
    expect(candidate.chunks.every((chunk) => chunk.bytes <= 16)).toBe(true)
    expect([...storage.objects.keys()].some((key) => key.includes('/chunks/'))).toBe(true)
    expect(storage.objects.has(`${cachePrefix}/Shape/state.json`)).toBe(false)

    await expect(cache.promote(candidate)).resolves.toBe(true)
    const state = JSON.parse(storage.objects.get(`${cachePrefix}/Shape/state.json`).toString('utf8'))
    expect(state.schemaVersion).toBe(2)
    expect(state.chunks).toHaveLength(candidate.chunks.length)
    expect(state.payloadKey).toBeUndefined()

    const resolved = await cache.resolve({ resource: 'Shape', input: shapeUrl, init: {} })
    expect(Buffer.from(resolved.body).equals(payload)).toBe(true)
    expect(resolved.sourceVersion).toBe(sourceVersion)
    expect(fetchImpl).not.toHaveBeenCalled()
    for (const chunk of candidate.chunks) {
      expect(storage.reads).toContainEqual({ key: chunk.key, maximumBytes: chunk.bytes })
    }
  })

  it('keeps the previous authority if chunk staging fails before promotion', async () => {
    const storage = memoryStorage({ failChunkPutAt: 2 })
    const cache = cacheFor(storage)
    const payload = chunkedPayload()

    await expect(cache.stage({ resource: 'Shape', body: payload, sourceVersion })).resolves.toBeNull()
    expect(storage.objects.has(`${cachePrefix}/Shape/state.json`)).toBe(false)
  })

  it('cleans the old single blob only after a chunked candidate becomes authority', async () => {
    const storage = memoryStorage()
    const cache = cacheFor(storage)
    const small = Buffer.from('[{"RouteUID":"A"}]')
    expect(small.byteLength).toBeLessThanOrEqual(32)

    const oldCandidate = await cache.stage({ resource: 'Shape', body: small, sourceVersion: 'v1' })
    expect(oldCandidate.schemaVersion).toBe(1)
    await expect(cache.promote(oldCandidate)).resolves.toBe(true)
    expect(storage.objects.has(oldCandidate.payloadKey)).toBe(true)

    const next = await cache.stage({
      resource: 'Shape',
      body: chunkedPayload('THB2', 'different-payload-abcdefghijklmnopqrstuvwxyz0123456789'),
      sourceVersion: 'v2',
    })
    expect(next.schemaVersion).toBe(2)
    await expect(cache.promote(next)).resolves.toBe(true)

    expect(storage.objects.has(oldCandidate.payloadKey)).toBe(false)
    expect(storage.deletes).toContain(oldCandidate.payloadKey)
    for (const chunk of next.chunks) expect(storage.objects.has(chunk.key)).toBe(true)
  })

  it('fails closed on a corrupted promoted chunk instead of probing upstream', async () => {
    const storage = memoryStorage()
    const fetchImpl = vi.fn()
    const logger = { log: vi.fn(), warn: vi.fn() }
    const cache = cacheFor(storage, { fetchImpl, logger })
    const candidate = await cache.stage({ resource: 'Shape', body: chunkedPayload(), sourceVersion })
    await cache.promote(candidate)

    storage.objects.set(candidate.chunks[0].key, Buffer.from('corrupted'))
    const resolved = await cache.resolve({ resource: 'Shape', input: shapeUrl, init: {} })

    expect(resolved).toEqual({
      body: null,
      sourceVersion,
      blockUpstream: true,
      cacheFailure: 'oversize_cache_unreadable',
    })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('chunk integrity mismatch'))
  })
})
