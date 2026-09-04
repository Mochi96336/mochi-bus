import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetMemoryCacheForTests } from '../../lib/memory-cache'

const legacy = vi.hoisted(() => ({
  getActiveSnapshotVersion: vi.fn(),
  getDirectRoutes: vi.fn(),
}))

vi.mock('./snapshot-repository', async (importOriginal) => ({
  ...await importOriginal<typeof import('./snapshot-repository')>(),
  getActiveSnapshotVersion: legacy.getActiveSnapshotVersion,
  getDirectRoutes: legacy.getDirectRoutes,
}))

import { getDirectRoutes, type TransitBindings } from './snapshot-place-routing-repository'

type Pattern = {
  patternId: string
  routeUid: string
  routeName: string
  direction: 0 | 1 | 2
  label: string
  subRouteUid?: string
  subRouteName: string
  shapeKey: string
  circular: boolean
  minSequence: number
  maxSequence: number
}

type Occurrence = {
  patternId: string
  stopUid: string
  stopSequence: number
  stopName: string
}

function pattern(patternId: string, routeName: string, overrides: Partial<Pattern> = {}): Pattern {
  return {
    patternId,
    routeUid: `R-${patternId}`,
    routeName,
    direction: 0,
    label: `${routeName} 起點 → ${routeName} 終點`,
    subRouteUid: `SUB-${patternId}`,
    subRouteName: routeName,
    shapeKey: `shape/${patternId}.json`,
    circular: false,
    minSequence: 1,
    maxSequence: 5,
    ...overrides,
  }
}

function occurrence(patternId: string, sequence: number): Occurrence {
  return {
    patternId,
    stopUid: `S-${patternId}-${sequence}`,
    stopSequence: sequence,
    stopName: `Stop ${sequence}`,
  }
}

function artifact(placeId: string, patterns: Pattern[], occurrences: Occurrence[]) {
  return {
    schemaVersion: 1,
    kind: 'place-routing',
    city: 'Taichung',
    version: 'v1',
    place: { placeId, name: `Place ${placeId}`, latitude: 24.1, longitude: 120.6 },
    patterns,
    occurrences,
  }
}

function bucket({
  objects = {},
  throwKeys = [],
}: {
  objects?: Record<string, unknown>
  throwKeys?: string[]
} = {}) {
  const heads: string[] = []
  const reads: string[] = []
  const r2 = {
    async head(key: string) {
      heads.push(key)
      return {} as R2Object
    },
    async get(key: string) {
      reads.push(key)
      if (throwKeys.includes(key)) throw new Error('temporary R2 GET failure')
      if (!(key in objects)) return null
      return { json: async <T>() => objects[key] as T } as unknown as R2ObjectBody
    },
  } as unknown as R2Bucket
  return { r2, heads, reads }
}

function env(r2: R2Bucket): TransitBindings {
  return { TRANSIT_DB: {} as D1Database, TRANSIT_SHAPES: r2 }
}

beforeEach(() => {
  resetMemoryCacheForTests()
  Object.values(legacy).forEach((mock) => mock.mockReset())
  legacy.getActiveSnapshotVersion.mockResolvedValue('v1')
})

describe('R2-first direct routes', () => {
  it('keeps forward routes, allows circular seam crossings, and rejects open reverse routes', async () => {
    const forward = pattern('forward', 'Forward')
    const loop = pattern('loop', 'Loop', { circular: true })
    const open = pattern('open', 'Not loop')
    const fromKey = 'snapshots/v1/cities/Taichung/routing/places/from.json'
    const toKey = 'snapshots/v1/cities/Taichung/routing/places/to.json'
    const r2 = bucket({
      objects: {
        [fromKey]: artifact('from', [forward, loop, open], [
          occurrence('forward', 1), occurrence('loop', 4), occurrence('open', 4),
        ]),
        [toKey]: artifact('to', [forward, loop, open], [
          occurrence('forward', 3), occurrence('loop', 2), occurrence('open', 2),
        ]),
      },
    })

    const routes = await getDirectRoutes(env(r2.r2), 'Taichung', 'from', 'to')

    expect(legacy.getDirectRoutes).not.toHaveBeenCalled()
    expect(r2.heads).toEqual(['snapshots/v1/cities/Taichung/place-routing-export.json'])
    expect(r2.reads.sort()).toEqual([fromKey, toKey].sort())
    expect(routes.map((route) => route.routeName)).toEqual(['Forward', 'Loop'])
    expect(routes[0]).toMatchObject({
      variantKey: 'forward', boardSequence: 1, alightSequence: 3, stopCount: 2,
    })
    expect(routes[1]).toMatchObject({
      variantKey: 'loop', boardSequence: 4, alightSequence: 2, stopCount: 3,
    })
  })

  it('evaluates all repeated occurrence pairs and keeps the shortest one', async () => {
    const loop = pattern('loop', 'Loop', { circular: true })
    const fromKey = 'snapshots/v1/cities/Taichung/routing/places/from.json'
    const toKey = 'snapshots/v1/cities/Taichung/routing/places/to.json'
    const r2 = bucket({
      objects: {
        [fromKey]: artifact('from', [loop], [occurrence('loop', 1), occurrence('loop', 4)]),
        [toKey]: artifact('to', [loop], [occurrence('loop', 5), occurrence('loop', 2)]),
      },
    })

    const routes = await getDirectRoutes(env(r2.r2), 'Taichung', 'from', 'to')

    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({ boardSequence: 1, alightSequence: 2, stopCount: 1 })
  })

  it('falls back as one complete operation when either endpoint artifact is missing', async () => {
    const fallback = [{ variantKey: 'legacy', stopCount: 4 }]
    legacy.getDirectRoutes.mockResolvedValue(fallback)
    const shared = pattern('P1', '1')
    const fromKey = 'snapshots/v1/cities/Taichung/routing/places/from.json'
    const r2 = bucket({
      objects: {
        [fromKey]: artifact('from', [shared], [occurrence('P1', 1)]),
      },
    })
    const bindings = env(r2.r2)

    await expect(getDirectRoutes(bindings, 'Taichung', 'from', 'to')).resolves.toBe(fallback)
    expect(legacy.getDirectRoutes).toHaveBeenCalledWith(bindings, 'Taichung', 'from', 'to')
  })

  it('falls back when a place artifact GET fails transiently', async () => {
    const fallback = [{ variantKey: 'legacy', stopCount: 4 }]
    legacy.getDirectRoutes.mockResolvedValue(fallback)
    const shared = pattern('P1', '1')
    const fromKey = 'snapshots/v1/cities/Taichung/routing/places/from.json'
    const toKey = 'snapshots/v1/cities/Taichung/routing/places/to.json'
    const r2 = bucket({
      objects: {
        [fromKey]: artifact('from', [shared], [occurrence('P1', 1)]),
        [toKey]: artifact('to', [shared], [occurrence('P1', 3)]),
      },
      throwKeys: [toKey],
    })
    const bindings = env(r2.r2)

    await expect(getDirectRoutes(bindings, 'Taichung', 'from', 'to')).resolves.toBe(fallback)
    expect(legacy.getDirectRoutes).toHaveBeenCalledTimes(1)
  })

  it('falls back when common-pattern metadata disagrees between endpoint artifacts', async () => {
    const fallback = [{ variantKey: 'legacy', stopCount: 4 }]
    legacy.getDirectRoutes.mockResolvedValue(fallback)
    const fromPattern = pattern('P1', '1')
    const toPattern = pattern('P1', 'DIFFERENT')
    const fromKey = 'snapshots/v1/cities/Taichung/routing/places/from.json'
    const toKey = 'snapshots/v1/cities/Taichung/routing/places/to.json'
    const r2 = bucket({
      objects: {
        [fromKey]: artifact('from', [fromPattern], [occurrence('P1', 1)]),
        [toKey]: artifact('to', [toPattern], [occurrence('P1', 3)]),
      },
    })
    const bindings = env(r2.r2)

    await expect(getDirectRoutes(bindings, 'Taichung', 'from', 'to')).resolves.toBe(fallback)
    expect(legacy.getDirectRoutes).toHaveBeenCalledTimes(1)
  })

  it('returns an empty R2 result without falling back when the places share no pattern', async () => {
    const p1 = pattern('P1', '1')
    const p2 = pattern('P2', '2')
    const fromKey = 'snapshots/v1/cities/Taichung/routing/places/from.json'
    const toKey = 'snapshots/v1/cities/Taichung/routing/places/to.json'
    const r2 = bucket({
      objects: {
        [fromKey]: artifact('from', [p1], [occurrence('P1', 1)]),
        [toKey]: artifact('to', [p2], [occurrence('P2', 3)]),
      },
    })

    await expect(getDirectRoutes(env(r2.r2), 'Taichung', 'from', 'to')).resolves.toEqual([])
    expect(legacy.getDirectRoutes).not.toHaveBeenCalled()
  })

  it('returns no route for identical places without reading R2 artifacts', async () => {
    const r2 = bucket()

    await expect(getDirectRoutes(env(r2.r2), 'Taichung', 'same', 'same')).resolves.toEqual([])
    expect(r2.heads).toEqual([])
    expect(r2.reads).toEqual([])
  })

  it('uses the legacy function when snapshot bindings are absent', async () => {
    const fallback = [{ variantKey: 'legacy-direct' }]
    legacy.getDirectRoutes.mockResolvedValue(fallback)
    const partial = {} as TransitBindings

    await expect(getDirectRoutes(partial, 'Taichung', 'A', 'B')).resolves.toBe(fallback)
    expect(legacy.getActiveSnapshotVersion).not.toHaveBeenCalled()
  })
})
