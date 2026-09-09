import { describe, expect, it, vi } from 'vitest'
import {
  ACTIVE_ROUTE_CATALOG_SQL,
  ACTIVE_ROUTE_COUNTS_SQL,
  classifyD1ApiFailure,
  diagnoseRouteCatalogD1,
  requestDiagnosticD1,
} from './diagnose-routes-d1.mjs'

const READ_LIMIT_MESSAGE = "Your account has exceeded D1's free tier daily row read limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue. See https://developers.cloudflare.com/d1/platform/limits/ for more details."
const WRITE_LIMIT_MESSAGE = "Your account has exceeded D1's free tier daily row write limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue. See https://developers.cloudflare.com/d1/platform/limits/ for more details."

describe('release routes D1 diagnostic', () => {
  it('uses only fixed SELECT statements', () => {
    for (const sql of [ACTIVE_ROUTE_CATALOG_SQL, ACTIVE_ROUTE_COUNTS_SQL]) {
      expect(sql.trim().toUpperCase().startsWith('SELECT')).toBe(true)
      expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE|PRAGMA)\b/i)
    }
  })

  it('reports active low-cardinality counts without exposing active version identity', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([{ active_version: 'secret-version-token' }])
      .mockResolvedValueOnce([{ routes: 321, patterns: 654, places: 987, route_without_pattern: 0 }])

    const reports = await diagnoseRouteCatalogD1({ cities: ['Taipei'], query })
    expect(reports).toEqual([{
      city: 'Taipei',
      result: 'ok',
      stage: 'reference_ok',
      d1FailureClass: 'none',
      activeVersionPresent: true,
      routes: 321,
      patterns: 654,
      places: 987,
      routeWithoutPattern: 0,
    }])
    expect(query).toHaveBeenNthCalledWith(1, ACTIVE_ROUTE_CATALOG_SQL, ['Taipei'])
    expect(query).toHaveBeenNthCalledWith(2, ACTIVE_ROUTE_COUNTS_SQL, [
      'secret-version-token', 'Taipei',
      'secret-version-token', 'Taipei',
      'secret-version-token', 'Taipei',
      'secret-version-token', 'Taipei',
    ])
    expect(JSON.stringify(reports)).not.toContain('secret-version-token')
  })

  it('distinguishes missing pointer, empty active rows and unknown query failure', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ active_version: 'v2' }])
      .mockResolvedValueOnce([{ routes: 0, patterns: 1, places: 1, route_without_pattern: 0 }])
      .mockRejectedValueOnce(new Error('token=https://secret.example'))

    const reports = await diagnoseRouteCatalogD1({
      cities: ['Taipei', 'Chiayi', 'Kaohsiung'],
      query,
    })
    expect(reports.map(({ city, result, stage, d1FailureClass, activeVersionPresent }) => ({
      city, result, stage, d1FailureClass, activeVersionPresent,
    }))).toEqual([
      { city: 'Taipei', result: 'error', stage: 'active_pointer_missing', d1FailureClass: 'none', activeVersionPresent: false },
      { city: 'Chiayi', result: 'error', stage: 'active_rows_empty', d1FailureClass: 'none', activeVersionPresent: true },
      { city: 'Kaohsiung', result: 'error', stage: 'd1_query_failed', d1FailureClass: 'unknown', activeVersionPresent: false },
    ])
    expect(JSON.stringify(reports)).not.toMatch(/token=|secret\.example|\bv2\b/)
  })

  it('fails closed when a successful D1 response omits required count fields', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([{ active_version: 'secret-version-token' }])
      .mockResolvedValueOnce([{ routes: 10, patterns: 20 }])

    const reports = await diagnoseRouteCatalogD1({ cities: ['Taipei'], query })
    expect(reports).toEqual([{
      city: 'Taipei',
      result: 'error',
      stage: 'd1_result_invalid',
      d1FailureClass: 'none',
      activeVersionPresent: true,
      routes: null,
      patterns: null,
      places: null,
      routeWithoutPattern: null,
    }])
    expect(JSON.stringify(reports)).not.toContain('secret-version-token')
  })

  it('classifies only the official free-tier read and write limit messages', () => {
    expect(classifyD1ApiFailure({ errors: [{ message: READ_LIMIT_MESSAGE }] })).toBe('free_rows_read_limit')
    expect(classifyD1ApiFailure({ errors: [{ message: WRITE_LIMIT_MESSAGE }] })).toBe('free_rows_write_limit')
    expect(classifyD1ApiFailure({ errors: [{ message: 'token=https://secret.example' }] })).toBe('api_rejected')
    expect(classifyD1ApiFailure({ errors: [{ code: 1234 }] })).toBe('api_rejected')
  })

  it('preserves quota class through reports without exposing Cloudflare messages', async () => {
    const responses = [
      new Response(JSON.stringify({ success: false, errors: [{ message: READ_LIMIT_MESSAGE }] }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      }),
      new Response(JSON.stringify({ success: false, errors: [{ message: WRITE_LIMIT_MESSAGE }] }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      }),
    ]
    const fetchImpl = vi.fn(async () => responses.shift())
    const query = (sql, params) => requestDiagnosticD1({
      accountId: 'account',
      apiToken: 'secret-api-token',
      databaseId: 'database',
      sql,
      params,
      fetchImpl,
    })

    const reports = await diagnoseRouteCatalogD1({ cities: ['Taipei', 'Chiayi'], query })
    expect(reports.map(({ city, stage, d1FailureClass }) => ({ city, stage, d1FailureClass }))).toEqual([
      { city: 'Taipei', stage: 'd1_query_failed', d1FailureClass: 'free_rows_read_limit' },
      { city: 'Chiayi', stage: 'd1_query_failed', d1FailureClass: 'free_rows_write_limit' },
    ])
    expect(JSON.stringify(reports)).not.toMatch(/free tier daily|secret-api-token|developers\.cloudflare\.com/)
  })

  it('separates network, malformed response, generic rejection and malformed success results', async () => {
    const cases = [
      {
        expected: 'network',
        fetchImpl: vi.fn(async () => { throw new Error('token=https://secret.example') }),
      },
      {
        expected: 'response_invalid',
        fetchImpl: vi.fn(async () => new Response('{not-json', { status: 502 })),
      },
      {
        expected: 'api_rejected',
        fetchImpl: vi.fn(async () => new Response(JSON.stringify({
          success: false,
          errors: [{ message: 'token=https://secret.example' }],
        }), { status: 403 })),
      },
      {
        expected: 'result_invalid',
        fetchImpl: vi.fn(async () => new Response(JSON.stringify({ success: true, result: [] }), { status: 200 })),
      },
    ]

    for (const { expected, fetchImpl } of cases) {
      await expect(requestDiagnosticD1({
        accountId: 'account',
        apiToken: 'secret-api-token',
        databaseId: 'database',
        sql: ACTIVE_ROUTE_CATALOG_SQL,
        params: ['Taipei'],
        fetchImpl,
      })).rejects.toMatchObject({ failureClass: expected })
    }
  })

  it('returns rows from a valid successful D1 REST response', async () => {
    const rows = [{ active_version: 'v1' }]
    const result = await requestDiagnosticD1({
      accountId: 'account',
      apiToken: 'secret-api-token',
      databaseId: 'database',
      sql: ACTIVE_ROUTE_CATALOG_SQL,
      params: ['Taipei'],
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        success: true,
        errors: [],
        result: [{ success: true, results: rows }],
      }), { status: 200 })),
    })
    expect(result).toEqual(rows)
  })
})
