import { beforeEach, describe, expect, it } from 'vitest'
import { resetMemoryCacheForTests } from '../../lib/memory-cache'
import {
  getDirectRoutes,
  getJourneyLegStopRefs,
  getOneTransferRoutes,
  getSnapshotRouteVariants,
  getStopPlaceByStopUid,
  getStopPlaceRoutes,
  searchStopPlaces,
  type TransitBindings,
} from './snapshot-repository'

const city = 'Taichung'
const version = 'v1'
const rootKey = `snapshots/${version}/cities/${city}/manifest.json`
const routingKeys = [
  `snapshots/${version}/cities/${city}/pattern-stops-export.json`,
  `snapshots/${version}/cities/${city}/place-routing-export.json`,
  `snapshots/${version}/cities/${city}/transfer-routing-export.json`,
  `snapshots/${version}/cities/${city}/stop-lookup-export.json`,
]

const meta = {
  duration: 0,
  size_after: 0,
  rows_read: 0,
  rows_written: 0,
  last_row_id: 0,
  changed_db: false,
  changes: 0,
}

function database({ allowHighCard = false } = {}) {
  const queries: string[] = []
  const db = {
    prepare(query: string) {
      queries.push(query)
      const statement = {
        bind: () => statement,
        first: async <T>() => {
          if (query.includes('SELECT active_version FROM dataset_versions')) {
            return { active_version: version } as T
          }
          if (!allowHighCard) throw new Error(`unexpected D1 first(): ${query}`)
          return null
        },
        all: async <T>() => {
          if (!allowHighCard) throw new Error(`unexpected D1 all(): ${query}`)
          return { success: true, meta, results: [] } as D1Result<T>
        },
      } as unknown as D1PreparedStatement
      return statement
    },
    async batch<T>() {
      if (!allowHighCard) throw new Error('unexpected D1 batch()')
      return [] as D1Result<T>[]
    },
  } as unknown as D1Database
  return { db, queries }
}

function bucket(mode: 'root-bound' | 'legacy' | 'partial' | 'missing' | 'error') {
  const reads: string[] = []
  const bucket = {
    async get(key: string) {
      reads.push(key)
      if (key !== rootKey) throw new Error(`unexpected R2 read: ${key}`)
      if (mode === 'error') throw new Error('temporary R2 outage')
      if (mode === 'missing') return null
      const bound = mode === 'root-bound'
        ? routingKeys
        : mode === 'partial'
          ? routingKeys.slice(0, 1)
          : []
      return {
        json: async <T>() => ({
          schemaVersion: 2,
          city,
          version,
          artifacts: bound.map((key, index) => ({
            key,
            bytes: 100 + index,
            sha256: String(index + 1).repeat(64),
          })),
        }) as T,
      } as unknown as R2ObjectBody
    },
    async head() {
      return null
    },
  } as unknown as R2Bucket
  return { bucket, reads }
}

function highCardCalls(env: TransitBindings) {
  return [
    () => getSnapshotRouteVariants(env, city, '300'),
    () => searchStopPlaces(env, city, 'Alpha'),
    () => getStopPlaceByStopUid(env, city, 'S1'),
    () => getStopPlaceRoutes(env, city, 'A'),
    () => getDirectRoutes(env, city, 'A', 'B'),
    () => getOneTransferRoutes(env, city, 'A', 'B'),
    () => getJourneyLegStopRefs(env, city, [{ key: 'leg', patternId: 'P1', sequence: 1 }]),
  ]
}

beforeEach(() => resetMemoryCacheForTests())

describe('legacy high-cardinality D1 authority guard', () => {
  it('fails all legacy high-cardinality reads closed for a root-bound snapshot', async () => {
    const d1 = database()
    const r2 = bucket('root-bound')
    const env: TransitBindings = { TRANSIT_DB: d1.db, TRANSIT_SHAPES: r2.bucket }

    for (const call of highCardCalls(env)) {
      await expect(call()).rejects.toThrow(
        'Root-bound routing authority forbids legacy high-cardinality D1 fallback',
      )
    }

    expect(d1.queries).toEqual(['SELECT active_version FROM dataset_versions WHERE city_code = ?'])
    expect(r2.reads).toEqual([rootKey])
  })

  it('keeps explicit legacy-backfill snapshots on the existing D1 path', async () => {
    const d1 = database({ allowHighCard: true })
    const r2 = bucket('legacy')
    const env: TransitBindings = { TRANSIT_DB: d1.db, TRANSIT_SHAPES: r2.bucket }

    await expect(searchStopPlaces(env, city, 'Alpha')).resolves.toEqual([])
    expect(d1.queries.some((query) => query.includes('FROM stops s'))).toBe(true)
    expect(r2.reads).toEqual([rootKey])
  })

  it('rejects partial root bindings instead of treating them as legacy', async () => {
    const d1 = database()
    const r2 = bucket('partial')
    const env: TransitBindings = { TRANSIT_DB: d1.db, TRANSIT_SHAPES: r2.bucket }

    await expect(searchStopPlaces(env, city, 'Alpha')).rejects.toThrow(
      'Snapshot routing authority root binding is partial',
    )
    expect(d1.queries).toEqual(['SELECT active_version FROM dataset_versions WHERE city_code = ?'])
  })

  it('rejects a missing root manifest instead of falling back to D1', async () => {
    const d1 = database()
    const r2 = bucket('missing')
    const env: TransitBindings = { TRANSIT_DB: d1.db, TRANSIT_SHAPES: r2.bucket }

    await expect(searchStopPlaces(env, city, 'Alpha')).rejects.toThrow(
      'Snapshot routing authority root manifest is missing',
    )
    expect(d1.queries).toEqual(['SELECT active_version FROM dataset_versions WHERE city_code = ?'])
  })

  it('rejects an authority lookup outage instead of falling back to D1', async () => {
    const d1 = database()
    const r2 = bucket('error')
    const env: TransitBindings = { TRANSIT_DB: d1.db, TRANSIT_SHAPES: r2.bucket }

    await expect(searchStopPlaces(env, city, 'Alpha')).rejects.toThrow(
      'Unable to resolve snapshot routing authority',
    )
    expect(d1.queries).toEqual(['SELECT active_version FROM dataset_versions WHERE city_code = ?'])
  })
})
