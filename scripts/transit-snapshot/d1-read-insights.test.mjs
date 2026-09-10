import { describe, expect, it, vi } from 'vitest'
import {
  buildD1ReadInsightsReport,
  fetchD1ReadAttribution,
  MAX_QUERY_SHAPE_LENGTH,
  sanitizeQueryShape,
} from './d1-read-insights.mjs'

function graphqlResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function queryGroup({ query = null, rowsRead = 100, avgRowsRead = 50, count = 2 } = {}) {
  return {
    sum: { queryDurationMs: 8, rowsRead, rowsWritten: 0, rowsReturned: 4 },
    avg: { queryDurationMs: 4, rowsRead: avgRowsRead, rowsWritten: 0, rowsReturned: 2 },
    count,
    dimensions: { query },
  }
}

function queryPayload(groups) {
  return {
    data: {
      viewer: {
        accounts: [{ d1QueriesAdaptiveGroups: groups }],
      },
    },
  }
}

function dailyPayload(groups) {
  return {
    data: {
      viewer: {
        accounts: [{ d1AnalyticsAdaptiveGroups: groups }],
      },
    },
  }
}

const dailyGroup = {
  sum: { readQueries: 321, writeQueries: 7, rowsRead: 4_800_000, rowsWritten: 12_345 },
  dimensions: { date: '2026-09-10', databaseId: 'db-id' },
}

describe('D1 read attribution', () => {
  it('removes comments and string/numeric literals while keeping the SQL shape useful', () => {
    const shape = sanitizeQueryShape(`
      -- city-specific probe
      SELECT p.pattern_id, s.stop_uid
      FROM pattern_stops p
      JOIN stops s ON s.version = p.version AND s.stop_uid = p.stop_uid
      WHERE p.version = '20260830T215444914Z'
        AND p.city_code = "Taipei"
        AND p.pattern_id IN ('A', 'B')
        AND p.stop_sequence > 12
        /* hidden note */
      ORDER BY p.stop_sequence
    `)

    expect(shape).toContain('FROM pattern_stops p JOIN stops s')
    expect(shape).toContain('p.version = ?')
    expect(shape).toContain('p.city_code = ?')
    expect(shape).toContain('p.pattern_id IN (?, ?)')
    expect(shape).toContain('p.stop_sequence > ?')
    expect(shape).not.toContain('Taipei')
    expect(shape).not.toContain('20260830')
    expect(shape).not.toContain('hidden note')
  })

  it('bounds very large query shapes', () => {
    const shape = sanitizeQueryShape(`SELECT ${'column_name, '.repeat(200)} final_column FROM routes`)
    expect(shape.length).toBeLessThanOrEqual(MAX_QUERY_SHAPE_LENGTH)
    expect(shape.endsWith('…')).toBe(true)
  })

  it('retains groups without query text and keeps daily aggregate evidence independent', () => {
    const rawQuery = "SELECT * FROM pattern_stops WHERE version = 'secret-version' AND city_code = 'Taipei'"
    const report = buildD1ReadInsightsReport({
      queryWindowUsed: '1d',
      queryGroups: [
        queryGroup({ query: null, rowsRead: 90_000, avgRowsRead: 90_000, count: 1 }),
        queryGroup({ query: rawQuery, rowsRead: 50_000, avgRowsRead: 25_000, count: 2 }),
      ],
      dailyTotals: [dailyGroup],
    }, { generatedAt: '2026-09-10T03:00:00.000Z' })

    expect(report).toMatchObject({
      schemaVersion: 2,
      generatedAt: '2026-09-10T03:00:00.000Z',
      requestedTimePeriod: '1d',
      queryWindowUsed: '1d',
      queryDataset: {
        groupCount: 2,
        groupsWithQuery: 1,
        groupsWithoutQuery: 1,
        capturedTotalRowsRead: 140_000,
        capturedExecutions: 3,
      },
      dailyTotals: [{
        date: '2026-09-10',
        rowsRead: 4_800_000,
        rowsWritten: 12_345,
        readQueries: 321,
        writeQueries: 7,
      }],
    })
    expect(report.queries[0]).toMatchObject({
      queryShape: '<query-unavailable>',
      queryAvailable: false,
      totalRowsRead: 90_000,
    })
    expect(report.queries[1].queryShape).toContain('FROM pattern_stops')
    expect(report.queries[1].queryFingerprint).toMatch(/^[0-9a-f]{16}$/)
    expect(JSON.stringify(report)).not.toContain('secret-version')
    expect(JSON.stringify(report)).not.toContain('Taipei')
  })

  it('uses one-day query groups when available and still fetches calendar-day totals', async () => {
    const fetchImpl = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body)
      if (body.operationName === 'getD1QueriesOverviewQuery') {
        return graphqlResponse(queryPayload([
          queryGroup({ query: 'SELECT * FROM routes WHERE city_code = ?', rowsRead: 1234 }),
        ]))
      }
      if (body.operationName === 'getD1DailyTotals') return graphqlResponse(dailyPayload([dailyGroup]))
      throw new Error('unexpected operation')
    })

    const raw = await fetchD1ReadAttribution({
      accountId: 'account-id',
      apiToken: 'secret-token',
      databaseId: 'db-id',
      fetchImpl,
      now: () => new Date('2026-09-10T03:30:00.000Z'),
    })

    expect(raw.queryWindowUsed).toBe('1d')
    expect(raw.queryGroups).toHaveLength(1)
    expect(raw.dailyTotals).toHaveLength(1)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    for (const [url, init] of fetchImpl.mock.calls) {
      expect(url).toBe('https://api.cloudflare.com/client/v4/graphql')
      expect(init.headers.Authorization).toBe('Bearer secret-token')
      expect(url).not.toContain('secret-token')
    }
  })

  it('falls back from empty 1d groups to 7d without executing database SQL', async () => {
    let queryCalls = 0
    const queryWindows = []
    const fetchImpl = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body)
      if (body.operationName === 'getD1QueriesOverviewQuery') {
        queryCalls += 1
        const filter = body.variables.filter.AND[0]
        queryWindows.push([filter.datetimeHour_geq, filter.datetimeHour_leq])
        return graphqlResponse(queryPayload(queryCalls === 1
          ? []
          : [queryGroup({ query: 'SELECT stop_uid FROM stops WHERE version = ?', rowsRead: 77_000 })]))
      }
      if (body.operationName === 'getD1DailyTotals') return graphqlResponse(dailyPayload([dailyGroup]))
      throw new Error('unexpected operation')
    })

    const raw = await fetchD1ReadAttribution({
      accountId: 'account-id',
      apiToken: 'secret-token',
      databaseId: 'db-id',
      fetchImpl,
      now: () => new Date('2026-09-10T03:30:00.000Z'),
    })

    expect(raw.queryWindowUsed).toBe('7d')
    expect(raw.queryGroups).toHaveLength(1)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(new Date(queryWindows[0][1]).getTime() - new Date(queryWindows[0][0]).getTime())
      .toBe(24 * 60 * 60 * 1000)
    expect(new Date(queryWindows[1][1]).getTime() - new Date(queryWindows[1][0]).getTime())
      .toBe(7 * 24 * 60 * 60 * 1000)
  })

  it('surfaces bounded GraphQL error detail while redacting request variables and credentials', async () => {
    const error = await fetchD1ReadAttribution({
      accountId: 'account-sensitive',
      apiToken: 'token-sensitive',
      databaseId: 'database-sensitive',
      fetchImpl: async () => graphqlResponse({
        data: null,
        errors: [{
          message: 'Cannot query field rowsRead for account-sensitive / database-sensitive / token-sensitive',
          extensions: { code: 'GRAPHQL_VALIDATION_FAILED' },
        }],
      }, 400),
    }).catch((value) => value)

    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain('HTTP 400')
    expect(error.message).toContain('GRAPHQL_VALIDATION_FAILED')
    expect(error.message).toContain('Cannot query field rowsRead')
    expect(error.message).not.toContain('account-sensitive')
    expect(error.message).not.toContain('database-sensitive')
    expect(error.message).not.toContain('token-sensitive')
  })

  it('fails closed on GraphQL errors and invalid metric payloads', async () => {
    await expect(fetchD1ReadAttribution({
      accountId: 'account-id',
      apiToken: 'secret-token',
      databaseId: 'db-id',
      fetchImpl: async () => graphqlResponse({ data: {}, errors: [{ message: 'bad query' }] }),
    })).rejects.toThrow('D1 GraphQL analytics request failed')

    expect(() => buildD1ReadInsightsReport({
      queryWindowUsed: '1d',
      queryGroups: [queryGroup({ query: 'SELECT 1', rowsRead: -1 })],
      dailyTotals: [],
    })).toThrow('totalRowsRead')

    expect(() => buildD1ReadInsightsReport({
      queryWindowUsed: '1d',
      queryGroups: [],
      dailyTotals: [{ sum: { rowsRead: 1 }, dimensions: { date: 'not-a-date' } }],
    })).toThrow('.date is invalid')
  })
})
