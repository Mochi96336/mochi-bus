import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { scheduledCitiesForTaipeiDate, validDateOnly } from './snapshot-schedule.mjs'

const DAILY_EVENT = 'snapshot_scheduled_d1_write_evidence'
const WEEKLY_EVENT = 'snapshot_full_weekly_d1_write_acceptance'
const DAY_COUNT = 7
const DEFAULT_BUDGET = 75_000
const MAX_EVIDENCE_BYTES = 2 * 1024 * 1024
const GIT_SHA = /^[a-f0-9]{40}$/

export function summarizeFullWeeklyD1WriteAcceptance(dailyEvidence) {
  if (!Array.isArray(dailyEvidence) || dailyEvidence.length !== DAY_COUNT) {
    throw new Error('Full-week D1 acceptance requires exactly seven daily evidence records')
  }

  const days = dailyEvidence.map(normalizeDailyEvidence)
    .sort((left, right) => left.scheduleDate.localeCompare(right.scheduleDate))
  const dates = days.map((day) => day.scheduleDate)
  if (new Set(dates).size !== DAY_COUNT) throw new Error('Full-week D1 acceptance contains duplicate schedule dates')

  const weekIsConsecutive = dates.every((date, index) => index === 0 || nextDate(dates[index - 1]) === date)
  const startsSunday = weekday(dates[0]) === 0
  const endsSaturday = weekday(dates[DAY_COUNT - 1]) === 6
  const expectedWeekCities = []
  const observedWeekCities = []
  const normalizedDays = []

  for (const day of days) {
    const scheduledCities = [...scheduledCitiesForTaipeiDate(day.scheduleDate)]
    expectedWeekCities.push(...scheduledCities)
    observedWeekCities.push(...day.actualCities)

    const expectedCitiesMatchSchedule = sameStrings(day.expectedCities, scheduledCities)
    const actualCitySetMatches = sameSet(day.actualCities, scheduledCities)
    const cityRowsTotal = day.cities.reduce((total, city) => total + city.rowsWritten, 0)
    const cityEvidenceComplete = day.cities.length === scheduledCities.length
      && sameSet(day.cities.map((city) => city.city), scheduledCities)
      && day.cities.every((city) => city.successfulWindow && city.metricsComplete)
    const budgetConsistent = day.budgetLimit >= 1
      && day.totalRowsWritten >= 0
      && day.totalRowsWritten === cityRowsTotal
      && day.headroom === day.budgetLimit - day.totalRowsWritten
    const withinDailyBudget = budgetConsistent && day.totalRowsWritten <= day.budgetLimit
    const provenanceComplete = day.workflowRunId !== null
      && day.workflowRunAttempt !== null
      && day.scriptGitSha !== null
    const dailyAcceptance = day.shardAcceptanceEvidence
      && day.exactCitySet
      && expectedCitiesMatchSchedule
      && actualCitySetMatches
      && cityEvidenceComplete
      && withinDailyBudget
      && provenanceComplete

    normalizedDays.push(Object.freeze({
      scheduleDate: day.scheduleDate,
      workflowRunId: day.workflowRunId,
      workflowRunAttempt: day.workflowRunAttempt,
      scriptGitSha: day.scriptGitSha,
      expectedCities: Object.freeze(scheduledCities),
      actualCities: Object.freeze([...day.actualCities]),
      budgetLimit: day.budgetLimit,
      totalRowsWritten: day.totalRowsWritten,
      headroom: day.headroom,
      expectedCitiesMatchSchedule,
      actualCitySetMatches,
      cityEvidenceComplete,
      budgetConsistent,
      withinDailyBudget,
      provenanceComplete,
      dailyAcceptance,
    }))
  }

  const expectedCitySet = new Set(expectedWeekCities)
  const observedCitySet = new Set(observedWeekCities)
  const expectedWeeklyCoverageUnique = expectedCitySet.size === expectedWeekCities.length
  const observedWeeklyCoverageUnique = observedCitySet.size === observedWeekCities.length
  const exactWeeklyCityCoverage = expectedWeeklyCoverageUnique
    && observedWeeklyCoverageUnique
    && sameSet(observedWeekCities, expectedWeekCities)
  const workflowRunIds = normalizedDays.map((day) => day.workflowRunId)
  const uniqueWorkflowRuns = workflowRunIds.every(Boolean)
    && new Set(workflowRunIds).size === DAY_COUNT
  const totalRowsWritten = normalizedDays.reduce((total, day) => total + day.totalRowsWritten, 0)
  const maxDailyRowsWritten = Math.max(...normalizedDays.map((day) => day.totalRowsWritten))
  const minDailyHeadroom = Math.min(...normalizedDays.map((day) => day.headroom))
  const fullWeeklyShardAcceptance = weekIsConsecutive
    && startsSunday
    && endsSaturday
    && exactWeeklyCityCoverage
    && uniqueWorkflowRuns
    && normalizedDays.every((day) => day.dailyAcceptance)

  return Object.freeze({
    schemaVersion: 1,
    event: WEEKLY_EVENT,
    weekStart: dates[0],
    weekEnd: dates[DAY_COUNT - 1],
    dayCount: DAY_COUNT,
    expectedCityCount: expectedWeekCities.length,
    observedCityCount: observedWeekCities.length,
    totalRowsWritten,
    maxDailyRowsWritten,
    minDailyHeadroom,
    weekIsConsecutive,
    startsSunday,
    endsSaturday,
    exactWeeklyCityCoverage,
    uniqueWorkflowRuns,
    workflowRunIds: Object.freeze(workflowRunIds),
    scriptGitShas: Object.freeze(normalizedDays.map((day) => day.scriptGitSha)),
    fullWeeklyShardAcceptance,
    days: Object.freeze(normalizedDays),
  })
}

export async function readDailyEvidenceRoot(root) {
  const names = (await readdir(root)).filter((name) => name.endsWith('.json')).sort()
  const evidence = []
  for (const name of names) {
    const text = await readFile(join(root, name), 'utf8')
    if (Buffer.byteLength(text, 'utf8') > MAX_EVIDENCE_BYTES) {
      throw new Error('Daily D1 evidence exceeded byte limit')
    }
    evidence.push(JSON.parse(text))
  }
  return evidence
}

export async function main(argv = process.argv.slice(2)) {
  const [evidenceRoot, outputFile] = argv
  if (!evidenceRoot || !outputFile) {
    throw new Error('Usage: summarize-full-weekly-d1-write-acceptance.mjs <daily-evidence-root> <output-json>')
  }

  let evidence
  try {
    evidence = summarizeFullWeeklyD1WriteAcceptance(await readDailyEvidenceRoot(evidenceRoot))
  } catch (error) {
    evidence = {
      schemaVersion: 1,
      event: WEEKLY_EVENT,
      weekStart: null,
      weekEnd: null,
      dayCount: 0,
      expectedCityCount: 0,
      observedCityCount: 0,
      totalRowsWritten: null,
      maxDailyRowsWritten: null,
      minDailyHeadroom: null,
      weekIsConsecutive: false,
      startsSunday: false,
      endsSaturday: false,
      exactWeeklyCityCoverage: false,
      uniqueWorkflowRuns: false,
      workflowRunIds: [],
      scriptGitShas: [],
      fullWeeklyShardAcceptance: false,
      days: [],
      failureReason: error instanceof Error ? bounded(error.message, 200) : 'invalid_input',
    }
  }

  await writeFile(outputFile, JSON.stringify(evidence))
  console.log(JSON.stringify(evidence))
  return evidence
}

function normalizeDailyEvidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Daily D1 evidence must be an object')
  if (value.schemaVersion !== 1 || value.event !== DAILY_EVENT) throw new Error('Daily D1 evidence schema is unsupported')
  const scheduleDate = validDateOnly(value.scheduleDate)
  const expectedCities = stringArray(value.expectedCities, 'expectedCities')
  const actualCities = stringArray(value.actualCities, 'actualCities')
  const cities = Array.isArray(value.cities) ? value.cities.map(normalizeCityEvidence) : invalid('cities')
  const workflowRunId = boundedString(value.workflowRunId, 64)
  const workflowRunAttempt = positiveInteger(value.workflowRunAttempt)
  const scriptGitSha = typeof value.scriptGitSha === 'string' && GIT_SHA.test(value.scriptGitSha) ? value.scriptGitSha : null
  const budgetLimit = positiveInteger(value.budgetLimit) ?? DEFAULT_BUDGET
  const totalRowsWritten = nonNegativeInteger(value.totalRowsWritten)
  const headroom = safeInteger(value.headroom)
  if (totalRowsWritten === null || headroom === null) throw new Error('Daily D1 evidence write totals are invalid')

  return Object.freeze({
    scheduleDate,
    workflowRunId,
    workflowRunAttempt,
    scriptGitSha,
    expectedCities: Object.freeze(expectedCities),
    actualCities: Object.freeze(actualCities),
    budgetLimit,
    totalRowsWritten,
    headroom,
    exactCitySet: value.exactCitySet === true,
    shardAcceptanceEvidence: value.shardAcceptanceEvidence === true,
    cities: Object.freeze(cities),
  })
}

function normalizeCityEvidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Daily city evidence must be an object')
  const city = boundedString(value.city, 64)
  const rowsWritten = nonNegativeInteger(value.rowsWritten)
  if (!city || rowsWritten === null) throw new Error('Daily city evidence is invalid')
  return Object.freeze({
    city,
    rowsWritten,
    successfulWindow: value.successfulWindow === true,
    metricsComplete: value.metricsComplete === true,
  })
}

function stringArray(value, field) {
  if (!Array.isArray(value) || value.some((entry) => !boundedString(entry, 64))) invalid(field)
  return [...value]
}

function invalid(field) {
  throw new Error(`Daily D1 evidence ${field} is invalid`)
}

function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function sameSet(left, right) {
  if (left.length !== right.length) return false
  const leftSorted = [...left].sort()
  const rightSorted = [...right].sort()
  return sameStrings(leftSorted, rightSorted)
}

function nextDate(value) {
  const date = new Date(`${validDateOnly(value)}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + 1)
  return date.toISOString().slice(0, 10)
}

function weekday(value) {
  return new Date(`${validDateOnly(value)}T00:00:00.000Z`).getUTCDay()
}

function boundedString(value, maxLength) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text && text.length <= maxLength ? text : null
}

function bounded(value, maxLength) {
  const text = typeof value === 'string' ? value : String(value ?? '')
  return text.slice(0, maxLength)
}

function positiveInteger(value) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 1 ? number : null
}

function nonNegativeInteger(value) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 0 ? number : null
}

function safeInteger(value) {
  const number = Number(value)
  return Number.isSafeInteger(number) ? number : null
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Full-week D1 acceptance summary failed')
    process.exitCode = 1
  })
}
