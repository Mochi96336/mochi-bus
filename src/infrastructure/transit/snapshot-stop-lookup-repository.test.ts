import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetMemoryCacheForTests } from '../../lib/memory-cache'

const legacy = vi.hoisted(() => ({
  getActiveSnapshotVersion: vi.fn(),
  getStopPlaceByStopUid: vi.fn(),
  searchStopPlaces: vi.fn(),
}))

vi.mock('./snapshot-repository', async (importOriginal) => ({
  ...await importOriginal<typeof import('./snapshot-repository')>(),
  getActiveSnapshotVersion: legacy.getActiveSnapshotVersion,
  getStopPlaceByStopUid: legacy.getStopPlaceByStopUid,
  searchStopPlaces: legacy.searchStopPlaces,
}))

import {
  getStopPlaceByStopUid,
  searchStopPlaces,
  type TransitBindings,
} from './snapshot-stop-lookup-repository'

const city = 'Taichung'
const version = 'v1'
const manifestKey = `snapshots/${version}/cities/${city}/stop-lookup-export.json`

function stop(
  stopUid: string,
  normalizedName: string,
  placeId: string,
  placeName: string,
  latitude = 24.1,
  longitude = 120.6,
) {
  return {
    stopUid,
    stopName: `${placeName} Stop`,
    normalizedName,
    placeId,
    placeName,
    latitude,
    longitude,
  }
}

function shardFor(stopUid: string, shardCount: number): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < stopUid.length; index += 1) {
    hash ^= stopUid.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) % shardCount
}

function shardKey(shard: number) {
  return `snapshots/${version}/cities/${city}/routing/stops/shards/${String(shard).padStart(2, '0')}.json`
}

async function fingerprint(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  const digestInput = new Uint8Array(bytes.byteLength)
  digestInput.set(bytes)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', digestInput.buffer)
  return {
    bytes: bytes.byteLength,
    sha256: [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join(''),
  }
}

async function dataset() {
  const shardCount = 4
  // Known FNV-1a contract: S2 -> 0, S1 -> 1, S4 -> 2, S3 -> 3.
  expect(shardFor('S2', shardCount)).toBe(0)
  expect(shardFor('S1', shardCount)).toBe(1)
  expect(shardFor('S4', shardCount)).toBe(2)
  expect(shardFor('S3', shardCount)).toBe(3)

  const records = [
    stop('S1', '台北', 'A', '甲站'),
    stop('S2', '台北市政府', 'B', '乙站'),
    // Prefix match for 北. The same place also has S1 as a substring match;
    // prefix-first semantics must keep the place only once in the prefix phase.
    stop('S4', '北門', 'A', '甲站'),
    stop('S3', '新北投', 'C', '丙站'),
  ]
  const shards = Array.from({ length: shardCount }, (_, shard) => ({
    schemaVersion: 1,
    kind: 'stop-lookup-shard',
    city,
    version,
    shard,
    shardCount,
    stops: records
      .filter((item) => shardFor(item.stopUid, shardCount) === shard)
      .sort((left, right) => left.stopUid < right.stopUid ? -1 : left.stopUid > right.stopUid ? 1 : 0),
  }))
  const descriptors = await Promise.all(shards.map(async (artifact, shard) => ({
    shard,
    key: shardKey(shard),
    stops: artifact.stops.length,
    ...await fingerprint(artifact),
  })))
  const manifest = {
    schemaVersion: 1,
    kind: 'stop-lookup-export',
    city,
    version,
    generatedAt: '2026-09-05T00:00:00.000Z',
    upstreamPlaceRoutingManifest: `snapshots/${version}/cities/${city}/place-routing-export.json`,
    shardCount,
    places: 3,
    stops: records.length,
    occurrences: 8,
    shards: descriptors,
  }
  const objects: Record<string, unknown> = { [manifestKey]: manifest }
  shards.forEach((artifact, shard) => {
    objects[shardKey(shard)] = artifact
  })
  return { manifest, objects, shards }
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

beforeEach(() => {
  resetMemoryCacheForTests()
  legacy.getActiveSnapshotVersion.mockReset().mockResolvedValue(version)
  legacy.getStopPlaceByStopUid.mockReset().mockResolvedValue({
    placeId: 'legacy', name: 'Legacy', latitude: 1, longitude: 2, distanceMeters: 0,
  })
  legacy.searchStopPlaces.mockReset().mockResolvedValue([
    { placeId: 'legacy', name: 'Legacy', latitude: 1, longitude: 2 },
  ])
})

describe('R2 stop lookup read path', () => {
  it('uses exactly one deterministic shard for a StopUID lookup', async () => {
    const data = await dataset()
    const storage = bucket({ objects: data.objects })

    await expect(getStopPlaceByStopUid(env(storage.r2), city, 'S1')).resolves.toEqual({
      placeId: 'A', name: '甲站', latitude: 24.1, longitude: 120.6, distanceMeters: 0,
    })
    expect(storage.reads).toEqual([manifestKey, shardKey(1)])
    expect(legacy.getStopPlaceByStopUid).not.toHaveBeenCalled()
  })

  it('treats a missing StopUID in a fully verified shard as an authoritative miss', async () => {
    const data = await dataset()
    const storage = bucket({ objects: data.objects })

    await expect(getStopPlaceByStopUid(env(storage.r2), city, 'MISSING')).resolves.toBeNull()
    expect(storage.reads).toHaveLength(2)
    expect(legacy.getStopPlaceByStopUid).not.toHaveBeenCalled()
  })

  it('reconstructs prefix-first then substring-fill search with legacy SQLite BINARY place ordering', async () => {
    const data = await dataset()
    const storage = bucket({ objects: data.objects })

    // Legacy D1 uses ORDER BY p.place_name without an explicit collation.
    // SQLite therefore uses BINARY ordering: 丙 (U+4E19) sorts before 乙
    // (U+4E59). The prefix phase still stays ahead of substring fill.
    await expect(searchStopPlaces(env(storage.r2), city, '北', 3)).resolves.toEqual([
      { placeId: 'A', name: '甲站', latitude: 24.1, longitude: 120.6 },
      { placeId: 'C', name: '丙站', latitude: 24.1, longitude: 120.6 },
      { placeId: 'B', name: '乙站', latitude: 24.1, longitude: 120.6 },
    ])
    expect(storage.reads).toEqual([
      manifestKey,
      shardKey(0), shardKey(1), shardKey(2), shardKey(3),
    ])
    expect(legacy.searchStopPlaces).not.toHaveBeenCalled()
  })

  it('normalizes search text and preserves legacy SQLite BINARY place ordering', async () => {
    const data = await dataset()
    const storage = bucket({ objects: data.objects })

    await expect(searchStopPlaces(env(storage.r2), city, ' 臺北車站 ', 10)).resolves.toEqual([
      { placeId: 'B', name: '乙站', latitude: 24.1, longitude: 120.6 },
      { placeId: 'A', name: '甲站', latitude: 24.1, longitude: 120.6 },
    ])
    expect(legacy.searchStopPlaces).not.toHaveBeenCalled()
  })

  it('negatively caches a missing manifest for 60 seconds', async () => {
    const storage = bucket()
    const bindings = env(storage.r2)

    await getStopPlaceByStopUid(bindings, city, 'S1')
    await getStopPlaceByStopUid(bindings, city, 'S1')

    expect(storage.reads).toEqual([manifestKey])
    expect(legacy.getStopPlaceByStopUid).toHaveBeenCalledTimes(2)
  })

  it('does not cache a transient manifest R2 failure', async () => {
    const storage = bucket({ throwKeys: [manifestKey] })
    const bindings = env(storage.r2)

    await getStopPlaceByStopUid(bindings, city, 'S1')
    await getStopPlaceByStopUid(bindings, city, 'S1')

    expect(storage.reads).toEqual([manifestKey, manifestKey])
    expect(legacy.getStopPlaceByStopUid).toHaveBeenCalledTimes(2)
  })

  it('falls back the whole search when any required shard is missing', async () => {
    const data = await dataset()
    delete data.objects[shardKey(2)]
    const storage = bucket({ objects: data.objects })

    await expect(searchStopPlaces(env(storage.r2), city, '北')).resolves.toEqual([
      { placeId: 'legacy', name: 'Legacy', latitude: 1, longitude: 2 },
    ])
    expect(legacy.searchStopPlaces).toHaveBeenCalledTimes(1)
  })

  it('falls back when shard bytes no longer match the manifest fingerprint', async () => {
    const data = await dataset()
    const changed = structuredClone(data.objects[shardKey(1)]) as Record<string, unknown>
    const stops = changed.stops as Array<Record<string, unknown>>
    stops[0].placeName = 'Overwritten'
    data.objects[shardKey(1)] = changed
    const storage = bucket({ objects: data.objects })

    await expect(getStopPlaceByStopUid(env(storage.r2), city, 'S1')).resolves.toEqual({
      placeId: 'legacy', name: 'Legacy', latitude: 1, longitude: 2, distanceMeters: 0,
    })
    expect(legacy.getStopPlaceByStopUid).toHaveBeenCalledTimes(1)
  })

  it('keeps partial-binding callers on the legacy implementation', async () => {
    const partial = { TRANSIT_DB: {} as D1Database } as TransitBindings

    await getStopPlaceByStopUid(partial, city, 'S1')
    await searchStopPlaces(partial, city, '北')

    expect(legacy.getActiveSnapshotVersion).not.toHaveBeenCalled()
    expect(legacy.getStopPlaceByStopUid).toHaveBeenCalledTimes(1)
    expect(legacy.searchStopPlaces).toHaveBeenCalledTimes(1)
  })
})
