import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCityFetchCache } from './city-fetch-cache.mjs'
import { createCitySourceCache } from './city-source-cache.mjs'
import { createIntercityFetchCache } from './intercity-fetch-cache.mjs'

const roots = []
const cityRouteUrl = 'https://tdx.transportdata.tw/api/basic/v2/Bus/Route/City/Taipei?$format=JSON'
const intercityRouteUrl = 'https://tdx.transportdata.tw/api/basic/v2/Bus/Route/InterCity?$format=JSON'

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function parsedLogs(logger) {
  return logger.log.mock.calls.flatMap(([value]) => {
    try {
      return [JSON.parse(value)]
    } catch {
      return []
    }
  })
}

describe('snapshot TDX quota observability', () => {
  it('records every successful UpdateTime probe with its exact response bytes', async () => {
    const payload = JSON.stringify([{ UpdateTime: '2026-09-08T00:00:00+08:00' }])
    const bytes = Buffer.byteLength(payload)
    const logger = { log: vi.fn(), warn: vi.fn() }
    const cache = createCitySourceCache({
      city: 'Taipei',
      fetchImpl: vi.fn(async () => new Response(payload, {
        headers: { 'Content-Length': String(bytes) },
      })),
      storage: { getJson: vi.fn(async () => null) },
      logger,
    })

    await expect(cache.resolve({ resource: 'Route', input: cityRouteUrl, init: {} }))
      .resolves.toEqual({ body: null, sourceVersion: '2026-09-08T00:00:00+08:00' })

    expect(parsedLogs(logger)).toContainEqual({
      event: 'tdx_city_persistent_cache',
      resource: 'Route',
      resolution: 'probe',
      sourceVersion: '2026-09-08T00:00:00+08:00',
      result: 'success',
      status: 200,
      bytes,
    })
  })

  it('records exact projected bytes for a City full-source cache miss', async () => {
    const body = JSON.stringify([{ RouteUID: 'TPE1', RouteName: { Zh_tw: '1' } }])
    const logger = { log: vi.fn(), warn: vi.fn() }
    const persistent = {
      resolve: vi.fn(async () => ({ body: null, sourceVersion: 'v2' })),
      stage: vi.fn(async () => null),
    }
    const fetcher = createCityFetchCache({
      fetchImpl: vi.fn(async () => new Response(body)),
      persistentForCity: () => persistent,
      logger,
    })

    await expect((await fetcher(cityRouteUrl)).json()).resolves.toEqual(JSON.parse(body))
    expect(parsedLogs(logger)).toContainEqual({
      event: 'tdx_city_cache',
      city: 'Taipei',
      resource: 'Route',
      resolution: 'miss',
      sourceVersion: 'v2',
      status: 200,
      bytes: Buffer.byteLength(body),
    })
  })

  it('records exact projected bytes for the first InterCity full-source miss in a run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mochi-tdx-usage-'))
    roots.push(root)
    const body = JSON.stringify([{ RouteUID: 'THB1', RouteName: { Zh_tw: '1' } }])
    const logger = { log: vi.fn(), warn: vi.fn() }
    const persistent = {
      resolve: vi.fn(async () => ({ body: null, sourceVersion: 'v3' })),
      stage: vi.fn(async () => null),
    }
    const fetcher = createIntercityFetchCache({
      fetchImpl: vi.fn(async () => new Response(body)),
      root,
      scope: 'test-run',
      persistent,
      logger,
    })

    await expect((await fetcher(intercityRouteUrl)).json()).resolves.toEqual(JSON.parse(body))
    expect(parsedLogs(logger)).toContainEqual({
      event: 'tdx_intercity_cache',
      resource: 'Route',
      resolution: 'miss',
      sourceVersion: 'v3',
      status: 200,
      bytes: Buffer.byteLength(body),
    })
  })
})
