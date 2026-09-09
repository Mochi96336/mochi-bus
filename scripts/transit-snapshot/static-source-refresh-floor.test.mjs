import { describe, expect, it, vi } from 'vitest'
import { createIntercitySourceCache } from './intercity-source-cache.mjs'
import {
  staticSourceMinimumRefreshMs,
  staticSourceRefreshFloorBypassed,
} from './static-source-refresh-policy.mjs'

const DAY_MS = 24 * 60 * 60 * 1_000
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

function probeFetch() {
  return vi.fn(async () => Response.json([{ UpdateTime: '2026-09-01T00:00:00+08:00' }]))
}

async function promotedShape({ env, now, storage = memoryStorage(), fetchImpl = probeFetch(), logger } = {}) {
  const cache = createIntercitySourceCache({ fetchImpl, storage, env, now, logger })
  const first = await cache.resolve({ resource: 'Shape', input: shapeUrl, init: {} })
  const body = Buffer.from('[{"RouteUID":"THB1","Direction":0,"EncodedPolyline":"abc"}]')
  const candidate = await cache.stage({ resource: 'Shape', body, sourceVersion: first.sourceVersion })
  expect(candidate).toBeTruthy()
  await expect(cache.promote(candidate)).resolves.toBe(true)
  return { cache, storage, fetchImpl, body }
}

describe('static source refresh policy', () => {
  it('maps topology, schedule and shape floors independently and fails open on invalid values', () => {
    const env = {
      SNAPSHOT_CITY_TOPOLOGY_REFRESH_DAYS: '14',
      SNAPSHOT_CITY_SCHEDULE_REFRESH_DAYS: '21',
      SNAPSHOT_CITY_SHAPE_REFRESH_DAYS: '28',
      SNAPSHOT_INTERCITY_TOPOLOGY_REFRESH_DAYS: '21',
      SNAPSHOT_INTERCITY_SCHEDULE_REFRESH_DAYS: '35',
      SNAPSHOT_INTERCITY_SHAPE_REFRESH_DAYS: '56',
    }
    expect(staticSourceMinimumRefreshMs(env, 'city', 'Route')).toBe(14 * DAY_MS)
    expect(staticSourceMinimumRefreshMs(env, 'city', 'StopOfRoute')).toBe(14 * DAY_MS)
    expect(staticSourceMinimumRefreshMs(env, 'city', 'Schedule')).toBe(21 * DAY_MS)
    expect(staticSourceMinimumRefreshMs(env, 'city', 'Shape')).toBe(28 * DAY_MS)
    expect(staticSourceMinimumRefreshMs(env, 'intercity', 'Stop')).toBe(21 * DAY_MS)
    expect(staticSourceMinimumRefreshMs(env, 'intercity', 'Schedule')).toBe(35 * DAY_MS)
    expect(staticSourceMinimumRefreshMs(env, 'intercity', 'Shape')).toBe(56 * DAY_MS)
    expect(staticSourceMinimumRefreshMs({ SNAPSHOT_INTERCITY_SHAPE_REFRESH_DAYS: 'broken' }, 'intercity', 'Shape')).toBe(0)
    expect(staticSourceMinimumRefreshMs(env, 'unknown', 'Shape')).toBe(0)
    expect(staticSourceRefreshFloorBypassed({ SNAPSHOT_STATIC_SOURCE_BYPASS_FLOOR: 'true' })).toBe(true)
    expect(staticSourceRefreshFloorBypassed({ SNAPSHOT_STATIC_SOURCE_BYPASS_FLOOR: '' })).toBe(false)
  })

  it('serves a verified fresh payload without issuing an UpdateTime probe', async () => {
    let nowMs = Date.parse('2026-09-01T00:00:00Z')
    const logger = { log: vi.fn(), warn: vi.fn() }
    const env = { SNAPSHOT_INTERCITY_SHAPE_REFRESH_DAYS: '56' }
    const { cache, fetchImpl, body } = await promotedShape({ env, now: () => nowMs, logger })
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    nowMs += 20 * DAY_MS
    await expect(cache.resolve({ resource: 'Shape', input: shapeUrl, init: {} }))
      .resolves.toEqual({ body, sourceVersion: '2026-09-01T00:00:00+08:00' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(logger.log.mock.calls.map(([line]) => JSON.parse(line))).toContainEqual(expect.objectContaining({
      event: 'tdx_intercity_persistent_cache',
      resource: 'Shape',
      resolution: 'freshness-hit',
      ageMs: 20 * DAY_MS,
      minimumRefreshMs: 56 * DAY_MS,
    }))

    nowMs += 37 * DAY_MS
    await expect(cache.resolve({ resource: 'Shape', input: shapeUrl, init: {} }))
      .resolves.toEqual({ body, sourceVersion: '2026-09-01T00:00:00+08:00' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('lets an operator manual run bypass the floor', async () => {
    let nowMs = Date.parse('2026-09-01T00:00:00Z')
    const env = {
      SNAPSHOT_INTERCITY_SHAPE_REFRESH_DAYS: '56',
      SNAPSHOT_STATIC_SOURCE_BYPASS_FLOOR: '1',
    }
    const { cache, fetchImpl, body } = await promotedShape({ env, now: () => nowMs })
    nowMs += DAY_MS
    await expect(cache.resolve({ resource: 'Shape', input: shapeUrl, init: {} }))
      .resolves.toEqual({ body, sourceVersion: '2026-09-01T00:00:00+08:00' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('does not let a freshness floor hide corrupted cached bytes', async () => {
    let nowMs = Date.parse('2026-09-01T00:00:00Z')
    const storage = memoryStorage()
    const logger = { log: vi.fn(), warn: vi.fn() }
    const env = { SNAPSHOT_INTERCITY_SHAPE_REFRESH_DAYS: '56' }
    const { cache, fetchImpl } = await promotedShape({ env, now: () => nowMs, storage, logger })
    const stateKey = [...storage.objects.keys()].find((key) => key.endsWith('/state.json'))
    const state = JSON.parse(storage.objects.get(stateKey).toString('utf8'))
    storage.objects.set(state.payloadKey, Buffer.from('[{"RouteUID":"THB2"}]'))

    nowMs += DAY_MS
    await expect(cache.resolve({ resource: 'Shape', input: shapeUrl, init: {} }))
      .resolves.toEqual({ body: null, sourceVersion: '2026-09-01T00:00:00+08:00' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('integrity mismatch'))
  })
})
