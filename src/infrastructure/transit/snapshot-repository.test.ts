import { beforeEach, describe, expect, it } from 'vitest'
import { resetMemoryCacheForTests } from '../../lib/memory-cache'
import {
  findNearbyStopPlaces,
  getCityNetwork,
  getDirectRoutes,
  getOneTransferRoutes,
  getStopPlaceByStopUid,
  type TransitBindings,
} from './snapshot-repository'

type StopPlaceRow = {
  place_id: string
  place_name: string
  latitude: number
  longitude: number
}

describe('getStopPlaceByStopUid', () => {
  beforeEach(() => resetMemoryCacheForTests())

  it('resolves a setup stop UID to the stable map place identity', async () => {
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
          first: async <T>() => (query.includes('dataset_versions')
            ? { active_version: 'v1' }
            : {
              place_id: 'NWT:jing-an',
              place_name: '捷運景安站',
              latitude: 24.993,
              longitude: 121.505,
            }) as T,
        } as D1PreparedStatement
        return statement
      },
    } as D1Database
    const bucket = {
      async get() {
        // This fixture exercises the pre-cutover legacy D1 path, so it has no root manifest.
        return null
      },
    } as unknown as R2Bucket

    const place = await getStopPlaceByStopUid({
      TRANSIT_DB: database,
      TRANSIT_SHAPES: bucket,
    }, 'NewTaipei', 'NWT1')

    expect(place).toEqual({
      placeId: 'NWT:jing-an',
      name: '捷運景安站',
      latitude: 24.993,
      longitude: 121.505,
      distanceMeters: 0,
    })
    expect(queries.at(-1)).toContain('JOIN stop_places')
    expect(bindings.at(-1)).toEqual(['v1', 'NewTaipei', 'NWT1'])
  })
})

describe('findNearbyStopPlaces', () => {
  beforeEach(() => resetMemoryCacheForTests())

  it('ranks the complete bounding-box result before taking the nearest 100', async () => {
    const latitude = 23.5
    const longitude = 120.5
    const candidates: StopPlaceRow[] = Array.from({ length: 100 }, (_, index) => ({
      place_id: `far-${index.toString().padStart(3, '0')}`,
      place_name: `Far ${index}`,
      latitude: latitude + 0.005 + index * 0.000001,
      longitude,
    }))
    candidates.push({
      place_id: 'closest-after-first-100',
      place_name: 'Closest',
      latitude: latitude + 0.00001,
      longitude,
    })

    const queries: string[] = []
    const meta = {
      duration: 0,
      size_after: 0,
      rows_read: candidates.length,
      rows_written: 0,
      last_row_id: 0,
      changed_db: false,
      changes: 0,
    }
    const database = {
      prepare(query: string) {
        queries.push(query)
        function raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>
        function raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>
        async function raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<[string[], ...T[]] | T[]> {
          return options?.columnNames ? [[]] as [string[], ...T[]] : []
        }
        const statement: D1PreparedStatement = {
          bind: () => statement,
          first: async <T = Record<string, unknown>>() => ({ active_version: 'v1' }) as T,
          all: async <T = Record<string, unknown>>(): Promise<D1Result<T>> => ({
            success: true,
            meta,
            results: candidates as T[],
          }),
          run: async <T = Record<string, unknown>>(): Promise<D1Result<T>> => ({
            success: true,
            meta,
            results: [],
          }),
          raw,
        }
        return statement
      },
    } as D1Database
    const env: TransitBindings = {
      TRANSIT_DB: database,
      TRANSIT_SHAPES: {} as R2Bucket,
    }

    const places = await findNearbyStopPlaces(env, 'DenseCity', latitude, longitude, 2_000)
    const nearbyQuery = queries.find((query) => query.includes('FROM stop_places'))

    expect(nearbyQuery).toBeDefined()
    expect(nearbyQuery).not.toMatch(/\bLIMIT\b/i)
    expect(places).toHaveLength(100)
    expect(places[0].placeId).toBe('closest-after-first-100')
    expect(places.some((place) => place.placeId === 'closest-after-first-100')).toBe(true)
  })
})

describe('getCityNetwork', () => {
  beforeEach(() => resetMemoryCacheForTests())

  it('小城市 inline fallback 使用 8m 容差，保留超過容差的線形', async () => {
    const meta = {
      duration: 0, size_after: 0, rows_read: 0, rows_written: 0, last_row_id: 0, changed_db: false, changes: 0,
    }
    const patternRow = {
      pattern_id: 'P1', route_uid: 'R1', subroute_uid: null, route_name: 'Route 1',
      subroute_name: 'Route 1', direction: 0 as const, departure_name: 'A', destination_name: 'B',
      shape_key: 'shapes/P1.json', updated_at: null,
    }
    const database = {
      prepare(query: string) {
        function raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>
        function raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>
        async function raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<[string[], ...T[]] | T[]> {
          return options?.columnNames ? [[]] as [string[], ...T[]] : []
        }
        const statement: D1PreparedStatement = {
          bind: () => statement,
          first: async <T = Record<string, unknown>>() => ({ active_version: 'v1' }) as T,
          all: async <T = Record<string, unknown>>(): Promise<D1Result<T>> => ({
            success: true,
            meta,
            results: (query.includes('FROM patterns') ? [patternRow] : []) as T[],
          }),
          run: async <T = Record<string, unknown>>(): Promise<D1Result<T>> => ({ success: true, meta, results: [] }),
          raw,
        }
        return statement
      },
    } as D1Database
    // 中間點偏離起訖連線約 22m：8m 應保留；若誤回 50m 就會被丟掉。
    const shapeFeature = {
      type: 'Feature' as const,
      properties: {},
      geometry: {
        type: 'LineString' as const,
        coordinates: [[121, 25], [121.0005, 25.0002], [121.001, 25]] as [number, number][],
      },
    }
    const bucket = {
      async get(key: string) {
        if (key === 'shapes/P1.json') return { json: async <T>() => shapeFeature as T } as unknown as R2ObjectBody
        return null
      },
    } as unknown as R2Bucket
    const env: TransitBindings = { TRANSIT_DB: database, TRANSIT_SHAPES: bucket }

    const result = await getCityNetwork(env, 'SmallCity')

    if (result?.kind !== 'inline') throw new Error('expected inline fallback result')
    expect(result.network.routes).toHaveLength(1)
    expect(result.network.routes[0].shape.geometry.coordinates).toEqual(shapeFeature.geometry.coordinates)
  })
})


describe('circular route queries', () => {
  beforeEach(() => resetMemoryCacheForTests())

  const meta = {
    duration: 0, size_after: 0, rows_read: 0, rows_written: 0, last_row_id: 0, changed_db: false, changes: 0,
  }
  const result = <T>(rows: T[]): D1Result<T> => ({ success: true, meta, results: rows })
  const circularShape = {
    type: 'Feature' as const,
    properties: {},
    geometry: { type: 'LineString' as const, coordinates: [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]] as [number, number][] },
  }
  const openShape = {
    type: 'Feature' as const,
    properties: {},
    geometry: { type: 'LineString' as const, coordinates: [[0, 0], [1, 0], [2, 0]] as [number, number][] },
  }

  it('accepts reverse stop order only for a shape that is actually circular', async () => {
    const queries: string[] = []
    const rows = [
      {
        route_name: 'Forward', pattern_id: 'forward', direction: 0 as const, subroute_name: 'Forward',
        departure_name: 'A', destination_name: 'B', shape_key: 'forward.json',
        board_sequence: 1, alight_sequence: 3, min_sequence: 1, max_sequence: 5,
      },
      {
        route_name: 'Loop', pattern_id: 'loop', direction: 0 as const, subroute_name: 'Loop',
        departure_name: 'A', destination_name: 'A', shape_key: 'loop.json',
        board_sequence: 4, alight_sequence: 2, min_sequence: 1, max_sequence: 5,
      },
      {
        route_name: 'Not loop', pattern_id: 'open', direction: 0 as const, subroute_name: 'Not loop',
        departure_name: 'A', destination_name: 'B', shape_key: 'open.json',
        board_sequence: 4, alight_sequence: 2, min_sequence: 1, max_sequence: 5,
      },
    ]
    const database = {
      prepare(query: string) {
        queries.push(query)
        const statement = {
          bind: () => statement,
          first: async <T>() => ({ active_version: 'v1' }) as T,
          all: async <T>() => result(rows as T[]),
        } as D1PreparedStatement
        return statement
      },
    } as D1Database
    const reads: string[] = []
    const bucket = {
      async get(key: string) {
        if (key.endsWith('/manifest.json')) return null
        reads.push(key)
        const shape = key === 'loop.json' ? circularShape : openShape
        return { json: async <T>() => shape as T } as unknown as R2ObjectBody
      },
    } as unknown as R2Bucket

    const routes = await getDirectRoutes({ TRANSIT_DB: database, TRANSIT_SHAPES: bucket }, 'Test', 'from', 'to')

    expect(routes.map((route) => route.routeName)).toEqual(['Forward', 'Loop'])
    expect(routes.find((route) => route.routeName === 'Loop')?.stopCount).toBe(3)
    expect(reads.sort()).toEqual(['loop.json', 'open.json'])
    expect(queries.at(-1)).toContain('alight.stop_sequence != board.stop_sequence')
    expect(queries.at(-1)).not.toContain('alight.stop_sequence > board.stop_sequence')
  })

  it('allows either transfer leg to cross the seam of a circular pattern', async () => {
    const queries: string[] = []
    const forwardRows = [{
      pattern_id: 'loop', route_uid: 'R1', route_name: 'Loop', departure_name: 'A', destination_name: 'A',
      shape_key: 'loop.json', board_sequence: 4, alight_sequence: 2, min_sequence: 1, max_sequence: 5,
      transfer_place_id: 'T1', place_name: 'Transfer A', latitude: 25, longitude: 121,
    }]
    const backwardRows = [{
      pattern_id: 'second', route_uid: 'R2', route_name: 'Second', departure_name: 'C', destination_name: 'D',
      shape_key: 'second.json', board_sequence: 1, alight_sequence: 3, min_sequence: 1, max_sequence: 5,
      transfer_place_id: 'T2', place_name: 'Transfer B', latitude: 25, longitude: 121,
    }]
    const database = {
      prepare(query: string) {
        queries.push(query)
        const statement = {
          bind: () => statement,
          first: async <T>() => ({ active_version: 'v1' }) as T,
        } as D1PreparedStatement
        return statement
      },
      batch: async () => [result(forwardRows), result(backwardRows)],
    } as unknown as D1Database
    const bucket = {
      async get(key: string) {
        if (key !== 'loop.json') return null
        return { json: async <T>() => circularShape as T } as unknown as R2ObjectBody
      },
    } as unknown as R2Bucket

    const plans = await getOneTransferRoutes({ TRANSIT_DB: database, TRANSIT_SHAPES: bucket }, 'Test', 'from', 'to')

    expect(plans).toHaveLength(1)
    expect(plans[0].first.stopCount).toBe(3)
    expect(plans[0].second.stopCount).toBe(2)
    expect(plans[0].totalStops).toBe(5)
    expect(queries.filter((query) => query.includes('CROSS JOIN pattern_stops transfer'))).toHaveLength(2)
    expect(queries.some((query) => query.includes('transfer.stop_sequence > anchor.stop_sequence'))).toBe(false)
    expect(queries.some((query) => query.includes('transfer.stop_sequence < anchor.stop_sequence'))).toBe(false)
  })

  it('keeps the shortest occurrence pair for a repeated circular stop', async () => {
    const rows = [
      {
        route_name: 'Loop', pattern_id: 'loop', direction: 0 as const, subroute_name: 'Loop',
        departure_name: 'A', destination_name: 'A', shape_key: 'loop.json',
        board_sequence: 1, alight_sequence: 5, min_sequence: 1, max_sequence: 5,
      },
      {
        route_name: 'Loop', pattern_id: 'loop', direction: 0 as const, subroute_name: 'Loop',
        departure_name: 'A', destination_name: 'A', shape_key: 'loop.json',
        board_sequence: 4, alight_sequence: 2, min_sequence: 1, max_sequence: 5,
      },
    ]
    const database = {
      prepare() {
        const statement = {
          bind: () => statement,
          first: async <T>() => ({ active_version: 'v1' }) as T,
          all: async <T>() => result(rows as T[]),
        } as D1PreparedStatement
        return statement
      },
    } as unknown as D1Database
    const bucket = {
      async get(key: string) {
        if (key.endsWith('/manifest.json')) return null
        return { json: async <T>() => circularShape as T } as unknown as R2ObjectBody
      },
    } as unknown as R2Bucket

    const routes = await getDirectRoutes({ TRANSIT_DB: database, TRANSIT_SHAPES: bucket }, 'Test', 'from', 'to')

    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({ boardSequence: 4, alightSequence: 2, stopCount: 3 })
  })

  it('allows the second transfer leg to cross a circular seam', async () => {
    const queries: string[] = []
    const forwardRows = [{
      pattern_id: 'first', route_uid: 'R1', route_name: 'First', departure_name: 'A', destination_name: 'B',
      shape_key: 'first.json', board_sequence: 1, alight_sequence: 3, min_sequence: 1, max_sequence: 5,
      transfer_place_id: 'T1', place_name: 'Transfer A', latitude: 25, longitude: 121,
    }]
    const backwardRows = [{
      pattern_id: 'loop', route_uid: 'R2', route_name: 'Loop', departure_name: 'C', destination_name: 'C',
      shape_key: 'loop.json', board_sequence: 4, alight_sequence: 2, min_sequence: 1, max_sequence: 5,
      transfer_place_id: 'T2', place_name: 'Transfer B', latitude: 25, longitude: 121,
    }]
    const database = {
      prepare(query: string) {
        queries.push(query)
        const statement = {
          bind: () => statement,
          first: async <T>() => ({ active_version: 'v1' }) as T,
        } as D1PreparedStatement
        return statement
      },
      batch: async () => [result(forwardRows), result(backwardRows)],
    } as unknown as D1Database
    const bucket = {
      async get(key: string) {
        if (key !== 'loop.json') return null
        return { json: async <T>() => circularShape as T } as unknown as R2ObjectBody
      },
    } as unknown as R2Bucket

    const plans = await getOneTransferRoutes({ TRANSIT_DB: database, TRANSIT_SHAPES: bucket }, 'Test', 'from', 'to')
    const transferQueries = queries.filter((query) => query.includes('CROSS JOIN pattern_stops transfer'))

    expect(plans).toHaveLength(1)
    expect(plans[0].first.stopCount).toBe(2)
    expect(plans[0].second.stopCount).toBe(3)
    expect(plans[0].totalStops).toBe(5)
    expect(transferQueries).toHaveLength(2)
    expect(transferQueries.every((query) => query.includes('anchor_stats AS MATERIALIZED'))).toBe(true)
    expect(transferQueries.some((query) => query.includes('(SELECT MIN(path.stop_sequence)'))).toBe(false)
  })

})
