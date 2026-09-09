import { describe, expect, it, vi } from 'vitest'
import { buildWeeklyD1WriteBudgetReport } from './weekly-d1-write-budget.mjs'

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
