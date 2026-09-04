import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildStopLookupShards,
  exportStopLookup,
  normalizeStopName,
  stopLookupExportManifestKey,
  stopLookupShardForUid,
  stopLookupShardKey,
} from './export-stop-lookup.mjs'
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

const artifacts = {
  A: placeArtifact('A', '臺中車站', 24.10, 120.60, [
    occurrence('P1', 'S1', 1, '臺中車站'),
    // Same StopUID on another pattern must deduplicate to one canonical lookup row.
    occurrence('P2', 'S1', 3, '臺中車站'),
    occurrence('P2', 'S2', 4, '干城站'),
  ]),
  B: placeArtifact('B', '科博館', 24.20, 120.70, [
    occurrence('P3', 'S3', 1, '科博館(專用道)'),
  ]),
}
const upstreamManifest = placeManifest(artifacts)

afterEach(() => vi.unstubAllGlobals())

describe('stop lookup shard model', () => {
  it('keeps one canonical record per StopUID and deterministic shard assignment', () => {
    const built = buildStopLookupShards({
      city,
      version,
      placeArtifacts: Object.values(artifacts).map(stripArtifactEnvelope),
      shardCount: 4,
    })

    expect(built).toMatchObject({ places: 2, stops: 3, occurrences: 4 })
    expect(built.shards).toHaveLength(4)
    const allStops = built.shards.flatMap((item) => item.artifact.stops)
    expect(allStops).toHaveLength(3)
    expect(allStops.find((item) => item.stopUid === 'S1')).toEqual({
      stopUid: 'S1',
      stopName: '臺中車站',
      normalizedName: '台中',
      placeId: 'A',
      placeName: '臺中車站',
      latitude: 24.1,
      longitude: 120.6,
    })
    expect(stopLookupShardForUid('S1', 16)).toBe(stopLookupShardForUid('S1', 16))
    expect(stopLookupShardForUid('S1', 16)).toBeGreaterThanOrEqual(0)
    expect(stopLookupShardForUid('S1', 16)).toBeLessThan(16)
    expect(stopLookupShardKey(version, city, 3))
      .toBe('snapshots/v1/cities/Taichung/routing/stops/shards/03.json')
    expect(stopLookupExportManifestKey(version, city))
      .toBe('snapshots/v1/cities/Taichung/stop-lookup-export.json')
  })

  it('keeps normalization identical to the legacy stop search contract', () => {
    expect(normalizeStopName(' 臺北車站 ')).toBe('台北')
    expect(normalizeStopName('科博館(專用道)')).toBe('科博館專用道')
    expect(normalizeStopName('彰化火車站')).toBe('彰化')
  })

  it('rejects a StopUID that resolves to inconsistent canonical metadata', () => {
    const changed = structuredClone(artifacts)
    changed.B.occurrences.push(occurrence('P3', 'S1', 2, 'Different'))
    expect(() => buildStopLookupShards({
      city,
      version,
      placeArtifacts: Object.values(changed).map(stripArtifactEnvelope),
      shardCount: 4,
    })).toThrow('Stop UID S1 metadata mismatch across place artifacts')
  })
})

describe('exportStopLookup', () => {
  it('reads only the active pointer from D1, verifies upstream parity, and writes manifest last', async () => {
    const d1 = fakeD1()
    const r2 = installR2({ delayMs: 2 })

    const result = await exportStopLookup({
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
      manifestKey: stopLookupExportManifestKey(version, city),
      shardCount: 4,
      places: 2,
      stops: 3,
      occurrences: 4,
    })
    expect(result.shardBytes).toHaveLength(4)
    expect(result.shardStops.reduce((sum, count) => sum + count, 0)).toBe(3)
    expect(d1.sql).toEqual(['SELECT active_version FROM dataset_versions WHERE city_code = ?'])
    expect(r2.maxActiveReads).toBeLessThanOrEqual(2)
    expect(r2.maxActiveWrites).toBeLessThanOrEqual(2)
    expect(r2.writes).toHaveLength(5)
    expect(r2.writes.at(-1).key).toBe(stopLookupExportManifestKey(version, city))
    expect(new Set(r2.writes.slice(0, -1).map((item) => item.key))).toEqual(new Set([
      stopLookupShardKey(version, city, 0),
      stopLookupShardKey(version, city, 1),
      stopLookupShardKey(version, city, 2),
      stopLookupShardKey(version, city, 3),
    ]))
    expect(r2.writes.at(-1).value).toMatchObject({
      schemaVersion: 1,
      kind: 'stop-lookup-export',
      upstreamPlaceRoutingManifest: placeRoutingExportManifestKey(version, city),
      shardCount: 4,
      places: 2,
      stops: 3,
      occurrences: 4,
    })
  })

  it('does zero PUTs when an upstream place artifact fingerprint drifts', async () => {
    const overwritten = structuredClone(artifacts)
    overwritten.A.occurrences[0].stopName = 'overwritten'
    const d1 = fakeD1()
    const r2 = installR2({ objects: overwritten })

    await expect(exportStopLookup({ city, target: 'active', env, fetchImpl: d1.fetch, shardCount: 4 }))
      .rejects.toThrow('Place A artifact fingerprint mismatch')
    expect(r2.writes).toEqual([])
  })

  it('does zero PUTs when the upstream manifest points to a non-canonical place key', async () => {
    const bad = structuredClone(upstreamManifest)
    bad.artifacts[0].key = 'snapshots/v1/cities/Taichung/routing/places/other.json'
    const d1 = fakeD1()
    const r2 = installR2({ manifest: bad })

    await expect(exportStopLookup({ city, target: 'active', env, fetchImpl: d1.fetch, shardCount: 4 }))
      .rejects.toThrow('Place routing export key mismatch for A')
    expect(r2.writes).toEqual([])
  })

  it('does zero PUTs when a validly fingerprinted StopUID maps to two places', async () => {
    const changed = structuredClone(artifacts)
    changed.B.occurrences.push(occurrence('P3', 'S1', 2, '臺中車站'))
    const manifest = placeManifest(changed)
    const d1 = fakeD1()
    const r2 = installR2({ manifest, objects: changed })

    await expect(exportStopLookup({ city, target: 'active', env, fetchImpl: d1.fetch, shardCount: 4 }))
      .rejects.toThrow('Stop UID S1 metadata mismatch across place artifacts')
    expect(r2.writes).toEqual([])
  })

  it('rejects invalid shard or concurrency settings before D1/R2 access', async () => {
    const fetchImpl = vi.fn()
    const globalFetch = vi.fn()
    vi.stubGlobal('fetch', globalFetch)

    await expect(exportStopLookup({ city, target: 'active', env, fetchImpl, shardCount: 0 }))
      .rejects.toThrow('Invalid stop lookup shard count')
    await expect(exportStopLookup({ city, target: 'active', env, fetchImpl, readConcurrency: 0 }))
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

function occurrence(patternId, stopUid, stopSequence, stopName) {
  return { patternId, stopUid, stopSequence, stopName }
}

function placeArtifact(placeId, name, latitude, longitude, occurrences) {
  const patternIds = [...new Set(occurrences.map((item) => item.patternId))]
  return {
    schemaVersion: 1,
    kind: 'place-routing',
    city,
    version,
    place: { placeId, name, latitude, longitude },
    patterns: patternIds.map((patternId) => ({ patternId })),
    occurrences,
  }
}

function stripArtifactEnvelope(value) {
  return {
    place: value.place,
    patterns: value.patterns,
    occurrences: value.occurrences,
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
