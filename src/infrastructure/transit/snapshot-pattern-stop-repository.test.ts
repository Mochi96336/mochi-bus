import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetMemoryCacheForTests } from '../../lib/memory-cache'

const legacy = vi.hoisted(() => ({
  getActiveSnapshotVersion: vi.fn(),
  getSnapshotRouteVariants: vi.fn(),
  getJourneyLegStopRefs: vi.fn(),
}))

vi.mock('./snapshot-repository', async (importOriginal) => ({
  ...await importOriginal<typeof import('./snapshot-repository')>(),
  getActiveSnapshotVersion: legacy.getActiveSnapshotVersion,
  getSnapshotRouteVariants: legacy.getSnapshotRouteVariants,
  getJourneyLegStopRefs: legacy.getJourneyLegStopRefs,
}))

import {
  getJourneyLegStopRefs,
  getSnapshotRouteVariants,
  type TransitBindings,
} from './snapshot-pattern-stop-repository'

const meta = {
  duration: 0,
  size_after: 0,
  rows_read: 0,
  rows_written: 0,
  last_row_id: 0,
  changed_db: false,
  changes: 0,
}

function result<T>(rows: T[]): D1Result<T> {
  return { success: true, meta, results: rows }
}

function artifact(patternId = 'P1') {
  return {
    schemaVersion: 1,
    city: 'Taichung',
    version: 'v1',
    patternId,
    stops: [
      { stopUid: 'S1', placeId: 'A', stopSequence: 1, name: 'Alpha', latitude: 24.1, longitude: 120.6 },
      { stopUid: 'S2', placeId: 'B', stopSequence: 2, name: 'Beta', latitude: 24.2, longitude: 120.7 },
    ],
  }
}

const shape = {
  type: 'Feature' as const,
  properties: {},
  geometry: {
    type: 'LineString' as const,
    coordinates: [[120.6, 24.1], [120.7, 24.2]] as [number, number][],
  },
}

function databaseFor(rowsForQuery: (query: string) => unknown[]) {
  const queries: string[] = []
  const bindings: unknown[][] = []
  const database = {
    prepare(query: string) {
      queries.push(query)
      const statement = {
        bind: (...values: unknown[]) => {
          bindings.push(values)
          return statement
        },
        all: async <T>() => result(rowsForQuery(query) as T[]),
      } as D1PreparedStatement
      return statement
    },
  } as D1Database
  return { database, queries, bindings }
}

function bucket({
  manifest = true,
  missingArtifact = false,
  throwArtifact = false,
  throwHead = false,
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
      if (key.endsWith('/patterns/P1/stops.json')) {
        if (throwArtifact) throw new Error('temporary R2 failure')
        if (missingArtifact) return null
        return { json: async <T>() => artifact() as T } as unknown as R2ObjectBody
      }
      if (key === 'shape/P1.json') {
        return { json: async <T>() => shape as T } as unknown as R2ObjectBody
      }
      return null
    },
  } as unknown as R2Bucket
  return { r2, heads, reads }
}

beforeEach(() => {
  resetMemoryCacheForTests()
  Object.values(legacy).forEach((mock) => mock.mockReset())
  legacy.getActiveSnapshotVersion.mockResolvedValue('v1')
})

describe('R2-first snapshot route variants', () => {
  it('uses exported pattern stops without querying the D1 high-cardinality tables', async () => {
    const pattern = {
      pattern_id: 'P1',
      route_uid: 'R1',
      subroute_uid: 'SUB1',
      route_name: '300',
      subroute_name: '300',
      direction: 0 as const,
      departure_name: 'Alpha',
      destination_name: 'Beta',
      shape_key: 'shape/P1.json',
      updated_at: null,
    }
    const db = databaseFor(() => [pattern])
    const r2 = bucket()
    const env: TransitBindings = { TRANSIT_DB: db.database, TRANSIT_SHAPES: r2.r2 }

    const variants = await getSnapshotRouteVariants(env, 'Taichung', '300')

    expect(legacy.getSnapshotRouteVariants).not.toHaveBeenCalled()
    expect(db.queries).toHaveLength(1)
    expect(db.queries[0]).toContain('FROM patterns p')
    expect(db.queries[0]).not.toContain('pattern_stops')
    expect(db.bindings[0]).toEqual(['v1', 'Taichung', '300'])
    expect(r2.heads).toEqual(['snapshots/v1/cities/Taichung/pattern-stops-export.json'])
    expect(r2.reads).toEqual(expect.arrayContaining([
      'snapshots/v1/cities/Taichung/patterns/P1/stops.json',
      'shape/P1.json',
    ]))
    expect(variants).toHaveLength(1)
    expect(variants[0]).toMatchObject({
      variantKey: 'P1',
      routeUid: 'R1',
      subRouteUid: 'SUB1',
      stops: {
        features: [
          { properties: { stopUid: 'S1', stopName: 'Alpha', sequence: 1 } },
          { properties: { stopUid: 'S2', stopName: 'Beta', sequence: 2 } },
        ],
      },
    })
  })

  it('keeps cities without a completed export entirely on the legacy D1 path', async () => {
    const fallback = [{ variantKey: 'legacy' }]
    legacy.getSnapshotRouteVariants.mockResolvedValue(fallback)
    const db = databaseFor(() => { throw new Error('metadata query must not run') })
    const r2 = bucket({ manifest: false })
    const env: TransitBindings = { TRANSIT_DB: db.database, TRANSIT_SHAPES: r2.r2 }

    await expect(getSnapshotRouteVariants(env, 'Taichung', '300')).resolves.toBe(fallback)
    expect(legacy.getSnapshotRouteVariants).toHaveBeenCalledWith(env, 'Taichung', '300')
    expect(db.queries).toEqual([])
    expect(r2.reads).toEqual([])
  })

  it('caches a missing export manifest within the 60-second gate window', async () => {
    const fallback = [{ variantKey: 'legacy' }]
    legacy.getSnapshotRouteVariants.mockResolvedValue(fallback)
    const db = databaseFor(() => { throw new Error('metadata query must not run') })
    const r2 = bucket({ manifest: false })
    const env: TransitBindings = { TRANSIT_DB: db.database, TRANSIT_SHAPES: r2.r2 }

    await getSnapshotRouteVariants(env, 'Taichung', '300')
    await getSnapshotRouteVariants(env, 'Taichung', '300')

    expect(r2.heads).toEqual(['snapshots/v1/cities/Taichung/pattern-stops-export.json'])
    expect(legacy.getSnapshotRouteVariants).toHaveBeenCalledTimes(2)
    expect(db.queries).toEqual([])
  })

  it('does not cache a transient export-manifest HEAD failure', async () => {
    const fallback = [{ variantKey: 'legacy' }]
    legacy.getSnapshotRouteVariants.mockResolvedValue(fallback)
    const db = databaseFor(() => { throw new Error('metadata query must not run') })
    const r2 = bucket({ throwHead: true })
    const env: TransitBindings = { TRANSIT_DB: db.database, TRANSIT_SHAPES: r2.r2 }

    await getSnapshotRouteVariants(env, 'Taichung', '300')
    await getSnapshotRouteVariants(env, 'Taichung', '300')

    expect(r2.heads).toEqual([
      'snapshots/v1/cities/Taichung/pattern-stops-export.json',
      'snapshots/v1/cities/Taichung/pattern-stops-export.json',
    ])
    expect(legacy.getSnapshotRouteVariants).toHaveBeenCalledTimes(2)
    expect(db.queries).toEqual([])
  })
})

describe('R2-first journey stop refs', () => {
  it('reads stop UID by sequence from R2 and leaves only low-cardinality metadata in D1', async () => {
    const metadata = {
      pattern_id: 'P1',
      route_uid: 'R1',
      subroute_uid: 'SUB1',
      direction: 0 as const,
      route_name: '300',
    }
    const db = databaseFor(() => [metadata])
    const r2 = bucket()
    const env: TransitBindings = { TRANSIT_DB: db.database, TRANSIT_SHAPES: r2.r2 }
    const legs = [
      { key: 'a', patternId: 'P1', sequence: 1 },
      { key: 'b', patternId: 'P1', sequence: 2 },
    ]

    const refs = await getJourneyLegStopRefs(env, 'Taichung', legs)

    expect(legacy.getJourneyLegStopRefs).not.toHaveBeenCalled()
    expect(db.queries).toHaveLength(1)
    expect(db.queries[0]).toContain('p.pattern_id IN (?)')
    expect(db.queries[0]).not.toContain('pattern_stops')
    expect(db.bindings[0]).toEqual(['v1', 'Taichung', 'P1'])
    expect(r2.reads).toEqual(['snapshots/v1/cities/Taichung/patterns/P1/stops.json'])
    expect(refs).toEqual([
      {
        key: 'a', patternId: 'P1', routeUid: 'R1', subRouteUid: 'SUB1',
        direction: 0, routeName: '300', stopUid: 'S1',
      },
      {
        key: 'b', patternId: 'P1', routeUid: 'R1', subRouteUid: 'SUB1',
        direction: 0, routeName: '300', stopUid: 'S2',
      },
    ])
  })

  it('falls back as one complete operation when a manifest-approved artifact is missing', async () => {
    const fallback = [{ key: 'legacy', patternId: 'P1', routeUid: 'R1', direction: 0, routeName: '300', stopUid: 'S1' }]
    legacy.getJourneyLegStopRefs.mockResolvedValue(fallback)
    const db = databaseFor(() => { throw new Error('metadata query must not run') })
    const r2 = bucket({ missingArtifact: true })
    const env: TransitBindings = { TRANSIT_DB: db.database, TRANSIT_SHAPES: r2.r2 }
    const legs = [{ key: 'a', patternId: 'P1', sequence: 1 }]

    await expect(getJourneyLegStopRefs(env, 'Taichung', legs)).resolves.toBe(fallback)
    expect(legacy.getJourneyLegStopRefs).toHaveBeenCalledWith(env, 'Taichung', legs)
    expect(db.queries).toEqual([])
  })

  it('falls back to D1 when an artifact R2 read fails transiently', async () => {
    const fallback = [{ key: 'legacy', patternId: 'P1', routeUid: 'R1', direction: 0, routeName: '300', stopUid: 'S1' }]
    legacy.getJourneyLegStopRefs.mockResolvedValue(fallback)
    const db = databaseFor(() => { throw new Error('metadata query must not run') })
    const r2 = bucket({ throwArtifact: true })
    const env: TransitBindings = { TRANSIT_DB: db.database, TRANSIT_SHAPES: r2.r2 }
    const legs = [{ key: 'a', patternId: 'P1', sequence: 1 }]

    await expect(getJourneyLegStopRefs(env, 'Taichung', legs)).resolves.toBe(fallback)
    expect(legacy.getJourneyLegStopRefs).toHaveBeenCalledWith(env, 'Taichung', legs)
    expect(db.queries).toEqual([])
  })
})
