import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  buildPublisherRoutingArtifacts,
  routingArtifactCleanupKeys,
  routingCompletionManifestKeys,
} from './publisher-routing-artifacts.mjs'

const city = 'Taichung'
const version = 'v-next'
const generatedAt = '2026-09-05T00:00:00.000Z'

function fixture() {
  const routes = new Map([
    ['R1', { uid: 'R1', name: '1', departure: '甲', destination: '丙' }],
  ])
  const patterns = [
    {
      id: 'P:0', routeUid: 'R1', subrouteUid: 'SR1', subrouteName: '1', direction: 0,
      departure: '甲', destination: '乙', shapeKey: `snapshots/${version}/cities/${city}/shapes/P:0.json`,
      shapeFeature: { type: 'Feature', geometry: { type: 'LineString', coordinates: [[120, 24], [120.01, 24.01]] } },
    },
    {
      id: 'P:1', routeUid: 'R1', subrouteUid: 'SR2', subrouteName: '1副', direction: 1,
      departure: '乙', destination: '丙', shapeKey: `snapshots/${version}/cities/${city}/shapes/P:1.json`,
      shapeFeature: {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [[120, 24], [120.01, 24], [120.01, 24.01], [120.0001, 24.0001]] },
      },
    },
  ]
  const places = new Map([
    ['L1', { id: 'L1', name: '甲', lat: 24, lon: 120 }],
    ['L2', { id: 'L2', name: '乙', lat: 24.01, lon: 120.01 }],
    ['L3', { id: 'L3', name: '丙', lat: 24.02, lon: 120.02 }],
  ])
  const stops = new Map([
    ['S1', { uid: 'S1', name: '甲站', normalized: '甲', lat: 24, lon: 120, placeId: 'L1' }],
    ['S2', { uid: 'S2', name: '乙站', normalized: '乙', lat: 24.01, lon: 120.01, placeId: 'L2' }],
    ['S3', { uid: 'S3', name: '丙站', normalized: '丙', lat: 24.02, lon: 120.02, placeId: 'L3' }],
  ])
  const patternStops = [
    { patternId: 'P:0', stopUid: 'S1', placeId: 'L1', sequence: 1 },
    { patternId: 'P:0', stopUid: 'S2', placeId: 'L2', sequence: 2 },
    { patternId: 'P:1', stopUid: 'S2', placeId: 'L2', sequence: 1 },
    { patternId: 'P:1', stopUid: 'S3', placeId: 'L3', sequence: 2 },
  ]
  return { routes, patterns, stops, places, patternStops }
}

function parseTask(result, key) {
  const task = result.tasks.find((item) => item.key === key)
  expect(task, `missing ${key}`).toBeTruthy()
  return JSON.parse(task.body)
}

function fingerprint(body) {
  return {
    bytes: Buffer.byteLength(body),
    sha256: createHash('sha256').update(body).digest('hex'),
  }
}

describe('publisher routing artifacts', () => {
  it('builds the existing routing schemas directly from the in-memory publisher model', () => {
    const result = buildPublisherRoutingArtifacts({ city, version, generatedAt, ...fixture() })

    expect(result.counts).toEqual({
      patterns: 2,
      patternStops: 4,
      places: 3,
      transferShards: 16,
      stopLookupShards: 16,
      stops: 3,
    })
    expect(result.completionManifestKeys).toEqual(routingCompletionManifestKeys(version, city))
    expect(new Set(result.tasks.map((task) => task.key)).size).toBe(result.tasks.length)
    expect(result.tasks).toHaveLength(2 + 3 + 16 + 16 + 4)

    const patternManifestKey = `snapshots/${version}/cities/${city}/pattern-stops-export.json`
    const placeManifestKey = `snapshots/${version}/cities/${city}/place-routing-export.json`
    const transferManifestKey = `snapshots/${version}/cities/${city}/transfer-routing-export.json`
    const stopManifestKey = `snapshots/${version}/cities/${city}/stop-lookup-export.json`
    const patternManifest = parseTask(result, patternManifestKey)
    const placeManifest = parseTask(result, placeManifestKey)
    const transferManifest = parseTask(result, transferManifestKey)
    const stopManifest = parseTask(result, stopManifestKey)

    expect(patternManifest).toMatchObject({
      schemaVersion: 1, kind: 'pattern-stop-export', city, version, generatedAt,
      patterns: 2, patternStops: 4,
    })
    expect(placeManifest).toMatchObject({
      schemaVersion: 1, kind: 'place-routing-export', city, version, generatedAt,
      upstreamPatternStopManifest: patternManifestKey, places: 3, patterns: 2, occurrences: 4,
    })
    expect(transferManifest).toMatchObject({
      schemaVersion: 1, kind: 'transfer-routing-export', city, version, generatedAt,
      upstreamPlaceRoutingManifest: placeManifestKey, shardCount: 16, places: 3, patterns: 2, occurrences: 4,
    })
    expect(stopManifest).toMatchObject({
      schemaVersion: 1, kind: 'stop-lookup-export', city, version, generatedAt,
      upstreamPlaceRoutingManifest: placeManifestKey, shardCount: 16, places: 3, stops: 3, occurrences: 4,
    })

    for (const entry of [
      ...patternManifest.artifacts,
      ...placeManifest.artifacts,
      ...transferManifest.shards,
      ...stopManifest.shards,
    ]) {
      const task = result.tasks.find((item) => item.key === entry.key)
      expect(task).toBeTruthy()
      expect({ bytes: entry.bytes, sha256: entry.sha256 }).toEqual(fingerprint(task.body))
    }
  })

  it('is deterministic for a fixed timestamp and rejects source-model place drift', () => {
    const first = buildPublisherRoutingArtifacts({ city, version, generatedAt, ...fixture() })
    const second = buildPublisherRoutingArtifacts({ city, version, generatedAt, ...fixture() })
    expect(second.tasks.map(({ key, body }) => ({ key, body })))
      .toEqual(first.tasks.map(({ key, body }) => ({ key, body })))

    const broken = fixture()
    broken.patternStops[0] = { ...broken.patternStops[0], placeId: 'L2' }
    expect(() => buildPublisherRoutingArtifacts({ city, version, generatedAt, ...broken }))
      .toThrow(/place mismatch/)
  })

  it('enumerates routing objects for old-version cleanup without requiring high-cardinality stop rows', () => {
    const versions = new Set(['v-old'])
    const keys = routingArtifactCleanupKeys({
      city,
      versions,
      patterns: [{ version: 'v-old', pattern_id: 'P:0' }, { version: 'keep', pattern_id: 'P:1' }],
      places: [{ version: 'v-old', place_id: 'L1' }, { version: 'keep', place_id: 'L2' }],
    })
    expect(keys).toContain(`snapshots/v-old/cities/${city}/patterns/P:0/stops.json`)
    expect(keys).toContain(`snapshots/v-old/cities/${city}/routing/places/L1.json`)
    expect(keys).toContain(`snapshots/v-old/cities/${city}/routing/transfers/shards/00.json`)
    expect(keys).toContain(`snapshots/v-old/cities/${city}/routing/stops/shards/15.json`)
    for (const manifestKey of routingCompletionManifestKeys('v-old', city)) expect(keys).toContain(manifestKey)
    expect(keys.some((key) => key.includes('/keep/'))).toBe(false)
  })
})
