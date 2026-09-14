import { beforeEach, describe, expect, it } from 'vitest'
import { resetMemoryCacheForTests } from '../../lib/memory-cache'
import {
  getSnapshotRouteVariants,
  type TransitBindings,
} from './snapshot-repository'

const city = 'Hsinchu'
const version = 'v1'
const rootKey = `snapshots/${version}/cities/${city}/manifest.json`

const meta = {
  duration: 0,
  size_after: 0,
  rows_read: 0,
  rows_written: 0,
  last_row_id: 0,
  changed_db: false,
  changes: 0,
}

const shape = {
  type: 'Feature',
  properties: {},
  geometry: {
    type: 'LineString',
    coordinates: [[120.9, 24.8], [121, 24.9]],
  },
}

beforeEach(() => resetMemoryCacheForTests())

describe('legacy snapshot route variant concurrency', () => {
  it('bounds combined D1 and R2 fan-out while preserving every variant in order', async () => {
    const patterns = Array.from({ length: 9 }, (_, index) => ({
      pattern_id: `P${index + 1}`,
      route_uid: `R${index + 1}`,
      subroute_uid: null,
      route_name: '綠線',
      subroute_name: '綠線',
      direction: (index % 2) as 0 | 1,
      departure_name: 'Alpha',
      destination_name: 'Beta',
      shape_key: `shape/P${index + 1}.json`,
      updated_at: null,
    }))

    let activeOperations = 0
    let maxActiveOperations = 0
    const tracked = async <T>(value: T): Promise<T> => {
      activeOperations += 1
      maxActiveOperations = Math.max(maxActiveOperations, activeOperations)
      try {
        await Promise.resolve()
        return value
      } finally {
        activeOperations -= 1
      }
    }

    const db = {
      prepare(query: string) {
        let bindings: unknown[] = []
        const statement = {
          bind(...values: unknown[]) {
            bindings = values
            return statement
          },
          async first<T>() {
            if (query.includes('SELECT active_version FROM dataset_versions')) {
              return { active_version: version } as T
            }
            throw new Error(`unexpected D1 first(): ${query}`)
          },
          async all<T>() {
            if (query.includes('FROM patterns p')) {
              return { success: true, meta, results: patterns } as D1Result<T>
            }
            if (query.includes('FROM pattern_stops ps')) {
              const patternId = String(bindings[1])
              return tracked({
                success: true,
                meta,
                results: [{
                  stop_uid: `${patternId}-S1`,
                  stop_name: `${patternId} stop`,
                  stop_sequence: 1,
                  latitude: 24.8,
                  longitude: 120.9,
                }],
              } as D1Result<T>)
            }
            throw new Error(`unexpected D1 all(): ${query}`)
          },
        } as unknown as D1PreparedStatement
        return statement
      },
    } as unknown as D1Database

    const bucket = {
      async get(key: string) {
        if (key === rootKey) {
          return {
            json: async <T>() => ({
              schemaVersion: 2,
              city,
              version,
              artifacts: [],
            }) as T,
          } as unknown as R2ObjectBody
        }
        if (/^shape\/P\d+\.json$/.test(key)) {
          return tracked({ json: async <T>() => shape as T } as unknown as R2ObjectBody)
        }
        throw new Error(`unexpected R2 get(): ${key}`)
      },
      async head() {
        return null
      },
    } as unknown as R2Bucket

    const env: TransitBindings = { TRANSIT_DB: db, TRANSIT_SHAPES: bucket }
    const variants = await getSnapshotRouteVariants(env, city, '綠線')

    expect(variants.map((variant) => variant.variantKey)).toEqual(patterns.map((pattern) => pattern.pattern_id))
    expect(maxActiveOperations).toBeGreaterThan(1)
    expect(maxActiveOperations).toBeLessThanOrEqual(4)
  })
})
