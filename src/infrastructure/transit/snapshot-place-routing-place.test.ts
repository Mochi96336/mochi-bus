import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetMemoryCacheForTests } from '../../lib/memory-cache'

const legacy = vi.hoisted(() => ({
  getActiveSnapshotVersion: vi.fn(),
  getStopPlaceRoutes: vi.fn(),
}))

vi.mock('./snapshot-repository', async (importOriginal) => ({
  ...await importOriginal<typeof import('./snapshot-repository')>(),
  getActiveSnapshotVersion: legacy.getActiveSnapshotVersion,
  getStopPlaceRoutes: legacy.getStopPlaceRoutes,
}))

import { getStopPlaceRoutes, type TransitBindings } from './snapshot-place-routing-repository'

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

function occurrence(patternId: string, sequence: number, suffix = ''): Occurrence {
  return {
    patternId,
    stopUid: `S-${patternId}-${sequence}${suffix}`,
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
  manifest = true,
  objects = {},
  throwHead = false,
}: {
  manifest?: boolean
  objects?: Record<string, unknown>
  throwHead?: boolean
} = {}) {
  const heads: string[] = []
  const reads: string[] = []
  const r2 = {
    async head(key: string) {
      heads.push(key)
      if (throwHead) throw new Error('temporary R2 HEAD failure')
      return manifest ? {} as R2Object : null
    },
    async get(key: string) {
      reads.push(key)
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

describe('R2-first stop-place routes', () => {
  it('returns every exported occurrence without invoking the legacy high-cardinality path', async () => {
    const p10 = pattern('P10', '10')
    const p20 = pattern('P20', '20', { direction: 1 })
    const key = 'snapshots/v1/cities/Taichung/routing/places/A.json'
    const r2 = bucket({
      objects: {
        [key]: artifact('A', [p20, p10], [
          occurrence('P20', 3),
          occurrence('P10', 4, '-repeat'),
          occurrence('P10', 1),
        ]),
      },
    })

    const routes = await getStopPlaceRoutes(env(r2.r2), 'Taichung', 'A')

    expect(legacy.getStopPlaceRoutes).not.toHaveBeenCalled()
    expect(r2.heads).toEqual(['snapshots/v1/cities/Taichung/place-routing-export.json'])
    expect(r2.reads).toEqual([key])
    expect(routes.map((route) => [route.routeName, route.variantKey, route.stopSequence])).toEqual([
      ['10', 'P10', 4],
      ['10', 'P10', 1],
      ['20', 'P20', 3],
    ])
    expect(routes[0]).toMatchObject({
      routeUid: 'R-P10', direction: 0, label: '10 起點 → 10 終點',
      subRouteUid: 'SUB-P10', subRouteName: '10', stopUid: 'S-P10-4-repeat', stopName: 'Stop 4',
    })
  })

  it('keeps a missing manifest on the complete legacy path and caches the miss', async () => {
    const fallback = [{ variantKey: 'legacy' }]
    legacy.getStopPlaceRoutes.mockResolvedValue(fallback)
    const r2 = bucket({ manifest: false })
    const bindings = env(r2.r2)

    await expect(getStopPlaceRoutes(bindings, 'Taichung', 'A')).resolves.toBe(fallback)
    await expect(getStopPlaceRoutes(bindings, 'Taichung', 'A')).resolves.toBe(fallback)

    expect(r2.heads).toEqual(['snapshots/v1/cities/Taichung/place-routing-export.json'])
    expect(r2.reads).toEqual([])
    expect(legacy.getStopPlaceRoutes).toHaveBeenCalledTimes(2)
  })

  it('does not cache a transient manifest HEAD failure', async () => {
    const fallback = [{ variantKey: 'legacy' }]
    legacy.getStopPlaceRoutes.mockResolvedValue(fallback)
    const r2 = bucket({ throwHead: true })
    const bindings = env(r2.r2)

    await getStopPlaceRoutes(bindings, 'Taichung', 'A')
    await getStopPlaceRoutes(bindings, 'Taichung', 'A')

    expect(r2.heads).toEqual([
      'snapshots/v1/cities/Taichung/place-routing-export.json',
      'snapshots/v1/cities/Taichung/place-routing-export.json',
    ])
    expect(legacy.getStopPlaceRoutes).toHaveBeenCalledTimes(2)
  })

  it('falls back when the manifest-approved artifact is malformed', async () => {
    const fallback = [{ variantKey: 'legacy' }]
    legacy.getStopPlaceRoutes.mockResolvedValue(fallback)
    const key = 'snapshots/v1/cities/Taichung/routing/places/A.json'
    const r2 = bucket({
      objects: {
        [key]: artifact('WRONG', [pattern('P1', '1')], [occurrence('P1', 1)]),
      },
    })
    const bindings = env(r2.r2)

    await expect(getStopPlaceRoutes(bindings, 'Taichung', 'A')).resolves.toBe(fallback)
    expect(legacy.getStopPlaceRoutes).toHaveBeenCalledWith(bindings, 'Taichung', 'A')
  })

  it('uses the legacy function when snapshot bindings are absent', async () => {
    const fallback = [{ variantKey: 'legacy' }]
    legacy.getStopPlaceRoutes.mockResolvedValue(fallback)
    const partial = {} as TransitBindings

    await expect(getStopPlaceRoutes(partial, 'Taichung', 'A')).resolves.toBe(fallback)
    expect(legacy.getActiveSnapshotVersion).not.toHaveBeenCalled()
  })
})
