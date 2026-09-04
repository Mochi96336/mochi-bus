import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildTransferRoutingShards,
  exportTransferRouting,
  transferRoutingExportManifestKey,
  transferRoutingShardKey,
  transferShardForPattern,
} from './export-transfer-routing.mjs'
import { placeRoutingArtifactKey, placeRoutingExportManifestKey } from './export-place-routing.mjs'
import { patternStopExportManifestKey } from './export-pattern-stops.mjs'

const city = 'Taichung'
const version = 'v1'
const env = {
  CLOUDFLARE_ACCOUNT_ID: 'account',
  CLOUDFLARE_API_TOKEN: 'token',
  TRANSIT_DATABASE_ID: 'database',
  TRANSIT_R2_BUCKET_NAME: 'bucket',
  R2_ACCESS_KEY_ID: 'access',
  R2_SECRET_ACCESS_KEY: 'secret',
}

const p1 = pattern('P1', 'R1', 'Loop', true, 1, 4)
const p2 = pattern('P2', 'R2', 'Open', false, 1, 2)
const p3 = pattern('P3', 'R3', 'Other', false, 1, 2)
const artifacts = {
  A: placeArtifact('A', 'Alpha', 24.10, 120.60, [p1, p2], [
    occurrence('P1', 'S1', 1, 'Alpha'),
    // Same pattern revisits the same place at a different sequence.
    occurrence('P1', 'S1', 3, 'Alpha'),
    occurrence('P2', 'S4', 1, 'Alpha'),
  ]),
  B: placeArtifact('B', 'Beta', 24.20, 120.70, [p1, p3], [
    occurrence('P1', 'S2', 2, 'Beta'),
    occurrence('P3', 'S6', 1, 'Beta'),
  ]),
  C: placeArtifact('C', 'Gamma', 24.30, 120.80, [p1, p3], [
    occurrence('P1', 'S3', 4, 'Gamma'),
    occurrence('P3', 'S7', 2, 'Gamma'),
  ]),
  D: placeArtifact('D', 'Delta', 24.40, 120.90, [p2], [
    occurrence('P2', 'S5', 2, 'Delta'),
  ]),
}

const upstreamManifest = placeManifest(artifacts)

afterEach(() => vi.unstubAllGlobals())

describe('transfer routing shard model', () => {
  it('stores each pattern exactly once while preserving repeated place occurrences', () => {
    const built = buildTransferRoutingShards({
      city,
      version,
      placeArtifacts: Object.values(artifacts).map(stripArtifactEnvelope),
      shardCount: 4,
    })

    expect(built).toMatchObject({ places: 4, patterns: 3, occurrences: 8 })
    expect(built.shards).toHaveLength(4)
    expect(built.patternShards).toHaveLength(3)
    expect(new Set(built.patternShards.map((item) => item.patternId))).toEqual(new Set(['P1', 'P2', 'P3']))

    const allPatterns = built.shards.flatMap((item) => item.artifact.patterns)
    expect(allPatterns).toHaveLength(3)
    const loop = allPatterns.find((item) => item.patternId === 'P1')
    expect(loop).toMatchObject({ circular: true, minSequence: 1, maxSequence: 4 })
    expect(loop.occurrences).toEqual([
      { placeId: 'A', placeName: 'Alpha', latitude: 24.1, longitude: 120.6, stopSequence: 1 },
      { placeId: 'B', placeName: 'Beta', latitude: 24.2, longitude: 120.7, stopSequence: 2 },
      { placeId: 'A', placeName: 'Alpha', latitude: 24.1, longitude: 120.6, stopSequence: 3 },
      { placeId: 'C', placeName: 'Gamma', latitude: 24.3, longitude: 120.8, stopSequence: 4 },
    ])
  })

  it('assigns patterns deterministically to fixed shards', () => {
    expect(transferShardForPattern('P1', 16)).toBe(transferShardForPattern('P1', 16))
    expect(transferShardForPattern('P1', 16)).toBeGreaterThanOrEqual(0)
    expect(transferShardForPattern('P1', 16)).toBeLessThan(16)
    expect(transferRoutingShardKey('v1', city, 3))
      .toBe('snapshots/v1/cities/Taichung/routing/transfers/shards/03.json')
    expect(transferRoutingExportManifestKey('v1', city))
      .toBe('snapshots/v1/cities/Taichung/transfer-routing-export.json')
  })

  it('rejects metadata drift for the same pattern across places', () => {
    const changed = structuredClone(artifacts)
    changed.B.patterns[0] = { ...changed.B.patterns[0], routeName: 'Different' }
    expect(() => buildTransferRoutingShards({
      city,
      version,
      placeArtifacts: Object.values(changed).map(stripArtifactEnvelope),
      shardCount: 4,
    })).toThrow('Pattern P1 metadata mismatch across place artifacts')
  })
})

describe('exportTransferRouting', () => {
  it('reads only the active pointer from D1, keeps exact parity, and writes the manifest last', async () => {
    const d1 = fakeD1()
    const r2 = installR2({ delayMs: 2 })

    const result = await exportTransferRouting({
      city,
      target: 'active',
      env,
      fetchImpl: d1.fetch,
      shardCount: 4,
      readConcurrency: 2,
      writeConcurrency: 2,
      now: () => new Date('2026-09-05T00:00:00.000Z'),
    })

    expect(result).toMatchObject({
      city,
      version,
      manifestKey: transferRoutingExportManifestKey(version, city),
      shardCount: 4,
      places: 4,
      patterns: 3,
      occurrences: 8,
    })
    expect(result.shardBytes).toHaveLength(4)
    expect(d1.sql).toEqual(['SELECT active_version FROM dataset_versions WHERE city_code = ?'])
    expect(r2.maxActiveReads).toBeLessThanOrEqual(2)
    expect(r2.maxActiveWrites).toBeLessThanOrEqual(2)
    expect(r2.writes).toHaveLength(5)
    expect(r2.writes.at(-1).key).toBe(transferRoutingExportManifestKey(version, city))
    expect(new Set(r2.writes.slice(0, -1).map((item) => item.key))).toEqual(new Set([
      transferRoutingShardKey(version, city, 0),
      transferRoutingShardKey(version, city, 1),
      transferRoutingShardKey(version, city, 2),
      transferRoutingShardKey(version, city, 3),
    ]))
    expect(r2.writes.at(-1).value).toMatchObject({
      schemaVersion: 1,
      kind: 'transfer-routing-export',
      upstreamPlaceRoutingManifest: placeRoutingExportManifestKey(version, city),
      shardCount: 4,
      places: 4,
      patterns: 3,
      occurrences: 8,
    })
    expect(r2.writes.at(-1).value.patternShards).toHaveLength(3)
    expect(r2.writes.at(-1).value.shards).toHaveLength(4)
  })

  it('does zero PUTs when a place artifact no longer matches its manifest fingerprint', async () => {
    const overwritten = structuredClone(artifacts)
    overwritten.A.occurrences[0].stopName = 'Alpha overwritten'
    const d1 = fakeD1()
    const r2 = installR2({ objects: overwritten })

    await expect(exportTransferRouting({ city, target: 'active', env, fetchImpl: d1.fetch, shardCount: 4 }))
      .rejects.toThrow('Place A artifact fingerprint mismatch')
    expect(r2.writes).toEqual([])
  })

  it('does zero PUTs when the upstream manifest points to a non-canonical place key', async () => {
    const bad = structuredClone(upstreamManifest)
    bad.artifacts[0].key = 'snapshots/v1/cities/Taichung/routing/places/other.json'
    const d1 = fakeD1()
    const r2 = installR2({ manifest: bad })

    await expect(exportTransferRouting({ city, target: 'active', env, fetchImpl: d1.fetch, shardCount: 4 }))
      .rejects.toThrow('Place routing export key mismatch for A')
    expect(r2.writes).toEqual([])
  })

  it('does zero PUTs when global pattern metadata disagrees after valid fingerprints', async () => {
    const changed = structuredClone(artifacts)
    changed.B.patterns[0] = { ...changed.B.patterns[0], routeName: 'Different' }
    const manifest = placeManifest(changed)
    const d1 = fakeD1()
    const r2 = installR2({ manifest, objects: changed })

    await expect(exportTransferRouting({ city, target: 'active', env, fetchImpl: d1.fetch, shardCount: 4 }))
      .rejects.toThrow('Pattern P1 metadata mismatch across place artifacts')
    expect(r2.writes).toEqual([])
  })

  it('rejects invalid shard or concurrency settings before D1/R2 access', async () => {
    const fetchImpl = vi.fn()
    const globalFetch = vi.fn()
    vi.stubGlobal('fetch', globalFetch)

    await expect(exportTransferRouting({ city, target: 'active', env, fetchImpl, shardCount: 0 }))
      .rejects.toThrow('Invalid transfer shard count')
    await expect(exportTransferRouting({ city, target: 'active', env, fetchImpl, readConcurrency: 0 }))
      .rejects.toThrow('Invalid R2 read concurrency')
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(globalFetch).not.toHaveBeenCalled()
  })
})

function fakeD1() {
  const sql = []
  return {
    sql,
    fetch: vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body)
      sql.push(body.sql)
      if (!body.sql.includes('SELECT active_version FROM dataset_versions')) {
        throw new Error(`Unexpected D1 SQL: ${body.sql}`)
      }
      return jsonResponse({ success: true, result: [{ success: true, results: [{ active_version: version }] }] })
    }),
  }
}

function installR2({ manifest = upstreamManifest, objects = artifacts, delayMs = 0 } = {}) {
  const writes = []
  let activeReads = 0
  let maxActiveReads = 0
  let activeWrites = 0
  let maxActiveWrites = 0
  vi.stubGlobal('fetch', vi.fn(async (request, init) => {
    const url = typeof request === 'string' ? request : request.url
    const method = init?.method ?? request.method ?? 'GET'
    const prefix = 'https://account.r2.cloudflarestorage.com/bucket/'
    expect(url.startsWith(prefix)).toBe(true)
    const key = url.slice(prefix.length).split('/').map(decodeURIComponent).join('/')

    if (method === 'GET') {
      activeReads += 1
      maxActiveReads = Math.max(maxActiveReads, activeReads)
      try {
        if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs))
        if (key === placeRoutingExportManifestKey(version, city)) return jsonResponse(manifest)
        const entry = Object.entries(objects).find(([placeId]) => key === placeRoutingArtifactKey(version, city, placeId))
        if (entry) return jsonResponse(entry[1])
        return new Response('missing', { status: 404 })
      } finally {
        activeReads -= 1
      }
    }

    if (method === 'PUT') {
      const body = init?.body ?? await request.text()
      activeWrites += 1
      maxActiveWrites = Math.max(maxActiveWrites, activeWrites)
      try {
        if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs))
        writes.push({ key, value: JSON.parse(body) })
        return new Response('', { status: 200 })
      } finally {
        activeWrites -= 1
      }
    }
    throw new Error(`Unexpected R2 ${method} ${url}`)
  }))

  return {
    writes,
    get maxActiveReads() { return maxActiveReads },
    get maxActiveWrites() { return maxActiveWrites },
  }
}

function pattern(patternId, routeUid, routeName, circular, minSequence, maxSequence) {
  return {
    patternId,
    routeUid,
    routeName,
    direction: 0,
    label: `${routeName} Start → End`,
    subRouteUid: `${routeUid}-sub`,
    subRouteName: routeName,
    shapeKey: `shape/${patternId}.json`,
    circular,
    minSequence,
    maxSequence,
  }
}

function occurrence(patternId, stopUid, stopSequence, stopName) {
  return { patternId, stopUid, stopSequence, stopName }
}

function placeArtifact(placeId, name, latitude, longitude, patterns, occurrences) {
  return {
    schemaVersion: 1,
    kind: 'place-routing',
    city,
    version,
    place: { placeId, name, latitude, longitude },
    patterns,
    occurrences,
  }
}

function stripArtifactEnvelope(value) {
  return {
    place: value.place,
    patterns: value.patterns.map((item) => ({
      patternId: item.patternId,
      routeUid: item.routeUid,
      routeName: item.routeName,
      direction: item.direction,
      label: item.label,
      subRouteUid: item.subRouteUid,
      subRouteName: item.subRouteName,
      circular: item.circular,
      minSequence: item.minSequence,
      maxSequence: item.maxSequence,
    })),
    occurrences: value.occurrences.map((item) => ({
      patternId: item.patternId,
      stopSequence: item.stopSequence,
    })),
  }
}

function placeManifest(objects) {
  const entries = Object.entries(objects).map(([placeId, value]) => ({
    placeId,
    key: placeRoutingArtifactKey(version, city, placeId),
    patterns: value.patterns.length,
    occurrences: value.occurrences.length,
    ...fingerprint(value),
  }))
  return {
    schemaVersion: 1,
    kind: 'place-routing-export',
    city,
    version,
    upstreamPatternStopManifest: patternStopExportManifestKey(version, city),
    places: entries.length,
    patterns: 3,
    occurrences: entries.reduce((sum, item) => sum + item.occurrences, 0),
    artifacts: entries,
  }
}

function fingerprint(value) {
  const body = JSON.stringify(value)
  return {
    bytes: new TextEncoder().encode(body).byteLength,
    sha256: createHash('sha256').update(body).digest('hex'),
  }
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}
