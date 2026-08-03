import { describe, expect, it, vi } from 'vitest'
import { operationEnabledCities } from '../instance/operations-plan.mjs'
import { evaluateWindowWatchdog } from './watchdog-contract.mjs'
import { runWindowWatchdog, watchdogSummaryMarkdown } from './run-window-watchdog.mjs'
import {
  scheduledCitiesForTaipeiDate,
  SNAPSHOT_SUPPORTED_CITIES_BY_TAIPEI_WEEKDAY,
  taipeiLocalTimeAsUtc,
} from './snapshot-schedule.mjs'

const scheduleDates = [
  '2026-07-19',
  '2026-07-20',
  '2026-07-21',
  '2026-07-22',
  '2026-07-23',
  '2026-07-24',
  '2026-07-25',
]
const firstEnabledCity = operationEnabledCities()[0]
const targetWeekday = SNAPSHOT_SUPPORTED_CITIES_BY_TAIPEI_WEEKDAY
  .findIndex((cities) => cities.includes(firstEnabledCity))
const scheduleDate = scheduleDates[targetWeekday]
const previousScheduleDate = new Date(`${scheduleDate}T00:00:00.000Z`)
previousScheduleDate.setUTCDate(previousScheduleDate.getUTCDate() - 7)
const previousDate = previousScheduleDate.toISOString().slice(0, 10)
const expectedCities = [...scheduledCitiesForTaipeiDate(scheduleDate)]
const evaluatedAt = taipeiLocalTimeAsUtc(scheduleDate, 7, 45).toISOString()

function evidence(city, overrides = {}) {
  const windowId = `v1:${city}:${scheduleDate}:0317`
  return {
    window: {
      schemaVersion: 1,
      city,
      windowId,
      completedAt: taipeiLocalTimeAsUtc(scheduleDate, 3, 29).toISOString(),
      result: 'unchanged',
      lastSourceCheckAt: taipeiLocalTimeAsUtc(scheduleDate, 3, 20).toISOString(),
      lastPublishedAt: taipeiLocalTimeAsUtc(previousDate, 3, 27).toISOString(),
      activeVersion: `${city}-v1`,
      previousVersion: `${city}-v0`,
      failureClass: 'none',
    },
    sameWindowProbe: {
      probeSchemaVersion: 1,
      city,
      windowId,
      activeVersion: `${city}-v1`,
      previousVersion: `${city}-v0`,
      activeProbeAt: taipeiLocalTimeAsUtc(scheduleDate, 3, 26).toISOString(),
      activeProbeResult: 'success',
      probeFailureClass: 'none',
      rollbackAvailable: true,
    },
    latestUsableProbe: null,
    attemptSummary: { attemptCount: 1, incompleteAttemptCount: 0 },
    recordWriteFailure: false,
    ...overrides,
  }
}

function store(overrides = {}) {
  return {
    startRun: vi.fn(async () => undefined),
    readEvidence: vi.fn(async (city) => evidence(city)),
    completeCity: vi.fn(async () => undefined),
    completeRun: vi.fn(async () => undefined),
    ...overrides,
  }
}

function fixedClock() {
  return () => new Date(evaluatedAt)
}

function monotonicClock() {
  let value = 0
  return () => (value += 10)
}

describe('window watchdog runner', () => {
  it('evaluates every enabled city in the closed window', async () => {
    const target = store()
    const emitter = vi.fn()
    const result = await runWindowWatchdog({
      env: { GITHUB_RUN_ID: '300', GITHUB_RUN_ATTEMPT: '1' },
      now: fixedClock(), monotonic: monotonicClock(), store: target, emitter, summaryWriter: vi.fn(),
    })

    expect(result.ok).toBe(true)
    expect(result.summary.results.map((item) => [item.city, item.status])).toEqual(
      expectedCities.map((city) => [city, 'unchanged_healthy']),
    )
    expect(target.readEvidence).toHaveBeenCalledTimes(expectedCities.length)
    expect(target.completeCity).toHaveBeenCalledTimes(expectedCities.length)
    expect(emitter).toHaveBeenCalledTimes(expectedCities.length)
  })

  it('does not let one city query failure prevent the remaining enabled cities', async () => {
    const failedCity = expectedCities[0]
    const target = store({
      readEvidence: vi.fn(async (city) => {
        if (city === failedCity) throw new Error('private database detail')
        return evidence(city)
      }),
    })
    const result = await runWindowWatchdog({
      now: fixedClock(), monotonic: monotonicClock(), store: target,
      emitter: vi.fn(), summaryWriter: vi.fn(),
    })

    expect(result.ok).toBe(false)
    expect(result.failedCities).toEqual([failedCity])
    expect(result.summary.results).toHaveLength(expectedCities.length)
    expect(result.summary.results[0]).toMatchObject({
      city: failedCity, status: 'unknown', diagnosticClass: 'watchdog_query_failed',
    })
    expect(result.summary.results.slice(1).every((item) => item.status === 'unchanged_healthy')).toBe(true)
  })

  it('reports city durable-write failure without modifying snapshot state', async () => {
    const failedCity = expectedCities[0]
    const target = store({
      completeCity: vi.fn(async (_runId, result) => {
        if (result.city === failedCity) throw new Error('D1 write unavailable')
      }),
    })
    const result = await runWindowWatchdog({
      now: fixedClock(), monotonic: monotonicClock(), store: target,
      emitter: vi.fn(), summaryWriter: vi.fn(),
    })

    expect(result.summary.results[0]).toMatchObject({
      city: failedCity, status: 'record_write_failed', diagnosticClass: 'record_write_failed',
    })
    expect(result.ok).toBe(false)
    expect(target).not.toHaveProperty('activate')
    expect(target).not.toHaveProperty('writeR2')
  })

  it('keeps city evaluation independent when telemetry emission fails', async () => {
    const target = store()
    const result = await runWindowWatchdog({
      now: fixedClock(), monotonic: monotonicClock(), store: target,
      emitter: () => { throw new Error('logs unavailable') }, summaryWriter: vi.fn(),
    })
    expect(result.ok).toBe(true)
    expect(target.completeCity).toHaveBeenCalledTimes(expectedCities.length)
  })

  it('fails the job for rollback degraded while saying current service remains usable', async () => {
    const target = store({
      readEvidence: vi.fn(async (city) => evidence(city, {
        sameWindowProbe: {
          ...evidence(city).sameWindowProbe,
          activeProbeResult: 'degraded',
          probeFailureClass: 'previous_unavailable',
          rollbackAvailable: false,
        },
      })),
    })
    const result = await runWindowWatchdog({
      now: fixedClock(), monotonic: monotonicClock(), store: target,
      emitter: vi.fn(), summaryWriter: vi.fn(),
    })
    const markdown = watchdogSummaryMarkdown(result.summary)
    expect(result.ok).toBe(false)
    expect(markdown).toContain(`- Unchanged rollback degraded: ${expectedCities.join(', ')}`)
    expect(markdown).toContain('unchanged_rollback_degraded')
  })

  it('renders only fixed safe summary fields', () => {
    const city = expectedCities[0]
    const result = evaluateWindowWatchdog({
      city, scheduleDate, evaluatedAt,
      ...evidence(city),
    })
    const markdown = watchdogSummaryMarkdown({ scheduleDate, evaluatedAt, results: [result] })
    expect(markdown).toContain(`| ${city} | v1:${city}:${scheduleDate}:0317 | unchanged_healthy |`)
    expect(markdown).not.toMatch(/route|place|artifact|https?:|authorization|token|stack|raw error/i)
  })
})
