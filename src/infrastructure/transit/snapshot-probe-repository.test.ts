import { beforeEach, describe, expect, it } from 'vitest'
import { resetMemoryCacheForTests } from '../../lib/memory-cache'
import {
  getAuthoritativeActiveSnapshotVersion,
  getPinnedSnapshotRouteCatalog,
  getPinnedSnapshotRouteVariant,
  getPinnedSnapshotRouteVariants,
  getPinnedStopPlaceBundle,
} from './snapshot-probe-repository'
import { getActiveSnapshotVersion, type TransitBindings } from './snapshot-repository'

const oldVersion = '20260720T204419330Z'
const candidateVersion = '20260722T101519183Z'
const city = 'Hsinchu'
const patternId = 'HSZ000701:0:0'
const routeUid = 'HSZ000701'
const routeName = '藍1區'
const shapeKey = `snapshots/${candidateVersion}/cities/${city}/shapes/${patternId}.json`
const patternStopKey = `snapshots/${candidateVersion}/cities/${city}/patterns/${patternId}/stops.json`

beforeEach(() => resetMemoryCacheForTests())

function patternRow() {
  return {
    pattern_id: patternId,
    route_uid: routeUid,
    subroute_uid: 'HSZ0007010',
    route_name: routeName,
    subroute_name: routeName,
    direction: 0,
    departure_name: 'A',
    destination_name: 'B',
    shape_key: shapeKey,
    updated_at: null,
  }
}

function routeRow() {
  return {
    route_uid: routeUid,
    route_name: routeName,
    departure_name: 'A',
    destination_name: 'B',
  }
}

function patternStopArtifact(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    city,
    version: candidateVersion,
    patternId,
    stops: [
      {
        stopUid: 'S1', placeId: 'Hsinchu:1ifw3fu', stopSequence: 1,
        name: '一站', latitude: 24.8, longitude: 120.9,
      },
      {
        stopUid: 'S2', placeId: 'Hsinchu:2abc', stopSequence: 2,
        name: '二站', latitude: 24.81, longitude: 120.91,
      },
    ],
    ...overrides,
  }
}

function shape() {
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates: [[120.9, 24.8], [120.91, 24.81]] },
  }
}

function probeEnvironment(
  { patternArtifact = patternStopArtifact() }: { patternArtifact?: unknown } = {},
) {
  const bindings: unknown[][] = []
  const queries: string[] = []
  const database = {
    prepare(query: string) {
      queries.push(query)
      if (/\bpattern_stops\b|\bFROM\s+stops\b/i.test(query)) {
        throw new Error(`high-cardinality probe SQL is forbidden: ${query}`)
      }
      const statement = {
        bind: (...values: unknown[]) => {
          bindings.push(values)
          return statement
        },
        all: async <T>() => ({
          success: true,
          results: (query.includes('FROM patterns p') ? [patternRow()] : [routeRow()]) as T[],
        }),
        first: async <T>() => (query.includes('FROM patterns p') ? patternRow() : null) as T,
      } as D1PreparedStatement
      return statement
    },
  } as unknown as D1Database

  const bundle = {
    version: candidateVersion,
    placeId: 'Hsinchu:1ifw3fu',
    name: '一站',
    routes: [],
  }
  const reads: string[] = []
  const bucket = {
    async get(key: string) {
      reads.push(key)
      if (key === patternStopKey) {
        return { json: async <T>() => patternArtifact as T } as R2ObjectBody
      }
      if (key === shapeKey) {
        return { json: async <T>() => shape() as T } as R2ObjectBody
      }
      if (key === `snapshots/${candidateVersion}/cities/${city}/places/Hsinchu:1ifw3fu.json`) {
        return { json: async <T>() => bundle as T } as R2ObjectBody
      }
      return null
    },
  } as unknown as R2Bucket

  return {
    env: { TRANSIT_DB: database, TRANSIT_SHAPES: bucket } satisfies TransitBindings,
    bindings,
    queries,
    reads,
    bundle,
  }
}

describe('snapshot probe repository', () => {
  it('reads authoritative D1 after the ordinary active-version cache is stale', async () => {
    let activeVersion = oldVersion
    const database = {
      prepare() {
        const statement = {
          bind: () => statement,
          first: async <T>() => ({ active_version: activeVersion }) as T,
        } as D1PreparedStatement
        return statement
      },
    } as unknown as D1Database
    const env: TransitBindings = {
      TRANSIT_DB: database,
      TRANSIT_SHAPES: {} as R2Bucket,
    }

    await expect(getActiveSnapshotVersion(env, city)).resolves.toBe(oldVersion)
    activeVersion = candidateVersion

    await expect(getAuthoritativeActiveSnapshotVersion(env, city)).resolves.toBe(candidateVersion)
    await expect(getActiveSnapshotVersion(env, city)).resolves.toBe(oldVersion)
  })

  it('pins catalogue, exact/grouped route detail, and place reads to one version without high-card D1 SQL', async () => {
    const { env, bindings, queries, reads, bundle } = probeEnvironment()

    const routes = await getPinnedSnapshotRouteCatalog(env, city, candidateVersion)
    const variants = await getPinnedSnapshotRouteVariants(env, city, routeName, candidateVersion)
    const exact = await getPinnedSnapshotRouteVariant(env, city, routeUid, patternId, candidateVersion)
    const place = await getPinnedStopPlaceBundle(env, city, 'Hsinchu:1ifw3fu', candidateVersion)

    expect(routes).toHaveLength(1)
    expect(variants).toHaveLength(1)
    expect(variants[0]).toMatchObject({ variantKey: patternId, routeUid })
    expect(variants[0].stops.features).toHaveLength(2)
    expect(variants[0].stops.features[0]).toMatchObject({
      properties: { stopUid: 'S1', stopName: '一站', sequence: 1 },
      geometry: { coordinates: [120.9, 24.8] },
    })
    expect(exact).toMatchObject({ variantKey: patternId, routeUid })
    expect(exact?.stops.features).toHaveLength(2)
    expect(place).toEqual(bundle)

    expect(bindings).toContainEqual([candidateVersion, city])
    expect(bindings).toContainEqual([candidateVersion, city, routeName])
    expect(bindings).toContainEqual([candidateVersion, city, routeUid, patternId])
    expect(reads.filter((key) => key === patternStopKey)).toHaveLength(2)
    expect(reads).toContain(`snapshots/${candidateVersion}/cities/${city}/places/Hsinchu:1ifw3fu.json`)
    expect(reads.every((key) => key.includes(candidateVersion))).toBe(true)
    expect(queries.join('\n')).not.toMatch(/\bpattern_stops\b|\bFROM\s+stops\b/i)
  })

  it('fails the pinned route closed when the same-version R2 pattern artifact is missing or malformed', async () => {
    const missing = probeEnvironment({ patternArtifact: null })
    const malformed = probeEnvironment({ patternArtifact: patternStopArtifact({ version: oldVersion }) })

    await expect(getPinnedSnapshotRouteVariant(
      missing.env, city, routeUid, patternId, candidateVersion,
    )).resolves.toBeNull()
    await expect(getPinnedSnapshotRouteVariants(
      missing.env, city, routeName, candidateVersion,
    )).resolves.toEqual([])

    await expect(getPinnedSnapshotRouteVariant(
      malformed.env, city, routeUid, patternId, candidateVersion,
    )).resolves.toBeNull()
    await expect(getPinnedSnapshotRouteVariants(
      malformed.env, city, routeName, candidateVersion,
    )).resolves.toEqual([])

    expect(missing.queries.join('\n')).not.toMatch(/\bpattern_stops\b|\bFROM\s+stops\b/i)
    expect(malformed.queries.join('\n')).not.toMatch(/\bpattern_stops\b|\bFROM\s+stops\b/i)
  })
})
