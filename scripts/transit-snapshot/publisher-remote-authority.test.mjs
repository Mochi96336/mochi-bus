import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildPublisherRoutingArtifacts } from './publisher-routing-artifacts.mjs'
import { routingCompletionManifestKeys } from './routing-authority-contract.mjs'
import { validatePublisherRemoteRoutingAuthority } from './publisher-remote-authority.mjs'

const city = 'Taichung'
const version = 'v-next'

function fixture() {
  return {
    routes: new Map([['R1', { uid: 'R1', name: '1', departure: '甲', destination: '丙' }]]),
    patterns: [
      { id: 'P:0', routeUid: 'R1', subrouteUid: 'SR1', subrouteName: '1', direction: 0,
        departure: '甲', destination: '乙', shapeKey: `snapshots/${version}/cities/${city}/shapes/P:0.json`,
        shapeFeature: { type: 'Feature', geometry: { type: 'LineString', coordinates: [[120, 24], [120.01, 24.01]] } } },
      { id: 'P:1', routeUid: 'R1', subrouteUid: 'SR2', subrouteName: '1副', direction: 1,
        departure: '乙', destination: '丙', shapeKey: `snapshots/${version}/cities/${city}/shapes/P:1.json`,
        shapeFeature: { type: 'Feature', geometry: { type: 'LineString', coordinates: [[120, 24], [120.02, 24.02]] } } },
    ],
    places: new Map([
      ['L1', { id: 'L1', name: '甲', lat: 24, lon: 120 }],
      ['L2', { id: 'L2', name: '乙', lat: 24.01, lon: 120.01 }],
      ['L3', { id: 'L3', name: '丙', lat: 24.02, lon: 120.02 }],
    ]),
    stops: new Map([
      ['S1', { uid: 'S1', name: '甲站', normalized: '甲', lat: 24, lon: 120, placeId: 'L1' }],
      ['S2', { uid: 'S2', name: '乙站', normalized: '乙', lat: 24.01, lon: 120.01, placeId: 'L2' }],
      ['S3', { uid: 'S3', name: '丙站', normalized: '丙', lat: 24.02, lon: 120.02, placeId: 'L3' }],
    ]),
    patternStops: [
      { patternId: 'P:0', stopUid: 'S1', placeId: 'L1', sequence: 1 },
      { patternId: 'P:0', stopUid: 'S2', placeId: 'L2', sequence: 2 },
      { patternId: 'P:1', stopUid: 'S2', placeId: 'L2', sequence: 1 },
      { patternId: 'P:1', stopUid: 'S3', placeId: 'L3', sequence: 2 },
    ],
  }
}

function setup() {
  const publication = buildPublisherRoutingArtifacts({
    city, version, generatedAt: '2026-09-06T00:00:00.000Z', ...fixture(),
  })
  const rootArtifacts = publication.tasks.map((task) => ({
    key: task.key,
    bytes: Buffer.byteLength(task.body),
    sha256: createHash('sha256').update(task.body).digest('hex'),
    contentType: task.contentType,
  }))
  const byKey = new Map(publication.tasks.map((task) => [task.key, Buffer.from(task.body)]))
  const manifestBodies = routingCompletionManifestKeys(version, city).map((key) => byKey.get(key))
  return { publication, rootArtifacts, manifestBodies }
}

const expectedCounts = { routes: 1, patterns: 2, stops: 3, places: 3, patternStops: 4 }

describe('publisher remote routing authority', () => {
  it('accepts the exact root-bound completion proof and returns a deterministic sample', () => {
    const { rootArtifacts, manifestBodies } = setup()
    const result = validatePublisherRemoteRoutingAuthority({
      city, version, expectedCounts, rootArtifacts, manifestBodies,
    })
    expect(result.counts).toEqual({ patterns: 2, patternStops: 4, places: 3, stops: 3 })
    expect(result.sampleArtifact.patternId).toBe('P:0')
  })

  it('rejects tampered completion bytes and high-cardinality count drift', () => {
    const { rootArtifacts, manifestBodies } = setup()
    const tampered = [...manifestBodies]
    tampered[0] = Buffer.from(`${tampered[0].toString('utf8')} `)
    expect(() => validatePublisherRemoteRoutingAuthority({
      city, version, expectedCounts, rootArtifacts, manifestBodies: tampered,
    })).toThrow(/fingerprint mismatch/)

    expect(() => validatePublisherRemoteRoutingAuthority({
      city, version, expectedCounts: { ...expectedCounts, stops: 4 }, rootArtifacts, manifestBodies,
    })).toThrow(/stops count mismatch/)
  })

  it('requires the completion proof and pattern artifacts to be bound to the root manifest', () => {
    const { rootArtifacts, manifestBodies } = setup()
    const withoutCompletion = rootArtifacts.filter((artifact) => !artifact.key.endsWith('pattern-stops-export.json'))
    expect(() => validatePublisherRemoteRoutingAuthority({
      city, version, expectedCounts, rootArtifacts: withoutCompletion, manifestBodies,
    })).toThrow(/descriptor is invalid/)

    const patternIndex = rootArtifacts.findIndex((artifact) => artifact.key.includes('/patterns/P:0/stops.json'))
    const mismatched = rootArtifacts.map((artifact, index) => index === patternIndex
      ? { ...artifact, sha256: '0'.repeat(64) } : artifact)
    expect(() => validatePublisherRemoteRoutingAuthority({
      city, version, expectedCounts, rootArtifacts: mismatched, manifestBodies,
    })).toThrow(/pattern artifact fingerprint mismatch/)
  })
})
