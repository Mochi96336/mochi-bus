import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetMemoryCacheForTests } from '../../lib/memory-cache'

const legacy = vi.hoisted(() => ({
  getActiveSnapshotVersion: vi.fn(),
  getStopPlaceRoutes: vi.fn(),
  getDirectRoutes: vi.fn(),
}))

vi.mock('./snapshot-repository', async (importOriginal) => ({
  ...await importOriginal<typeof import('./snapshot-repository')>(),
  getActiveSnapshotVersion: legacy.getActiveSnapshotVersion,
  getStopPlaceRoutes: legacy.getStopPlaceRoutes,
  getDirectRoutes: legacy.getDirectRoutes,
}))

import {
  getDirectRoutes,
  getStopPlaceRoutes,
  type PlaceRoutingFallbackObserver,
  type TransitBindings,
} from './snapshot-place-routing-repository'

const manifestKey = 'snapshots/v1/cities/Taichung/place-routing-export.json'
const placeKey = (placeId: string) => `snapshots/v1/cities/Taichung/routing/places/${placeId}.json`

function artifact(placeId: string, routeName = '1') {
  return {
    schemaVersion: 1,
    kind: 'place-routing',
    city: 'Taichung',
    version: 'v1',
    place: { placeId, name: `Place ${placeId}`, latitude: 24.1, longitude: 120.6 },
    patterns: [{
      patternId: 'P1',
      routeUid: 'R1',
      routeName,
      direction: 0,
      label: '1 起點 → 1 終點',
      subRouteUid: 'SUB-P1',
      subRouteName: routeName,
      shapeKey: 'shape/P1.json',
      circular: false,
      minSequence: 1,
      maxSequence: 5,
    }],
    occurrences: [{
      patternId: 'P1',
      stopUid: `S-${placeId}`,
      stopSequence: placeId === 'from' ? 1 : 3,
      stopName: `Stop ${placeId}`,
    }],
  }
}

type GetHandler = () => Promise<R2ObjectBody | null>

function bucket({
  manifest = true,
  throwHead = false,
  objects = {},
  throwGet = false,
  getHandlers = {},
}: {
  manifest?: boolean
  throwHead?: boolean
  objects?: Record<string, unknown>
  throwGet?: boolean
  getHandlers?: Record<string, GetHandler>
} = {}) {
  const r2 = {
    async head(key: string) {
      expect(key).toBe(manifestKey)
      if (throwHead) throw new Error('temporary R2 HEAD failure')
      return manifest ? {} as R2Object : null
    },
    async get(key: string) {
      const handler = getHandlers[key]
      if (handler) return handler()
      if (throwGet) throw new Error('temporary R2 GET failure')
      if (!(key in objects)) return null
      return { json: async <T>() => objects[key] as T } as unknown as R2ObjectBody
    },
  } as unknown as R2Bucket
  return r2
}

function env(r2: R2Bucket): TransitBindings {
  return { TRANSIT_DB: {} as D1Database, TRANSIT_SHAPES: r2 }
}

function observer() {
  return vi.fn<PlaceRoutingFallbackObserver>()
}

beforeEach(() => {
  resetMemoryCacheForTests()
  Object.values(legacy).forEach((mock) => mock.mockReset())
  legacy.getActiveSnapshotVersion.mockResolvedValue('v1')
  legacy.getStopPlaceRoutes.mockResolvedValue([{ variantKey: 'legacy' }])
  legacy.getDirectRoutes.mockResolvedValue([{ variantKey: 'legacy', stopCount: 2 }])
})

describe('place-routing fallback telemetry contract', () => {
  it('classifies a missing completion manifest', async () => {
    const observe = observer()

    await getStopPlaceRoutes(env(bucket({ manifest: false })), 'Taichung', 'A', observe)

    expect(observe).toHaveBeenCalledOnce()
    expect(observe).toHaveBeenCalledWith({
      city: 'Taichung', snapshotVersion: 'v1', reason: 'manifest_missing',
    })
  })

  it('classifies a transient manifest read failure without caching it as missing', async () => {
    const observe = observer()

    await getStopPlaceRoutes(env(bucket({ throwHead: true })), 'Taichung', 'A', observe)

    expect(observe).toHaveBeenCalledWith({
      city: 'Taichung', snapshotVersion: 'v1', reason: 'manifest_read_failed',
    })
  })

  it('classifies an absent manifest-approved place artifact as incomplete authority', async () => {
    const observe = observer()

    await getStopPlaceRoutes(env(bucket()), 'Taichung', 'A', observe)

    expect(observe).toHaveBeenCalledWith({
      city: 'Taichung', snapshotVersion: 'v1', reason: 'routing_authority_incomplete',
    })
  })

  it('classifies malformed place-routing payloads as invalid authority', async () => {
    const observe = observer()
    const invalid = artifact('WRONG')

    await getStopPlaceRoutes(env(bucket({ objects: { [placeKey('A')]: invalid } })), 'Taichung', 'A', observe)

    expect(observe).toHaveBeenCalledWith({
      city: 'Taichung', snapshotVersion: 'v1', reason: 'routing_authority_invalid',
    })
  })

  it('classifies invalid JSON in an existing place-routing object as invalid authority', async () => {
    const observe = observer()
    const invalidJson = {
      json: async () => {
        throw new SyntaxError('Unexpected token')
      },
    } as unknown as R2ObjectBody

    await getStopPlaceRoutes(env(bucket({
      getHandlers: { [placeKey('A')]: async () => invalidJson },
    })), 'Taichung', 'A', observe)

    expect(observe).toHaveBeenCalledWith({
      city: 'Taichung', snapshotVersion: 'v1', reason: 'routing_authority_invalid',
    })
  })

  it('classifies an R2 GET exception as r2', async () => {
    const observe = observer()

    await getStopPlaceRoutes(env(bucket({ throwGet: true })), 'Taichung', 'A', observe)

    expect(observe).toHaveBeenCalledWith({
      city: 'Taichung', snapshotVersion: 'v1', reason: 'r2',
    })
  })

  it('uses deterministic authority-first attribution when direct endpoint reads fail differently', async () => {
    const observe = observer()
    const r2 = bucket({
      getHandlers: {
        [placeKey('from')]: async () => {
          throw new Error('temporary R2 GET failure')
        },
        [placeKey('to')]: async () => {
          await Promise.resolve()
          await Promise.resolve()
          return null
        },
      },
    })

    await getDirectRoutes(env(r2), 'Taichung', 'from', 'to', observe)

    expect(observe).toHaveBeenCalledOnce()
    expect(observe).toHaveBeenCalledWith({
      city: 'Taichung', snapshotVersion: 'v1', reason: 'routing_authority_incomplete',
    })
  })

  it('reports direct-route metadata disagreement only once for the whole repository call', async () => {
    const observe = observer()
    const r2 = bucket({
      objects: {
        [placeKey('from')]: artifact('from', '1'),
        [placeKey('to')]: artifact('to', 'DIFFERENT'),
      },
    })

    await getDirectRoutes(env(r2), 'Taichung', 'from', 'to', observe)

    expect(observe).toHaveBeenCalledOnce()
    expect(observe).toHaveBeenCalledWith({
      city: 'Taichung', snapshotVersion: 'v1', reason: 'routing_authority_invalid',
    })
  })

  it('keeps observer failures from changing the compatibility fallback result', async () => {
    const fallback = [{ variantKey: 'legacy' }]
    legacy.getStopPlaceRoutes.mockResolvedValue(fallback)
    const observe: PlaceRoutingFallbackObserver = () => {
      throw new Error('telemetry unavailable')
    }

    await expect(getStopPlaceRoutes(
      env(bucket({ manifest: false })), 'Taichung', 'A', observe,
    )).resolves.toBe(fallback)
    expect(legacy.getStopPlaceRoutes).toHaveBeenCalledOnce()
  })
})
