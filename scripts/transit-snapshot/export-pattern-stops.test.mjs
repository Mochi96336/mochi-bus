import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildPatternStopArtifact,
  exportPatternStops,
  nextPatternStopCursor,
  patternStopArtifactKey,
  patternStopExportManifestKey,
} from './export-pattern-stops.mjs'

const rows = [
  row('P1', 'S1', 'A', 1, 'Alpha', 25.01, 121.51),
  row('P1', 'S2', 'B', 2, 'Beta', 25.02, 121.52),
  row('P1', 'S3', 'C', 3, 'Gamma', 25.03, 121.53),
  row('P2', 'S4', 'D', 1, 'Delta', 25.04, 121.54),
  row('P2', 'S5', 'E', 2, 'Epsilon', 25.05, 121.55),
]

const env = {
  CLOUDFLARE_ACCOUNT_ID: 'account',
  CLOUDFLARE_API_TOKEN: 'token',
  TRANSIT_DATABASE_ID: 'database',
  TRANSIT_R2_BUCKET_NAME: 'bucket',
  R2_ACCESS_KEY_ID: 'access',
  R2_SECRET_ACCESS_KEY: 'secret',
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('pattern stop export artifacts', () => {
  it('builds a stable ordered per-pattern artifact', () => {
    const artifact = buildPatternStopArtifact({
      city: 'Taichung', version: 'v1', patternId: 'P1', rows: rows.slice(0, 3),
    })

    expect(artifact).toEqual({
      schemaVersion: 1,
      city: 'Taichung',
      version: 'v1',
      patternId: 'P1',
      stops: [
        { stopUid: 'S1', placeId: 'A', stopSequence: 1, name: 'Alpha', latitude: 25.01, longitude: 121.51 },
        { stopUid: 'S2', placeId: 'B', stopSequence: 2, name: 'Beta', latitude: 25.02, longitude: 121.52 },
        { stopUid: 'S3', placeId: 'C', stopSequence: 3, name: 'Gamma', latitude: 25.03, longitude: 121.53 },
      ],
    })
  })

  it('rejects non-increasing occurrence order', () => {
    expect(() => buildPatternStopArtifact({
      city: 'Taichung', version: 'v1', patternId: 'P1',
      rows: [rows[1], rows[0]],
    })).toThrow('stop sequence is not strictly increasing')
  })

  it('uses version-addressed R2 keys and monotonic keyset cursors', () => {
    expect(patternStopArtifactKey('v1', 'Taichung', 'P1:0:0'))
      .toBe('snapshots/v1/cities/Taichung/patterns/P1:0:0/stops.json')
    expect(patternStopExportManifestKey('v1', 'Taichung'))
      .toBe('snapshots/v1/cities/Taichung/pattern-stops-export.json')
    expect(nextPatternStopCursor(rows.slice(0, 2)))
      .toEqual({ patternId: 'P1', stopSequence: 2 })
    expect(() => nextPatternStopCursor([rows[0]], { patternId: 'P1', stopSequence: 2 }))
      .toThrow('cursor did not advance')
  })
})

describe('exportPatternStops', () => {
  it('preserves page-split patterns, bounds R2 writes, and writes the manifest last', async () => {
    const d1 = fakeD1({ expectedPatternStops: 5, expectedPatterns: 2 })
    const r2 = installR2Recorder({ delayMs: 5 })

    const result = await exportPatternStops({
      city: 'Taichung',
      target: 'active',
      env,
      fetchImpl: d1.fetch,
      pageSize: 2,
      writeConcurrency: 2,
      now: () => new Date('2026-09-04T00:00:00.000Z'),
    })

    expect(result).toEqual({
      city: 'Taichung',
      version: 'v1',
      manifestKey: 'snapshots/v1/cities/Taichung/pattern-stops-export.json',
      patterns: 2,
      patternStops: 5,
    })
    expect(d1.pageCursors).toEqual([
      ['', -1],
      ['P1', 2],
      ['P2', 1],
    ])
    expect(r2.maxActiveWrites).toBe(2)
    expect(r2.writes.at(-1).key).toBe('snapshots/v1/cities/Taichung/pattern-stops-export.json')
    expect(new Set(r2.writes.slice(0, -1).map((item) => item.key))).toEqual(new Set([
      'snapshots/v1/cities/Taichung/patterns/P1/stops.json',
      'snapshots/v1/cities/Taichung/patterns/P2/stops.json',
    ]))
    const p1 = r2.writes.find((item) => item.key.endsWith('/patterns/P1/stops.json'))
    const p2 = r2.writes.find((item) => item.key.endsWith('/patterns/P2/stops.json'))
    expect(p1.value.stops).toHaveLength(3)
    expect(p1.value.stops.map((stop) => stop.stopUid)).toEqual(['S1', 'S2', 'S3'])
    expect(p2.value.stops).toHaveLength(2)
    expect(r2.writes.at(-1).value).toMatchObject({
      schemaVersion: 1,
      kind: 'pattern-stop-export',
      patterns: 2,
      patternStops: 5,
    })
  })

  it('does zero R2 writes when D1/export parity fails', async () => {
    const d1 = fakeD1({ expectedPatternStops: 6, expectedPatterns: 2 })
    const r2 = installR2Recorder()

    await expect(exportPatternStops({
      city: 'Taichung', target: 'active', env, fetchImpl: d1.fetch, pageSize: 2,
    })).rejects.toThrow('Pattern stop export parity failed')

    expect(r2.writes).toEqual([])
  })

  it('rejects unsafe write concurrency before querying D1', async () => {
    const fetchImpl = vi.fn()
    await expect(exportPatternStops({
      city: 'Taichung', target: 'active', env, fetchImpl, writeConcurrency: 0,
    })).rejects.toThrow('Invalid R2 write concurrency')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

function fakeD1({ expectedPatternStops, expectedPatterns }) {
  const pageCursors = []
  return {
    pageCursors,
    fetch: vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body)
      const sql = body.sql
      let results
      if (sql.includes('SELECT active_version FROM dataset_versions')) {
        results = [{ active_version: 'v1' }]
      } else if (sql.includes('COUNT(*) AS pattern_stops')) {
        results = [{ pattern_stops: expectedPatternStops, patterns: expectedPatterns }]
      } else if (sql.includes('ORDER BY ps.pattern_id, ps.stop_sequence')) {
        const [, city, cursorPattern, , cursorSequence, limit] = body.params
        expect(city).toBe('Taichung')
        pageCursors.push([cursorPattern, cursorSequence])
        results = rows.filter((item) => item.pattern_id > cursorPattern
          || (item.pattern_id === cursorPattern && item.stop_sequence > cursorSequence))
          .slice(0, limit)
      } else {
        throw new Error(`Unexpected D1 SQL: ${sql}`)
      }
      return jsonResponse({ success: true, result: [{ success: true, results }] })
    }),
  }
}

function installR2Recorder({ delayMs = 0 } = {}) {
  const writes = []
  let activeWrites = 0
  let maxActiveWrites = 0
  vi.stubGlobal('fetch', vi.fn(async (request, init) => {
    const url = typeof request === 'string' ? request : request.url
    const method = init?.method ?? request.method ?? 'GET'
    if (method !== 'PUT') throw new Error(`Unexpected R2 ${method} ${url}`)
    const body = init?.body ?? await request.text()
    const prefix = 'https://account.r2.cloudflarestorage.com/bucket/'
    expect(url.startsWith(prefix)).toBe(true)
    const key = url.slice(prefix.length).split('/').map(decodeURIComponent).join('/')
    activeWrites += 1
    maxActiveWrites = Math.max(maxActiveWrites, activeWrites)
    try {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs))
      writes.push({ key, value: JSON.parse(body) })
      return new Response('', { status: 200 })
    } finally {
      activeWrites -= 1
    }
  }))
  return {
    writes,
    get maxActiveWrites() { return maxActiveWrites },
  }
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function row(patternId, stopUid, placeId, stopSequence, stopName, latitude, longitude) {
  return {
    pattern_id: patternId,
    stop_uid: stopUid,
    place_id: placeId,
    stop_sequence: stopSequence,
    stop_name: stopName,
    latitude,
    longitude,
  }
}
