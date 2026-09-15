import { describe, expect, it } from 'vitest'
import { scheduledCitiesForTaipeiDate } from './snapshot-schedule.mjs'
import { summarizeFullWeeklyD1WriteAcceptance } from './summarize-full-weekly-d1-write-acceptance.mjs'

const weekStart = '2026-09-13' // Sunday
const dates = Array.from({ length: 7 }, (_, index) => addDays(weekStart, index))
const sha = 'a'.repeat(40)

function dailyEvidence(scheduleDate, index) {
  const expectedCities = [...scheduledCitiesForTaipeiDate(scheduleDate)]
  const cities = expectedCities.map((city) => ({
    city,
    rowsWritten: 100,
    successfulWindow: true,
    metricsComplete: true,
  }))
  const totalRowsWritten = cities.reduce((total, city) => total + city.rowsWritten, 0)
  return {
    schemaVersion: 1,
    event: 'snapshot_scheduled_d1_write_evidence',
    scheduleDate,
    workflowRunId: String(1000 + index),
    workflowRunAttempt: 1,
    scriptGitSha: sha,
    expectedCities,
    actualCities: [...expectedCities].sort(),
    budgetLimit: 75000,
    totalRowsWritten,
    headroom: 75000 - totalRowsWritten,
    publishedCount: expectedCities.length,
    unchangedCount: 0,
    exactCitySet: true,
    shardAcceptanceEvidence: true,
    cities,
  }
}

function acceptedWeek() {
  return dates.map(dailyEvidence)
}

describe('full weekly observed D1 write acceptance', () => {
  it('accepts one complete Sunday-to-Saturday production schedule exactly once', () => {
    const evidence = summarizeFullWeeklyD1WriteAcceptance(acceptedWeek())
    expect(evidence).toMatchObject({
      weekStart: '2026-09-13',
      weekEnd: '2026-09-19',
      dayCount: 7,
      expectedCityCount: 22,
      observedCityCount: 22,
      weekIsConsecutive: true,
      startsSunday: true,
      endsSaturday: true,
      exactWeeklyCityCoverage: true,
      uniqueWorkflowRuns: true,
      fullWeeklyShardAcceptance: true,
    })
    expect(evidence.workflowRunIds).toEqual(['1000', '1001', '1002', '1003', '1004', '1005', '1006'])
    expect(evidence.days.every((day) => day.dailyAcceptance)).toBe(true)
  })

  it('requires exactly seven daily evidence records', () => {
    expect(() => summarizeFullWeeklyD1WriteAcceptance(acceptedWeek().slice(0, 6)))
      .toThrow(/exactly seven/)
  })

  it('fails closed when a daily shard did not earn acceptance', () => {
    const week = acceptedWeek()
    week[3] = { ...week[3], shardAcceptanceEvidence: false }
    const evidence = summarizeFullWeeklyD1WriteAcceptance(week)
    expect(evidence.days[3].dailyAcceptance).toBe(false)
    expect(evidence.fullWeeklyShardAcceptance).toBe(false)
  })

  it('fails closed when two scheduled days reuse the same workflow run provenance', () => {
    const week = acceptedWeek()
    week[6] = { ...week[6], workflowRunId: week[5].workflowRunId }
    const evidence = summarizeFullWeeklyD1WriteAcceptance(week)
    expect(evidence.uniqueWorkflowRuns).toBe(false)
    expect(evidence.fullWeeklyShardAcceptance).toBe(false)
  })

  it('fails closed when a daily artifact claims the wrong scheduled city set', () => {
    const week = acceptedWeek()
    week[2] = {
      ...week[2],
      expectedCities: [...week[2].expectedCities, 'Taichung'],
      actualCities: [...week[2].actualCities, 'Taichung'].sort(),
      cities: [...week[2].cities, {
        city: 'Taichung', rowsWritten: 0, successfulWindow: true, metricsComplete: true,
      }],
    }
    const evidence = summarizeFullWeeklyD1WriteAcceptance(week)
    expect(evidence.days[2].expectedCitiesMatchSchedule).toBe(false)
    expect(evidence.fullWeeklyShardAcceptance).toBe(false)
  })

  it('fails closed when daily row totals do not match city evidence', () => {
    const week = acceptedWeek()
    week[4] = { ...week[4], totalRowsWritten: week[4].totalRowsWritten + 1 }
    const evidence = summarizeFullWeeklyD1WriteAcceptance(week)
    expect(evidence.days[4].budgetConsistent).toBe(false)
    expect(evidence.fullWeeklyShardAcceptance).toBe(false)
  })

  it('requires a Sunday-to-Saturday calendar boundary, not merely seven accepted dates', () => {
    const mondayStart = '2026-09-14'
    const week = Array.from({ length: 7 }, (_, index) => dailyEvidence(addDays(mondayStart, index), index))
    const evidence = summarizeFullWeeklyD1WriteAcceptance(week)
    expect(evidence.weekIsConsecutive).toBe(true)
    expect(evidence.startsSunday).toBe(false)
    expect(evidence.endsSaturday).toBe(false)
    expect(evidence.fullWeeklyShardAcceptance).toBe(false)
  })
})

function addDays(value, days) {
  const date = new Date(`${value}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}
