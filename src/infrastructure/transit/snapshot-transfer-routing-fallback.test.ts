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

import {
  getOneTransferRoutes,
  type TransferRoutingFallbackObserver,
  type TransitBindings,
} from './snapshot-transfer-routing-repository'

type Pattern = {
  patternId: string
  routeUid: string
  routeName: string
  direction: 0 | 1 | 2
  label: string
  subRouteUid: string
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

function pattern(patternId: string, routeName: string): Pattern {
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
    maxSequence: 2,
  }
}

function endpointArtifact(placeId: string, item: Pattern, stopSequence: number) {
  return {
    schemaVersion: 1,
    kind: 'place-routing',
    city: 'Taichung',
    version: 'v1',
    place: { placeId, name: `Place ${placeId}`, latitude: 24.05, longitude: 120.55 },
    patterns: [item],
    occurrences: [{
      patternId: item.patternId,
      stopUid: `STOP-${item.patternId}-${stopSequence}`,
      stopSequence,
      stopName: `Stop ${stopSequence}`,
    }],
  }
}

function shardPattern(item: Pattern, occurrences: TransferOccurrence[]) {
  const { shapeKey: _shapeKey, ...metadata } = item
  return { ...metadata, occurrences }
}

function shardArtifact(shard: number, item: Pattern, occurrences: TransferOccurrence[]) {
  return {
    schemaVersion: 1,
    kind: 'transfer-routing-shard',
    city: 'Taichung',
    version: 'v1',
    shard,
    shardCount: 2,
    patterns: [shardPattern(item, occurrences)],
  }
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

async function validObjects() {
  const first = pattern('P1', 'Route 1')
  const second = pattern('P2', 'Route 2')
  const shard0 = shardArtifact(0, first, [
    { placeId: 'from', placeName: 'From', latitude: 24, longitude: 120.5, stopSequence: 1 },
    { placeId: 'transfer-a', placeName: 'Transfer A', latitude: 24.1, longitude: 120.6, stopSequence: 2 },
  ])
  const shard1 = shardArtifact(1, second, [
    { placeId: 'transfer-b', placeName: 'Transfer B', latitude: 24.1005, longitude: 120.6005, stopSequence: 1 },
    { placeId: 'to', placeName: 'To', latitude: 24.2, longitude: 120.7, stopSequence: 2 },
  ])
  const [fp0, fp1] = await Promise.all([fingerprint(shard0), fingerprint(shard1)])
  const manifest = {
    schemaVersion: 1,
    kind: 'transfer-routing-export',
    city: 'Taichung',
    version: 'v1',
    generatedAt: '2026-09-13T00:00:00.000Z',
    upstreamPlaceRoutingManifest: 'snapshots/v1/cities/Taichung/place-routing-export.json',
    shardCount: 2,
    places: 4,
    patterns: 2,
    occurrences: 4,
    patternShards: [
      { patternId: 'P1', shard: 0 },
      { patternId: 'P2', shard: 1 },
    ],
    shards: [
      {
        shard: 0,
        key: 'snapshots/v1/cities/Taichung/routing/transfers/shards/00.json',
        patterns: 1,
        occurrences: 2,
        ...fp0,
      },
      {
        shard: 1,
        key: 'snapshots/v1/cities/Taichung/routing/transfers/shards/01.json',
        patterns: 1,
        occurrences: 2,
        ...fp1,
      },
    ],
  }
  return {
    first,
    second,
    objects: {
      'snapshots/v1/cities/Taichung/transfer-routing-export.json': manifest,
      'snapshots/v1/cities/Taichung/routing/places/from.json': endpointArtifact('from', first, 1),
      'snapshots/v1/cities/Taichung/routing/places/to.json': endpointArtifact('to', second, 2),
      'snapshots/v1/cities/Taichung/routing/transfers/shards/00.json': shard0,
      'snapshots/v1/cities/Taichung/routing/transfers/shards/01.json': shard1,
    } as Record<string, unknown>,
  }
}

function bucket({
  objects = {},
  throwKeys = [],
}: {
  objects?: Record<string, unknown>
  throwKeys?: string[]
} = {}) {
  const r2 = {
    async get(key: string) {
      if (throwKeys.includes(key)) throw new Error('temporary R2 failure')
      if (!(key in objects)) return null
      const value = objects[key]
      const body = JSON.stringify(value)
      return {
        json: async <T>() => value as T,
        arrayBuffer: async () => new TextEncoder().encode(body).buffer,
      } as unknown as R2ObjectBody
    },
  } as unknown as R2Bucket
  return r2
}

function env(r2: R2Bucket): TransitBindings {
  return { TRANSIT_DB: {} as D1Database, TRANSIT_SHAPES: r2 }
}

function observer() {
  return vi.fn<TransferRoutingFallbackObserver>()
}

beforeEach(() => {
  resetMemoryCacheForTests()
  Object.values(legacy).forEach((mock) => mock.mockReset())
  legacy.getActiveSnapshotVersion.mockResolvedValue('v1')
  legacy.getOneTransferRoutes.mockResolvedValue([{ transferPlaceId: 'legacy' }])
})

describe('transfer routing fallback attribution', () => {
  it('reports a cached missing completion manifest as manifest_missing', async () => {
    const observe = observer()
    const bindings = env(bucket())

    await getOneTransferRoutes(bindings, 'Taichung', 'from', 'to', observe)
    await getOneTransferRoutes(bindings, 'Taichung', 'from', 'to', observe)

    expect(observe).toHaveBeenCalledTimes(1)
    expect(observe).toHaveBeenCalledWith({
      city: 'Taichung',
      snapshotVersion: 'v1',
      reason: 'manifest_missing',
    })
  })

  it('reports transfer manifest transport failures as manifest_read_failed', async () => {
    const observe = observer()
    const key = 'snapshots/v1/cities/Taichung/transfer-routing-export.json'

    await getOneTransferRoutes(env(bucket({ throwKeys: [key] })), 'Taichung', 'from', 'to', observe)

    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ reason: 'manifest_read_failed' }))
  })

  it('reports an existing malformed transfer manifest as routing_authority_invalid', async () => {
    const data = await validObjects()
    const key = 'snapshots/v1/cities/Taichung/transfer-routing-export.json'
    data.objects[key] = { ...(data.objects[key] as object), schemaVersion: 99 }
    const observe = observer()

    await getOneTransferRoutes(env(bucket({ objects: data.objects })), 'Taichung', 'from', 'to', observe)

    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ reason: 'routing_authority_invalid' }))
  })

  it('uses deterministic authority-first attribution across concurrent endpoint reads', async () => {
    const data = await validObjects()
    const fromKey = 'snapshots/v1/cities/Taichung/routing/places/from.json'
    const toKey = 'snapshots/v1/cities/Taichung/routing/places/to.json'
    delete data.objects[fromKey]
    const observe = observer()

    await getOneTransferRoutes(
      env(bucket({ objects: data.objects, throwKeys: [toKey] })),
      'Taichung',
      'from',
      'to',
      observe,
    )

    expect(observe).toHaveBeenCalledTimes(1)
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ reason: 'routing_authority_incomplete' }))
  })

  it('reports a missing required transfer shard as routing_authority_incomplete', async () => {
    const data = await validObjects()
    delete data.objects['snapshots/v1/cities/Taichung/routing/transfers/shards/01.json']
    const observe = observer()

    await getOneTransferRoutes(env(bucket({ objects: data.objects })), 'Taichung', 'from', 'to', observe)

    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ reason: 'routing_authority_incomplete' }))
  })

  it('reports a transfer shard fingerprint mismatch as routing_authority_invalid', async () => {
    const data = await validObjects()
    const key = 'snapshots/v1/cities/Taichung/routing/transfers/shards/00.json'
    const changed = structuredClone(data.objects[key]) as { patterns: Array<{ routeName: string }> }
    changed.patterns[0].routeName = 'changed after manifest'
    data.objects[key] = changed
    const observe = observer()

    await getOneTransferRoutes(env(bucket({ objects: data.objects })), 'Taichung', 'from', 'to', observe)

    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ reason: 'routing_authority_invalid' }))
  })

  it('keeps legacy fallback available when the observer throws', async () => {
    const fallback = [{ transferPlaceId: 'legacy' }]
    legacy.getOneTransferRoutes.mockResolvedValue(fallback)
    const observe: TransferRoutingFallbackObserver = () => {
      throw new Error('telemetry sink unavailable')
    }

    await expect(getOneTransferRoutes(env(bucket()), 'Taichung', 'from', 'to', observe)).resolves.toBe(fallback)
  })

  it('does not report a fallback when complete R2 authority answers the request', async () => {
    const data = await validObjects()
    const observe = observer()

    const plans = await getOneTransferRoutes(
      env(bucket({ objects: data.objects })),
      'Taichung',
      'from',
      'to',
      observe,
    )

    expect(plans).toHaveLength(1)
    expect(legacy.getOneTransferRoutes).not.toHaveBeenCalled()
    expect(observe).not.toHaveBeenCalled()
  })
})
