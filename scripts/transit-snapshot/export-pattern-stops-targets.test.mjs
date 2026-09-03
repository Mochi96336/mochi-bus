import { afterEach, describe, expect, it, vi } from 'vitest'
import { exportPatternStops } from './export-pattern-stops.mjs'

const env = {
  CLOUDFLARE_ACCOUNT_ID: 'account',
  CLOUDFLARE_API_TOKEN: 'token',
  TRANSIT_DATABASE_ID: 'database',
  TRANSIT_R2_BUCKET_NAME: 'bucket',
  R2_ACCESS_KEY_ID: 'access',
  R2_SECRET_ACCESS_KEY: 'secret',
}

const patternRows = [
  {
    pattern_id: 'P1', stop_uid: 'S1', place_id: 'A', stop_sequence: 1,
    stop_name: 'Alpha', latitude: 25.01, longitude: 121.51,
  },
  {
    pattern_id: 'P1', stop_uid: 'S2', place_id: 'B', stop_sequence: 2,
    stop_name: 'Beta', latitude: 25.02, longitude: 121.52,
  },
]

afterEach(() => vi.unstubAllGlobals())

describe('pattern stop export target selection', () => {
  it('exports an explicit version without consulting the active pointer', async () => {
    const seenParams = []
    installR2({})
    const d1 = makeD1({ expectedVersion: 'v-explicit', seenParams, rejectActiveLookup: true })

    const result = await exportPatternStops({
      city: 'Taichung', target: 'v-explicit', env, fetchImpl: d1,
    })

    expect(result.version).toBe('v-explicit')
    expect(seenParams.every((params) => params[0] === 'v-explicit')).toBe(true)
  })

  it('resolves previous through version-addressed R2 state before reading D1 rows', async () => {
    const seenParams = []
    const r2 = installR2({ previousVersion: 'v-previous' })
    const d1 = makeD1({ expectedVersion: 'v-previous', seenParams, rejectActiveLookup: true })

    const result = await exportPatternStops({
      city: 'Taichung', target: 'previous', env, fetchImpl: d1,
    })

    expect(result.version).toBe('v-previous')
    expect(r2.reads).toEqual(['snapshots/state/Taichung.json'])
    expect(seenParams.every((params) => params[0] === 'v-previous')).toBe(true)
  })

  it('rejects an unsafe explicit version before any D1 query', async () => {
    installR2({})
    const d1 = vi.fn(async () => { throw new Error('D1 should not be called') })

    await expect(exportPatternStops({
      city: 'Taichung', target: '../escape', env, fetchImpl: d1,
    })).rejects.toThrow('Invalid snapshot version')

    expect(d1).not.toHaveBeenCalled()
  })
})

function makeD1({ expectedVersion, seenParams, rejectActiveLookup }) {
  return vi.fn(async (_url, init) => {
    const body = JSON.parse(init.body)
    if (body.sql.includes('SELECT active_version FROM dataset_versions')) {
      if (rejectActiveLookup) throw new Error('active pointer lookup was not expected')
      return jsonResponse([{ active_version: expectedVersion }])
    }
    if (body.params?.length) {
      expect(body.params[0]).toBe(expectedVersion)
      seenParams.push(body.params)
    }
    if (body.sql.includes('COUNT(*) AS pattern_stops')) {
      return jsonResponse([{ pattern_stops: 2, patterns: 1 }])
    }
    if (body.sql.includes('ORDER BY ps.pattern_id, ps.stop_sequence')) {
      const [, city, cursorPattern, , cursorSequence, limit] = body.params
      expect(city).toBe('Taichung')
      const results = patternRows.filter((item) => item.pattern_id > cursorPattern
        || (item.pattern_id === cursorPattern && item.stop_sequence > cursorSequence))
        .slice(0, limit)
      return jsonResponse(results)
    }
    throw new Error(`Unexpected D1 SQL: ${body.sql}`)
  })
}

function installR2(state) {
  const reads = []
  vi.stubGlobal('fetch', vi.fn(async (request, init) => {
    const url = typeof request === 'string' ? request : request.url
    const method = init?.method ?? request.method ?? 'GET'
    const prefix = 'https://account.r2.cloudflarestorage.com/bucket/'
    expect(url.startsWith(prefix)).toBe(true)
    const key = url.slice(prefix.length).split('/').map(decodeURIComponent).join('/')
    if (method === 'GET') {
      reads.push(key)
      if (key !== 'snapshots/state/Taichung.json') return new Response('', { status: 404 })
      return new Response(JSON.stringify(state), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }
    if (method === 'PUT') return new Response('', { status: 200 })
    throw new Error(`Unexpected R2 ${method} ${key}`)
  }))
  return { reads }
}

function jsonResponse(results) {
  return new Response(JSON.stringify({
    success: true,
    result: [{ success: true, results }],
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}
