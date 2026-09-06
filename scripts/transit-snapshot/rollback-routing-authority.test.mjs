import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  bindRollbackRoutingAuthority,
  readRollbackRoutingAuthority,
} from './rollback-routing-authority.mjs'

const city = 'Taipei'
const version = '20260906T010203000Z'
const prefix = `snapshots/${version}/cities/${city}/`

function bytes(value) {
  return Buffer.from(JSON.stringify(value))
}

function descriptor(key, value, fields = {}) {
  const body = bytes(value)
  return {
    ...fields,
    key,
    bytes: body.byteLength,
    sha256: createHash('sha256').update(body).digest('hex'),
  }
}

function fixture() {
  const patternKey = `${prefix}patterns/P1/stops.json`
  const patternBody = {
    schemaVersion: 1, city, version, patternId: 'P1',
    stops: [
      { stopUid: 'S1', placeId: 'PLACE1', stopSequence: 1, name: 'One', latitude: 25.01, longitude: 121.51 },
      { stopUid: 'S2', placeId: 'PLACE1', stopSequence: 2, name: 'Two', latitude: 25.02, longitude: 121.52 },
    ],
  }
  const patternArtifact = descriptor(patternKey, patternBody, { patternId: 'P1', stops: 2 })
  const placeArtifact = descriptor(`${prefix}routing/places/PLACE1.json`, { place: 1 }, {
    placeId: 'PLACE1', patterns: 1, occurrences: 2,
  })
  const transferShard = descriptor(`${prefix}routing/transfers/shards/00.json`, { shard: 0 }, {
    shard: 0, patterns: 1, occurrences: 2,
  })
  const stopShard = descriptor(`${prefix}routing/stops/shards/00.json`, { shard: 0 }, {
    shard: 0, stops: 2,
  })
  const manifests = {
    [`${prefix}pattern-stops-export.json`]: {
      schemaVersion: 1, kind: 'pattern-stop-export', city, version,
      patterns: 1, patternStops: 2, artifacts: [patternArtifact],
    },
    [`${prefix}place-routing-export.json`]: {
      schemaVersion: 1, kind: 'place-routing-export', city, version,
      upstreamPatternStopManifest: `${prefix}pattern-stops-export.json`,
      places: 1, patterns: 1, occurrences: 2, artifacts: [placeArtifact],
    },
    [`${prefix}transfer-routing-export.json`]: {
      schemaVersion: 1, kind: 'transfer-routing-export', city, version,
      upstreamPlaceRoutingManifest: `${prefix}place-routing-export.json`,
      shardCount: 1, places: 1, patterns: 1, occurrences: 2,
      patternShards: [{ patternId: 'P1', shard: 0 }], shards: [transferShard],
    },
    [`${prefix}stop-lookup-export.json`]: {
      schemaVersion: 1, kind: 'stop-lookup-export', city, version,
      upstreamPlaceRoutingManifest: `${prefix}place-routing-export.json`,
      shardCount: 1, places: 1, stops: 2, occurrences: 2, shards: [stopShard],
    },
  }
  const bodies = new Map([
    ...Object.entries(manifests).map(([key, value]) => [key, bytes(value)]),
    [patternKey, bytes(patternBody)],
  ])
  const r2 = {
    head: vi.fn(async (key) => {
      const body = bodies.get(key)
      return body ? { size: body.byteLength } : null
    }),
    getBytes: vi.fn(async (key) => bodies.get(key) ?? null),
  }
  return { manifests, bodies, r2 }
}

describe('rollback routing authority', () => {
  it('keeps versions with zero completion manifests on legacy D1 authority', async () => {
    const r2 = { head: vi.fn(async () => null), getBytes: vi.fn() }
    await expect(readRollbackRoutingAuthority({ city, version, r2 })).resolves.toEqual({ mode: 'd1' })
    expect(r2.getBytes).not.toHaveBeenCalled()
  })

  it('fails closed when only part of the completion set exists', async () => {
    const { r2 } = fixture()
    r2.head = vi.fn(async (key) => key.endsWith('pattern-stops-export.json') ? { size: 1 } : null)
    await expect(readRollbackRoutingAuthority({ city, version, r2 }))
      .rejects.toThrow('Snapshot routing authority is incomplete')
  })

  it('uses all four manifests and a fingerprinted pattern artifact as R2 authority', async () => {
    const { r2 } = fixture()
    const authority = await readRollbackRoutingAuthority({ city, version, r2 })
    expect(authority).toMatchObject({
      mode: 'r2',
      counts: { patterns: 1, patternStops: 2, places: 1, stops: 2 },
      sample: { patternId: 'P1', placeId: 'PLACE1' },
    })
    expect(authority.manifestObservations).toHaveLength(4)
  })

  it('rejects a sampled pattern artifact that no longer matches its manifest fingerprint', async () => {
    const { r2, bodies } = fixture()
    bodies.set(`${prefix}patterns/P1/stops.json`, bytes({ schemaVersion: 1, city, version, patternId: 'P1', stops: [] }))
    await expect(readRollbackRoutingAuthority({ city, version, r2 }))
      .rejects.toThrow('Routing artifact fingerprint mismatch')
  })

  it('accepts legacy backfills but fails partial or mismatched root bindings', async () => {
    const { r2, manifests } = fixture()
    const authority = await readRollbackRoutingAuthority({ city, version, r2 })
    expect(bindRollbackRoutingAuthority([], authority)).toBe('legacy-backfill')

    const rootDescriptors = Object.entries(manifests).map(([key, value]) => descriptor(key, value))
    expect(bindRollbackRoutingAuthority(rootDescriptors, authority)).toBe('root-bound')
    expect(() => bindRollbackRoutingAuthority(rootDescriptors.slice(0, 1), authority))
      .toThrow('partial routing authority binding')
    expect(() => bindRollbackRoutingAuthority([
      { ...rootDescriptors[0], sha256: '0'.repeat(64) }, ...rootDescriptors.slice(1),
    ], authority)).toThrow('fingerprint mismatch')
  })
})
