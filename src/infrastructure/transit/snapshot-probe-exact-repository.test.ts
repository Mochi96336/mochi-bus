import { describe, expect, it, vi } from 'vitest'
import type { TransitBindings } from './snapshot-repository'
import { getPinnedSnapshotRouteVariant } from './snapshot-probe-repository'
import { pinnedPatternStopArtifactKey } from './snapshot-probe-pattern-stops'

const version = '20260722T111540779Z'
const city = 'Hsinchu'
const exactPattern = {
  pattern_id: 'HSZ001234:0:0',
  route_uid: 'HSZ001234',
  subroute_uid: 'HSZ0012340',
  route_name: '同名路線',
  subroute_name: '同名路線',
  direction: 0 as const,
  departure_name: '甲站',
  destination_name: '乙站',
  shape_key: `snapshots/${version}/cities/${city}/shapes/HSZ001234:0:0.json`,
  updated_at: null,
}
const stopKey = pinnedPatternStopArtifactKey(version, city, exactPattern.pattern_id)

function bindings({
  pattern = exactPattern,
  shape = {
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates: [[120.9, 24.8], [120.91, 24.81]] },
  },
  stops = [
    {
      stopUid: 'S1', placeId: 'P1', stopSequence: 1,
      name: '甲站', latitude: 24.8, longitude: 120.9,
    },
    {
      stopUid: 'S2', placeId: 'P2', stopSequence: 2,
      name: '乙站', latitude: 24.81, longitude: 120.91,
    },
  ],
  shapeError,
  stopArtifactMissing = false,
}: {
  pattern?: typeof exactPattern | null
  shape?: object | null
  stops?: Array<{
    stopUid: string
    placeId: string
    stopSequence: number
    name: string
    latitude: number
    longitude: number
  }>
  shapeError?: Error
  stopArtifactMissing?: boolean
} = {}) {
  const bindingsSeen: unknown[][] = []
  const r2Reads: string[] = []
  const database = {
    prepare(query: string) {
      if (/\bpattern_stops\b|\bFROM\s+stops\b/i.test(query)) {
        throw new Error(`high-cardinality probe SQL is forbidden: ${query}`)
      }
      const statement = {
        bind: (...values: unknown[]) => {
          bindingsSeen.push(values)
          return statement
        },
        first: async <T>() => pattern as T,
      } as D1PreparedStatement
      return statement
    },
  } as unknown as D1Database
  const bucket = {
    async get(key: string) {
      r2Reads.push(key)
      if (key === stopKey) {
        if (stopArtifactMissing) return null
        return {
          json: async <T>() => ({
            schemaVersion: 1,
            city,
            version,
            patternId: exactPattern.pattern_id,
            stops,
          }) as T,
        } as R2ObjectBody
      }
      if (key === exactPattern.shape_key) {
        if (shape === null) return null
        return {
          json: async <T>() => {
            if (shapeError) throw shapeError
            return shape as T
          },
        } as R2ObjectBody
      }
      return null
    },
  } as unknown as R2Bucket
  return {
    env: { TRANSIT_DB: database, TRANSIT_SHAPES: bucket } as TransitBindings,
    bindingsSeen,
    r2Reads,
  }
}

describe('exact pinned snapshot route repository', () => {
  it('reads only the requested route UID and pattern even when the route name is shared', async () => {
    const fixture = bindings()

    const variant = await getPinnedSnapshotRouteVariant(
      fixture.env,
      city,
      exactPattern.route_uid,
      exactPattern.pattern_id,
      version,
    )

    expect(variant).toMatchObject({
      variantKey: exactPattern.pattern_id,
      routeUid: exactPattern.route_uid,
      routeName: exactPattern.route_name,
    })
    expect(variant?.stops.features).toHaveLength(2)
    expect(fixture.bindingsSeen).toContainEqual([
      version,
      city,
      exactPattern.route_uid,
      exactPattern.pattern_id,
    ])
    expect(fixture.r2Reads).toEqual(expect.arrayContaining([stopKey, exactPattern.shape_key]))
    expect(fixture.r2Reads).not.toContain(
      `snapshots/${version}/cities/${city}/shapes/OTHER_ROUTE_SAME_NAME:0:0.json`,
    )
  })

  it('fails closed before R2 when route UID and pattern ID do not identify one row', async () => {
    const fixture = bindings({ pattern: null })

    await expect(getPinnedSnapshotRouteVariant(
      fixture.env,
      city,
      'HSZ_OTHER',
      exactPattern.pattern_id,
      version,
    )).resolves.toBeNull()
    expect(fixture.r2Reads).toEqual([])
  })

  it('fails closed when the exact sample shape is missing', async () => {
    const fixture = bindings({ shape: null })

    await expect(getPinnedSnapshotRouteVariant(
      fixture.env,
      city,
      exactPattern.route_uid,
      exactPattern.pattern_id,
      version,
    )).resolves.toBeNull()
    expect(fixture.r2Reads).toEqual(expect.arrayContaining([stopKey, exactPattern.shape_key]))
  })

  it('fails closed when the exact sample shape JSON is invalid', async () => {
    const fixture = bindings({ shapeError: new SyntaxError('private shape body') })

    await expect(getPinnedSnapshotRouteVariant(
      fixture.env,
      city,
      exactPattern.route_uid,
      exactPattern.pattern_id,
      version,
    )).rejects.toThrow(SyntaxError)
  })

  it('rejects a short R2 stop artifact before the active probe can accept the route', async () => {
    const fixture = bindings({
      stops: [{
        stopUid: 'S1', placeId: 'P1', stopSequence: 1,
        name: '甲站', latitude: 24.8, longitude: 120.9,
      }],
    })

    await expect(getPinnedSnapshotRouteVariant(
      fixture.env,
      city,
      exactPattern.route_uid,
      exactPattern.pattern_id,
      version,
    )).resolves.toBeNull()
  })

  it('does not read an unrelated same-name shape when the exact R2 artifacts are valid', async () => {
    const fixture = bindings()
    const get = vi.spyOn(fixture.env.TRANSIT_SHAPES, 'get')

    await expect(getPinnedSnapshotRouteVariant(
      fixture.env,
      city,
      exactPattern.route_uid,
      exactPattern.pattern_id,
      version,
    )).resolves.toMatchObject({ variantKey: exactPattern.pattern_id })
    expect(get).toHaveBeenCalledTimes(2)
    expect(get).toHaveBeenCalledWith(stopKey)
    expect(get).toHaveBeenCalledWith(exactPattern.shape_key)
    expect(get).not.toHaveBeenCalledWith(
      `snapshots/${version}/cities/${city}/shapes/OTHER_ROUTE_SAME_NAME:0:0.json`,
    )
  })
})
