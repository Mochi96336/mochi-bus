import { describe, expect, it, vi } from 'vitest'
import {
  buildWeeklyD1WriteBudgetReport,
  extractD1RowsRead,
  readWeeklyCleanupRowsByCity,
  readWeeklyCleanupRowsEvidence,
  WEEKLY_CLEANUP_ROWS_SQL,
} from './weekly-d1-write-budget.mjs'

const plan = Object.freeze({
  snapshotSchedule: 'taipei-weekly-sharded',
  enabledCities: Object.freeze(['Taoyuan', 'Taipei', 'Taichung']),
})

function cityEstimate(city, estimatedRows, cleanupRows = 10) {
  return {
    city,
    counts: { routes: 10, patterns: 20, stops: 1000, places: 5, patternStops: 3000 },
    estimate: {
      stageRows: 105,
      cleanupRows,
      growthFactor: 1.1,
      estimatedRows,
      fixedReserveRows: 64,
    },
  }
}

describe('weekly D1 write budget proof', () => {
  it('aggregates inactive low-cardinality rows in one read-only D1 query', async () => {
    expect(WEEKLY_CLEANUP_ROWS_SQL.trim().toUpperCase().startsWith('SELECT')).toBe(true)
    expect(WEEKLY_CLEANUP_ROWS_SQL).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE|PRAGMA)\b/i)
    expect(WEEKLY_CLEANUP_ROWS_SQL.match(/FROM routes r/g)).toHaveLength(1)
    expect(WEEKLY_CLEANUP_ROWS_SQL.match(/FROM patterns p/g)).toHaveLength(1)
    expect(WEEKLY_CLEANUP_ROWS_SQL.match(/FROM stop_places s/g)).toHaveLength(1)

    const query = vi.fn(async () => [
      { city_code: 'Chiayi', cleanup_rows: 12 },
      { city_code: 'Taipei', cleanup_rows: 345 },
    ])
    const rows = await readWeeklyCleanupRowsByCity({ query })

    expect([...rows.entries()]).toEqual([
      ['Chiayi', 12],
      ['Taipei', 345],
    ])
    expect(query).toHaveBeenCalledOnce()
    expect(query).toHaveBeenCalledWith(WEEKLY_CLEANUP_ROWS_SQL, [])
  })

  it('preserves rows_read metadata from the same aggregate query', async () => {
    const query = vi.fn(async () => ({
      rows: [
        { city_code: 'Chiayi', cleanup_rows: 12 },
        { city_code: 'Taipei', cleanup_rows: 345 },
      ],
      rowsRead: 112_345,
    }))
    const evidence = await readWeeklyCleanupRowsEvidence({ query })

    expect([...evidence.rowsByCity.entries()]).toEqual([
      ['Chiayi', 12],
      ['Taipei', 345],
    ])
    expect(evidence.rowsRead).toBe(112_345)
    expect(query).toHaveBeenCalledOnce()
  })

  it('observes Cloudflare rows_read through the existing D1 transport without a second request', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      result: [{
        success: true,
        results: [{ city_code: 'Taipei', cleanup_rows: 345 }],
        meta: { rows_read: 112_345, rows_written: 0 },
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const evidence = await readWeeklyCleanupRowsEvidence({
      env: {
        CLOUDFLARE_ACCOUNT_ID: 'account-id',
        CLOUDFLARE_API_TOKEN: 'secret-token',
        TRANSIT_DATABASE_ID: 'database-id',
      },
      fetchImpl,
    })

    expect([...evidence.rowsByCity.entries()]).toEqual([['Taipei', 345]])
    expect(evidence.rowsRead).toBe(112_345)
    expect(fetchImpl).toHaveBeenCalledOnce()
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).not.toContain('secret-token')
    expect(init.headers.Authorization).toBe('Bearer secret-token')
    expect(JSON.parse(init.body)).toEqual({ sql: WEEKLY_CLEANUP_ROWS_SQL, params: [] })
  })

  it('treats malformed rows_read as unavailable evidence without changing proof acceptance', async () => {
    expect(extractD1RowsRead({
      result: [{ meta: { rows_read: -1 } }],
    })).toBeNull()
    expect(extractD1RowsRead({
      result: [{ meta: { rows_read: 'not-a-number' } }],
    })).toBeNull()
    expect(extractD1RowsRead({
      result: [{ meta: { rows_read: 123 } }],
    })).toBe(123)

    const evidence = await readWeeklyCleanupRowsEvidence({
      query: async () => ({
        rows: [{ city_code: 'Taipei', cleanup_rows: 1 }],
        rowsRead: -1,
      }),
    })
    expect([...evidence.rowsByCity.entries()]).toEqual([['Taipei', 1]])
    expect(evidence.rowsRead).toBeNull()
  })

  it('fails closed on malformed or duplicate aggregated cleanup rows', async () => {
    await expect(readWeeklyCleanupRowsByCity({
      query: async () => [{ city_code: 'Taipei', cleanup_rows: -1 }],
    })).rejects.toThrow('Weekly D1 cleanup rows are invalid')

    await expect(readWeeklyCleanupRowsByCity({
      query: async () => [
        { city_code: 'Taipei', cleanup_rows: 1 },
        { city_code: 'Taipei', cleanup_rows: 2 },
      ],
    })).rejects.toThrow('Weekly D1 cleanup rows are invalid')
  })

  it('covers every enabled weekly-sharded city exactly once and reports worst-case headroom', async () => {
    const estimates = new Map([
      ['Taoyuan', cityEstimate('Taoyuan', 12_000)],
      ['Taipei', cityEstimate('Taipei', 30_000)],
      ['Taichung', cityEstimate('Taichung', 31_500)],
    ])
    const estimateCity = vi.fn(async (city) => estimates.get(city))

    const report = await buildWeeklyD1WriteBudgetReport({
      plan,
      env: { SNAPSHOT_D1_WRITE_BUDGET: '75000' },
      estimateCity,
      now: () => new Date('2026-09-09T10:00:00.000Z'),
    })

    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedAt: '2026-09-09T10:00:00.000Z',
      snapshotSchedule: 'taipei-weekly-sharded',
      budgetRows: 75_000,
      enabledCityCount: 3,
      weeklyProjectedRows: 73_500,
      allDaysAllowed: true,
      maxProjectedDay: {
        weekday: 5,
        weekdayName: 'Friday',
        projectedRows: 31_500,
        headroomRows: 43_500,
      },
    })
    expect(report.days[0].cities.map(({ city }) => city)).toEqual(['Taoyuan'])
    expect(report.days[1].cities.map(({ city }) => city)).toEqual(['Taipei'])
    expect(report.days[5].cities.map(({ city }) => city)).toEqual(['Taichung'])
    expect(report.days.flatMap((day) => day.cities.map(({ city }) => city)).sort())
      .toEqual([...plan.enabledCities].sort())
    expect(estimateCity).toHaveBeenCalledTimes(3)
  })

  it('fails the proof when one complete changed shard would exceed the shared daily ledger', async () => {
    const estimateCity = vi.fn(async (city) => cityEstimate(city, city === 'Taoyuan' ? 75_001 : 1_000))
    const report = await buildWeeklyD1WriteBudgetReport({
      plan,
      env: { SNAPSHOT_D1_WRITE_BUDGET: '75000' },
      estimateCity,
    })
    expect(report.allDaysAllowed).toBe(false)
    expect(report.days[0]).toMatchObject({ projectedRows: 75_001, headroomRows: -1, allowed: false })
  })

  it('fails closed on invalid city estimates and non-weekly schedules', async () => {
    await expect(buildWeeklyD1WriteBudgetReport({
      plan,
      env: { SNAPSHOT_D1_WRITE_BUDGET: '75000' },
      estimateCity: async (city) => ({ city, estimate: { estimatedRows: 1 } }),
    })).rejects.toThrow('Weekly D1 budget estimate is invalid')

    await expect(buildWeeklyD1WriteBudgetReport({
      plan: { ...plan, snapshotSchedule: 'manual' },
      env: { SNAPSHOT_D1_WRITE_BUDGET: '75000' },
      estimateCity: vi.fn(),
    })).rejects.toThrow('requires taipei-weekly-sharded')
  })
})
