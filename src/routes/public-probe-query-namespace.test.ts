import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MapEnv } from './map-http-context'
import { readRouteCatalog } from './map-route-catalog'

const candidateVersion = '20260722T111540779Z'
const legacyPublicCaseId = 'pub_123456789abc'

const probeRepository = vi.hoisted(() => ({
  getAuthoritativeActiveSnapshotVersion: vi.fn(),
  getPinnedSnapshotRouteCatalog: vi.fn(),
}))
const repository = vi.hoisted(() => ({
  getActiveSnapshotVersion: vi.fn(),
  getSnapshotRouteCatalog: vi.fn(),
}))
const tdx = vi.hoisted(() => ({ getRouteCatalog: vi.fn() }))

vi.mock('../infrastructure/transit/snapshot-probe-repository', () => probeRepository)
vi.mock('../infrastructure/transit/snapshot-repository', () => repository)
vi.mock('../lib/tdx', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/tdx')>(),
  getRouteCatalog: tdx.getRouteCatalog,
}))

const bindings = {
  TDX_CLIENT_ID: 'shared-id',
  TDX_CLIENT_SECRET: 'shared-secret',
  TRANSIT_DB: {} as D1Database,
  TRANSIT_SHAPES: {} as R2Bucket,
  CF_VERSION_METADATA: {
    id: 'worker-version-id',
    tag: '0123456789abcdef0123456789abcdef01234567',
    timestamp: '2026-07-22T10:00:00.000Z',
  },
} as MapEnv['Bindings']

const routeCatalogItem = {
  routeUid: 'HSZ000701',
  routeName: '藍1區',
  departure: 'A',
  destination: 'B',
  category: 'city-bus',
}

function request(extraQuery = ''): Promise<Response> {
  const app = new Hono<MapEnv>()
  app.get('/api/v1/map/routes', readRouteCatalog)
  const suffix = extraQuery ? `&${extraQuery}` : ''
  return Promise.resolve(app.request(
    `https://bus.example/api/v1/map/routes?city=Hsinchu${suffix}`,
    {},
    bindings,
  ))
}

describe('public probe HTTP regression', () => {
  beforeEach(() => {
    Object.values(probeRepository).forEach((mock) => mock.mockReset())
    Object.values(repository).forEach((mock) => mock.mockReset())
    Object.values(tdx).forEach((mock) => mock.mockReset())
    repository.getSnapshotRouteCatalog.mockResolvedValue([routeCatalogItem])
    repository.getActiveSnapshotVersion.mockResolvedValue(candidateVersion)
  })

  it('serves the ordinary public URL from the active snapshot path', async () => {
    const response = await request()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      source: 'snapshot',
      snapshotVersion: candidateVersion,
      routes: [routeCatalogItem],
    })
    expect(repository.getSnapshotRouteCatalog).toHaveBeenCalledWith(bindings, 'Hsinchu')
    expect(repository.getActiveSnapshotVersion).toHaveBeenCalledWith(bindings, 'Hsinchu')
    expect(probeRepository.getAuthoritativeActiveSnapshotVersion).not.toHaveBeenCalled()
    expect(probeRepository.getPinnedSnapshotRouteCatalog).not.toHaveBeenCalled()
    expect(tdx.getRouteCatalog).not.toHaveBeenCalled()
  })

  it('still rejects a daily-shaped value in the publisher probe namespace', async () => {
    const response = await request(`probe=${legacyPublicCaseId}`)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: '指定快照目前不可用',
      code: 'INVALID_QUERY',
    })
    expect(repository.getSnapshotRouteCatalog).not.toHaveBeenCalled()
    expect(repository.getActiveSnapshotVersion).not.toHaveBeenCalled()
    expect(probeRepository.getAuthoritativeActiveSnapshotVersion).not.toHaveBeenCalled()
    expect(probeRepository.getPinnedSnapshotRouteCatalog).not.toHaveBeenCalled()
    expect(tdx.getRouteCatalog).not.toHaveBeenCalled()
  })
})
