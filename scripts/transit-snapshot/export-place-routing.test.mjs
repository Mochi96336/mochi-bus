import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildPlaceRoutingArtifacts,
  exportPlaceRouting,
  isCircularRouteShape,
  placeRoutingArtifactKey,
  placeRoutingExportManifestKey,
} from './export-place-routing.mjs'
import { patternStopArtifactKey, patternStopExportManifestKey } from './export-pattern-stops.mjs'

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

const patterns = [
  pattern('P1', 'R1', 'Loop', 'shape/P1.json'),
  pattern('P2', 'R2', 'Open', 'shape/P2.json', 1),
]
const places = [
  place('A', 'Alpha', 24.1, 120.6),
  place('B', 'Beta', 24.2, 120.7),
  place('C', 'Gamma', 24.3, 120.8),
]
const p1 = patternArtifact('P1', [
  stop('S1', 'A', 1, 'Alpha'),
  stop('S2', 'B', 2, 'Beta'),
  // Same StopUID + same place, different sequence: existing place bundles collapse
  // this case, while routing must retain both loop occurrences.
  stop('S1', 'A', 3, 'Alpha'),
  stop('S3', 'C', 4, 'Gamma'),
])
const p2 = patternArtifact('P2', [
  stop('S4', 'A', 1, 'Alpha'),
  stop('S5', 'C', 2, 'Gamma'),
])
const loopShape = shape([[0, 0], [1, 0], [1, 1], [0, 0]])
const openShape = shape([[0, 0], [1, 0], [2, 0], [3, 0]])

const upstreamManifest = {
  schemaVersion: 1,
  kind: 'pattern-stop-export',
  city,
  version,
  patterns: 2,
  patternStops: 6,
  artifacts: [
    { patternId: 'P1', key: patternStopArtifactKey(version, city, 'P1'), stops: 4 },
    { patternId: 'P2', key: patternStopArtifactKey(version, city, 'P2'), stops: 2 },
  ],
}

afterEach(() => vi.unstubAllGlobals())

describe('place routing artifact model', () => {
  it('preserves repeated loop occurrences while deduplicating pattern metadata', () => {
    const built = buildPlaceRoutingArtifacts({
      city,
      version,
      patterns,
      places,
      resolvedPatterns: [
        { patternId: 'P1', shapeKey: 'shape/P1.json', circular: true, artifact: p1 },
        { patternId: 'P2', shapeKey: 'shape/P2.json', circular: false, artifact: p2 },
      ],
    })

    expect(built.occurrences).toBe(6)
    expect(built.artifacts).toHaveLength(3)
    const alpha = built.artifacts.find((item) => item.placeId === 'A')
    expect(alpha.key).toBe(placeRoutingArtifactKey(version, city, 'A'))
    expect(alpha.artifact.patterns).toHaveLength(2)
    expect(alpha.artifact.patterns.find((item) => item.patternId === 'P1')).toMatchObject({
      circular: true,
      minSequence: 1,
      maxSequence: 4,
    })
    expect(alpha.artifact.occurrences).toEqual([
      { patternId: 'P1', stopUid: 'S1', stopSequence: 1, stopName: 'Alpha' },
      { patternId: 'P1', stopUid: 'S1', stopSequence: 3, stopName: 'Alpha' },
      { patternId: 'P2', stopUid: 'S4', stopSequence: 1, stopName: 'Alpha' },
    ])
  })

  it('rejects duplicate resolved patterns instead of hiding a missing pattern', () => {
    expect(() => buildPlaceRoutingArtifacts({
      city,
      version,
      patterns,
      places,
      resolvedPatterns: [
        { patternId: 'P1', shapeKey: 'shape/P1.json', circular: true, artifact: p1 },
        { patternId: 'P1', shapeKey: 'shape/P1.json', circular: true, artifact: p1 },
      ],
    })).toThrow('Duplicate or invalid resolved pattern P1')
  })

  it('uses the same 500m loop-closure rule as journey routing', () => {
    expect(isCircularRouteShape([[0, 0], [0.001, 0], [0.002, 0], [0.004, 0]])).toBe(true)
    expect(isCircularRouteShape([[0, 0], [0.001, 0], [0.002, 0], [0.005, 0]])).toBe(false)
    expect(isCircularRouteShape([[0, 0], [1, 0], [0, 0]])).toBe(false)
  })

  it('uses version-addressed routing keys', () => {
    expect(placeRoutingArtifactKey('v1', city, 'TXG:A'))
      .toBe('snapshots/v1/cities/Taichung/routing/places/TXG:A.json')
    expect(placeRoutingExportManifestKey('v1', city))
      .toBe('snapshots/v1/cities/Taichung/place-routing-export.json')
  })
})

describe('exportPlaceRouting', () => {
  it('uses only low-cardinality D1 tables, preserves parity, and writes the manifest last', async () => {
    const d1 = fakeD1()
    const r2 = installR2({ delayMs: 3 })

    const result = await exportPlaceRouting({
      city,
      target: 'active',
      env,
      fetchImpl: d1.fetch,
      readConcurrency: 2,
      writeConcurrency: 2,
      now: () => new Date('2026-09-04T03:00:00.000Z'),
    })

    expect(result).toEqual({
      city,
      version,
      manifestKey: placeRoutingExportManifestKey(version, city),
      places: 3,
      patterns: 2,
      occurrences: 6,
    })
    expect(d1.sql.some((sql) => /(?:FROM|JOIN)\s+pattern_stops\b/i.test(sql))).toBe(false)
    expect(d1.sql.some((sql) => /(?:FROM|JOIN)\s+stops\b/i.test(sql))).toBe(false)
    expect(d1.sql.some((sql) => /FROM\s+patterns\b/i.test(sql))).toBe(true)
    expect(d1.sql.some((sql) => /FROM\s+stop_places\b/i.test(sql))).toBe(true)
    expect(r2.maxActiveWrites).toBeLessThanOrEqual(2)
    expect(r2.writes.at(-1).key).toBe(placeRoutingExportManifestKey(version, city))
    expect(new Set(r2.writes.slice(0, -1).map((item) => item.key))).toEqual(new Set([
      placeRoutingArtifactKey(version, city, 'A'),
      placeRoutingArtifactKey(version, city, 'B'),
      placeRoutingArtifactKey(version, city, 'C'),
    ]))
    const alpha = r2.writes.find((item) => item.key === placeRoutingArtifactKey(version, city, 'A'))
    expect(alpha.value.occurrences.filter((item) => item.patternId === 'P1')).toEqual([
      { patternId: 'P1', stopUid: 'S1', stopSequence: 1, stopName: 'Alpha' },
      { patternId: 'P1', stopUid: 'S1', stopSequence: 3, stopName: 'Alpha' },
    ])
    expect(r2.writes.at(-1).value).toMatchObject({
      schemaVersion: 1,
      kind: 'place-routing-export',
      upstreamPatternStopManifest: patternStopExportManifestKey(version, city),
      places: 3,
      patterns: 2,
      occurrences: 6,
    })
  })

  it('does zero PUTs when the upstream manifest points at a non-canonical pattern key', async () => {
    const bad = structuredClone(upstreamManifest)
    bad.artifacts[0].key = 'snapshots/v1/cities/Taichung/patterns/other/stops.json'
    const d1 = fakeD1()
    const r2 = installR2({ manifest: bad })

    await expect(exportPlaceRouting({ city, target: 'active', env, fetchImpl: d1.fetch }))
      .rejects.toThrow('Pattern stop export key mismatch for P1')
    expect(r2.writes).toEqual([])
  })

  it('does zero PUTs when manifest occurrence counts do not add up', async () => {
    const bad = structuredClone(upstreamManifest)
    bad.patternStops = 7
    const d1 = fakeD1()
    const r2 = installR2({ manifest: bad })

    await expect(exportPlaceRouting({ city, target: 'active', env, fetchImpl: d1.fetch }))
      .rejects.toThrow('Pattern stop export occurrence parity failed')
    expect(r2.writes).toEqual([])
  })

  it('does zero PUTs when a route shape is invalid', async () => {
    const d1 = fakeD1()
    const r2 = installR2({ p2Shape: { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] } } })

    await expect(exportPlaceRouting({ city, target: 'active', env, fetchImpl: d1.fetch }))
      .rejects.toThrow('Pattern P2 has invalid route shape')
    expect(r2.writes).toEqual([])
  })

  it('rejects unsafe concurrency before any D1 or R2 access', async () => {
    const fetchImpl = vi.fn()
    const globalFetch = vi.fn()
    vi.stubGlobal('fetch', globalFetch)
    await expect(exportPlaceRouting({ city, target: 'active', env, fetchImpl, readConcurrency: 0 }))
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
      let results
      if (body.sql.includes('SELECT active_version FROM dataset_versions')) {
        results = [{ active_version: version }]
      } else if (body.sql.includes('FROM patterns p')) {
        results = patterns
      } else if (body.sql.includes('FROM stop_places')) {
        results = places
      } else {
        throw new Error(`Unexpected D1 SQL: ${body.sql}`)
      }
      return jsonResponse({ success: true, result: [{ success: true, results }] })
    }),
  }
}

function installR2({ manifest = upstreamManifest, p2Shape = openShape, delayMs = 0 } = {}) {
  const writes = []
  let activeWrites = 0
  let maxActiveWrites = 0
  vi.stubGlobal('fetch', vi.fn(async (request, init) => {
    const url = typeof request === 'string' ? request : request.url
    const method = init?.method ?? request.method ?? 'GET'
    const prefix = 'https://account.r2.cloudflarestorage.com/bucket/'
    expect(url.startsWith(prefix)).toBe(true)
    const key = url.slice(prefix.length).split('/').map(decodeURIComponent).join('/')

    if (method === 'GET') {
      const value = key === patternStopExportManifestKey(version, city) ? manifest
        : key === patternStopArtifactKey(version, city, 'P1') ? p1
          : key === patternStopArtifactKey(version, city, 'P2') ? p2
            : key === 'shape/P1.json' ? loopShape
              : key === 'shape/P2.json' ? p2Shape
                : null
      if (value === null) return new Response('missing', { status: 404 })
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs))
      return jsonResponse(value)
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
    get maxActiveWrites() { return maxActiveWrites },
  }
}

function pattern(patternId, routeUid, routeName, shapeKey, direction = 0) {
  return {
    pattern_id: patternId,
    route_uid: routeUid,
    subroute_uid: `${routeUid}-sub`,
    subroute_name: routeName,
    direction,
    departure_name: 'Start',
    destination_name: 'End',
    shape_key: shapeKey,
    route_name: routeName,
  }
}

function place(placeId, placeName, latitude, longitude) {
  return { place_id: placeId, place_name: placeName, latitude, longitude }
}

function patternArtifact(patternId, stops) {
  return { schemaVersion: 1, city, version, patternId, stops }
}

function stop(stopUid, placeId, stopSequence, name) {
  return { stopUid, placeId, stopSequence, name, latitude: 24, longitude: 120 }
}

function shape(coordinates) {
  return { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates } }
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}
