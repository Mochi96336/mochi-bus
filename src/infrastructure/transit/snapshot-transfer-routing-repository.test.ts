import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetMemoryCacheForTests } from '../../lib/memory-cache'

const legacy = vi.hoisted(() => ({
  getActiveSnapshotVersion: vi.fn(),
  getOneTransferRoutes: vi.fn(),
}))

vi.mock('./snapshot-repository', async (importOriginal) => ({
  ...await importOriginal<typeof import('./snapshot-repository')>(),
  getActiveSnapshotVersion: legacy.getActiveSnapshotVersion,
  getOneTransferRoutes: legacy.getOneTransferRoutes,
}))

import { getOneTransferRoutes, type TransitBindings } from './snapshot-transfer-routing-repository'

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

type TransferOccurrence = {
  placeId: string
  placeName: string
  latitude: number
  longitude: number
  stopSequence: number
}

function pattern(
  patternId: string,
  routeUid: string,
  routeName: string,
  minSequence: number,
  maxSequence: number,
  overrides: Partial<Pattern> = {},
): Pattern {
  return {
    patternId,
    routeUid,
    routeName,
    direction: 0,
    label: `${routeName} 起點 → ${routeName} 終點`,
    subRouteUid: `SUB-${patternId}`,
    subRouteName: routeName,
    shapeKey: `shape/${patternId}.json`,
    circular: false,
    minSequence,
    maxSequence,
    ...overrides,
  }
}

function endpointArtifact(placeId: string, patterns: Pattern[], sequences: Array<[string, number]>) {
  return {
    schemaVersion: 1,
    kind: 'place-routing',
    city: 'Taichung',
    version: 'v1',
    place: { placeId, name: `Place ${placeId}`, latitude: 24.05, longitude: 120.55 },
    patterns,
    occurrences: sequences.map(([patternId, stopSequence]) => ({
      patternId,
      stopUid: `STOP-${patternId}-${stopSequence}`,
      stopSequence,
      stopName: `Stop ${stopSequence}`,
    })),
  }
}

function shardPattern(pattern: Pattern, occurrences: TransferOccurrence[]) {
  const { shapeKey: _shapeKey, ...metadata } = pattern
  return { ...metadata, occurrences }
}

function shardArtifact(shard: number, shardCount: number, patterns: ReturnType<typeof shardPattern>[]) {
  return {
    schemaVersion: 1,
    kind: 'transfer-routing-shard',
    city: 'Taichung',
    version: 'v1',
    shard,
    shardCount,
    patterns,
  }
}

function fingerprint(value: unknown) {
  const body = JSON.stringify(value)
  return {
    bytes: Buffer.byteLength(body),
    sha256: createHash('sha256').update(body).digest('hex'),
  }
}

function dataset(shards: ReturnType<typeof shardArtifact>[], mapping: Array<[string, number]>) {
  const shardCount = shards.length
  const shardDescriptors = shards.map((artifact, shard) => {
    const occurrences = artifact.patterns.reduce((sum, item) => sum + item.occurrences.length, 0)
    return {
      shard,
      key: `snapshots/v1/cities/Taichung/routing/transfers/shards/${String(shard).padStart(2, '0')}.json`,
      patterns: artifact.patterns.length,
      occurrences,
      ...fingerprint(artifact),
    }
  })
  const manifest = {
    schemaVersion: 1,
    kind: 'transfer-routing-export',
    city: 'Taichung',
    version: 'v1',
    generatedAt: '2026-09-05T00:00:00.000Z',
    upstreamPlaceRoutingManifest: 'snapshots/v1/cities/Taichung/place-routing-export.json',
    shardCount,
    places: 5,
    patterns: mapping.length,
    occurrences: shardDescriptors.reduce((sum, item) => sum + item.occurrences, 0),
    patternShards: mapping.map(([patternId, shard]) => ({ patternId, shard })),
    shards: shardDescriptors,
  }
  const objects: Record<string, unknown> = {
    'snapshots/v1/cities/Taichung/transfer-routing-export.json': manifest,
  }
  shards.forEach((artifact, shard) => {
    objects[`snapshots/v1/cities/Taichung/routing/transfers/shards/${String(shard).padStart(2, '0')}.json`] = artifact
  })
  return { manifest, objects }
}

function bucket({
  objects = {},
  throwKeys = [],
}: {
  objects?: Record<string, unknown>
  throwKeys?: string[]
} = {}) {
  const reads: string[] = []
  const r2 = {
    async get(key: string) {
      reads.push(key)
      if (throwKeys.includes(key)) throw new Error('temporary R2 GET failure')
      if (!(key in objects)) return null
      const value = objects[key]
      const body = JSON.stringify(value)
      return {
        json: async <T>() => value as T,
        arrayBuffer: async () => new TextEncoder().encode(body).buffer,
      } as unknown as R2ObjectBody
    },
  } as unknown as R2Bucket
  return { r2, reads }
}

function env(r2: R2Bucket): TransitBindings {
  return { TRANSIT_DB: {} as D1Database, TRANSIT_SHAPES: r2 }
}

function baseData() {
  const p1 = pattern('P1', 'R1', 'Route 1', 1, 3)
  const p2 = pattern('P2', 'R2', 'Route 2', 2, 4)
  const p3 = pattern('P3', 'R3', 'Unused', 1, 2)
  const shards = [
    shardArtifact(0, 4, [shardPattern(p1, [
      { placeId: 'from', placeName: 'From', latitude: 24.0, longitude: 120.5, stopSequence: 1 },
      { placeId: 'transfer-a', placeName: 'Transfer A', latitude: 24.1, longitude: 120.6, stopSequence: 3 },
    ])]),
    shardArtifact(1, 4, [shardPattern(p3, [
      { placeId: 'unused-a', placeName: 'Unused A', latitude: 23.8, longitude: 120.3, stopSequence: 1 },
      { placeId: 'unused-b', placeName: 'Unused B', latitude: 23.9, longitude: 120.4, stopSequence: 2 },
    ])]),
    shardArtifact(2, 4, [shardPattern(p2, [
      { placeId: 'transfer-b', placeName: 'Transfer B', latitude: 24.1005, longitude: 120.6005, stopSequence: 2 },
      { placeId: 'to', placeName: 'To', latitude: 24.2, longitude: 120.7, stopSequence: 4 },
    ])]),
    shardArtifact(3, 4, []),
  ]
  const data = dataset(shards, [['P1', 0], ['P3', 1], ['P2', 2]])
  data.objects['snapshots/v1/cities/Taichung/routing/places/from.json'] = endpointArtifact('from', [p1], [['P1', 1]])
  data.objects['snapshots/v1/cities/Taichung/routing/places/to.json'] = endpointArtifact('to', [p2], [['P2', 4]])
  return { ...data, p1, p2, p3, shards }
}

beforeEach(() => {
  resetMemoryCacheForTests()
  Object.values(legacy).forEach((mock) => mock.mockReset())
  legacy.getActiveSnapshotVersion.mockResolvedValue('v1')
})

describe('R2-first one-transfer routes', () => {
  it('plans from endpoint artifacts and only reads shards used by endpoint patterns', async () => {
    const data = baseData()
    const r2 = bucket({ objects: data.objects })

    const plans = await getOneTransferRoutes(env(r2.r2), 'Taichung', 'from', 'to')

    expect(legacy.getOneTransferRoutes).not.toHaveBeenCalled()
    expect(plans).toHaveLength(1)
    expect(plans[0]).toMatchObject({
      transferPlaceId: 'transfer-a',
      secondTransferPlaceId: 'transfer-b',
      totalStops: 4,
      first: { variantKey: 'P1', boardSequence: 1, alightSequence: 3, stopCount: 2 },
      second: { variantKey: 'P2', boardSequence: 2, alightSequence: 4, stopCount: 2 },
    })
    expect(plans[0].transferWalkMeters).toBeLessThanOrEqual(350)
    expect(r2.reads).toEqual([
      'snapshots/v1/cities/Taichung/transfer-routing-export.json',
      'snapshots/v1/cities/Taichung/routing/places/from.json',
      'snapshots/v1/cities/Taichung/routing/places/to.json',
      'snapshots/v1/cities/Taichung/routing/transfers/shards/00.json',
      'snapshots/v1/cities/Taichung/routing/transfers/shards/02.json',
    ])
  })

  it('uses exported circular metadata for seam-crossing legs without shape reads', async () => {
    const loop = pattern('LOOP', 'R-LOOP', 'Loop', 1, 4, { circular: true })
    const second = pattern('P2', 'R2', 'Route 2', 1, 3)
    const shards = [
      shardArtifact(0, 2, [shardPattern(loop, [
        { placeId: 'x', placeName: 'X', latitude: 24.1, longitude: 120.6, stopSequence: 2 },
        { placeId: 'from', placeName: 'From', latitude: 24.0, longitude: 120.5, stopSequence: 4 },
        { placeId: 'z', placeName: 'Z', latitude: 24.15, longitude: 120.65, stopSequence: 1 },
        { placeId: 'w', placeName: 'W', latitude: 24.16, longitude: 120.66, stopSequence: 3 },
      ])]),
      shardArtifact(1, 2, [shardPattern(second, [
        { placeId: 'y', placeName: 'Y', latitude: 24.1004, longitude: 120.6004, stopSequence: 1 },
        { placeId: 'mid', placeName: 'Mid', latitude: 24.17, longitude: 120.67, stopSequence: 2 },
        { placeId: 'to', placeName: 'To', latitude: 24.2, longitude: 120.7, stopSequence: 3 },
      ])]),
    ]
    const data = dataset(shards, [['LOOP', 0], ['P2', 1]])
    data.objects['snapshots/v1/cities/Taichung/routing/places/from.json'] = endpointArtifact('from', [loop], [['LOOP', 4]])
    data.objects['snapshots/v1/cities/Taichung/routing/places/to.json'] = endpointArtifact('to', [second], [['P2', 3]])
    const r2 = bucket({ objects: data.objects })

    const plans = await getOneTransferRoutes(env(r2.r2), 'Taichung', 'from', 'to')

    expect(plans.some((plan) => plan.first.variantKey === 'LOOP'
      && plan.first.boardSequence === 4
      && plan.first.alightSequence === 2
      && plan.first.stopCount === 2)).toBe(true)
    expect(r2.reads.some((key) => key.startsWith('shape/'))).toBe(false)
  })

  it('falls back as one complete operation when the transfer manifest is missing and caches that absence', async () => {
    const fallback = [{ transferPlaceId: 'legacy' }]
    legacy.getOneTransferRoutes.mockResolvedValue(fallback)
    const r2 = bucket()
    const bindings = env(r2.r2)

    await expect(getOneTransferRoutes(bindings, 'Taichung', 'from', 'to')).resolves.toBe(fallback)
    await expect(getOneTransferRoutes(bindings, 'Taichung', 'from', 'to')).resolves.toBe(fallback)

    expect(r2.reads).toEqual(['snapshots/v1/cities/Taichung/transfer-routing-export.json'])
    expect(legacy.getOneTransferRoutes).toHaveBeenCalledTimes(2)
  })

  it('does not cache transient transfer-manifest GET failures', async () => {
    const fallback = [{ transferPlaceId: 'legacy' }]
    legacy.getOneTransferRoutes.mockResolvedValue(fallback)
    const manifestKey = 'snapshots/v1/cities/Taichung/transfer-routing-export.json'
    const r2 = bucket({ throwKeys: [manifestKey] })
    const bindings = env(r2.r2)

    await expect(getOneTransferRoutes(bindings, 'Taichung', 'from', 'to')).resolves.toBe(fallback)
    await expect(getOneTransferRoutes(bindings, 'Taichung', 'from', 'to')).resolves.toBe(fallback)

    expect(r2.reads).toEqual([manifestKey, manifestKey])
  })

  it('falls back when a required shard is missing', async () => {
    const fallback = [{ transferPlaceId: 'legacy' }]
    legacy.getOneTransferRoutes.mockResolvedValue(fallback)
    const data = baseData()
    delete data.objects['snapshots/v1/cities/Taichung/routing/transfers/shards/02.json']
    const r2 = bucket({ objects: data.objects })
    const bindings = env(r2.r2)

    await expect(getOneTransferRoutes(bindings, 'Taichung', 'from', 'to')).resolves.toBe(fallback)
    expect(legacy.getOneTransferRoutes).toHaveBeenCalledWith(bindings, 'Taichung', 'from', 'to')
  })

  it('falls back when a shard no longer matches the manifest fingerprint', async () => {
    const fallback = [{ transferPlaceId: 'legacy' }]
    legacy.getOneTransferRoutes.mockResolvedValue(fallback)
    const data = baseData()
    const key = 'snapshots/v1/cities/Taichung/routing/transfers/shards/00.json'
    const changed = structuredClone(data.objects[key]) as { patterns: Array<{ routeName: string }> }
    changed.patterns[0].routeName = 'Corrupted after manifest'
    data.objects[key] = changed
    const r2 = bucket({ objects: data.objects })

    await expect(getOneTransferRoutes(env(r2.r2), 'Taichung', 'from', 'to')).resolves.toBe(fallback)
    expect(legacy.getOneTransferRoutes).toHaveBeenCalledTimes(1)
  })

  it('falls back when endpoint metadata disagrees with its sharded pattern', async () => {
    const fallback = [{ transferPlaceId: 'legacy' }]
    legacy.getOneTransferRoutes.mockResolvedValue(fallback)
    const data = baseData()
    const mismatched = pattern('P1', 'R1', 'Different route name', 1, 3)
    data.objects['snapshots/v1/cities/Taichung/routing/places/from.json'] = endpointArtifact('from', [mismatched], [['P1', 1]])
    const r2 = bucket({ objects: data.objects })

    await expect(getOneTransferRoutes(env(r2.r2), 'Taichung', 'from', 'to')).resolves.toBe(fallback)
    expect(legacy.getOneTransferRoutes).toHaveBeenCalledTimes(1)
  })

  it('returns no plan for identical places without reading R2', async () => {
    const r2 = bucket()

    await expect(getOneTransferRoutes(env(r2.r2), 'Taichung', 'same', 'same')).resolves.toEqual([])
    expect(r2.reads).toEqual([])
    expect(legacy.getOneTransferRoutes).not.toHaveBeenCalled()
  })

  it('uses the legacy function when snapshot bindings are absent', async () => {
    const fallback = [{ transferPlaceId: 'legacy' }]
    legacy.getOneTransferRoutes.mockResolvedValue(fallback)
    const partial = {} as TransitBindings

    await expect(getOneTransferRoutes(partial, 'Taichung', 'A', 'B')).resolves.toBe(fallback)
    expect(legacy.getActiveSnapshotVersion).not.toHaveBeenCalled()
  })
})
