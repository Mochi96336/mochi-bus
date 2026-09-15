import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseObservedD1WriteRecord } from './observed-d1-write.mjs'
import { parseWindowSummary } from './window-contract.mjs'
import { scheduledCitiesForTaipeiDate } from './snapshot-schedule.mjs'

const WINDOW_ID = /^v1:([A-Za-z][A-Za-z0-9]{0,63}):(\d{4}-\d{2}-\d{2}):0317$/
const PUBLISHER_D1_FILE = /^(?:import-\d+\.sql|cleanup\.sql)$/
const DEFAULT_BUDGET = 75_000
const DEFAULT_PUBLISHER_ROOT = '.transit-snapshot'
const MAX_RAW_BYTES = 16 * 1024 * 1024

export async function summarizeScheduledD1WriteEvidence({
  summaryRoot,
  publisherRoot = DEFAULT_PUBLISHER_ROOT,
  observedFile,
  env = process.env,
} = {}) {
  const summaries = await readWindowSummaries(summaryRoot)
  const records = await readObservedRecords(observedFile)
  const workflowRunId = bounded(env.GITHUB_RUN_ID, 64)
  const workflowRunAttempt = positiveInteger(env.GITHUB_RUN_ATTEMPT)
  const scriptGitSha = fullGitSha(env.GITHUB_SHA)
  const budgetLimit = positiveInteger(env.SNAPSHOT_D1_WRITE_BUDGET) ?? DEFAULT_BUDGET

  const summaryDates = new Set()
  const summaryByCity = new Map()
  for (const summary of summaries) {
    const match = summary.windowId.match(WINDOW_ID)
    if (!match || match[1] !== summary.city) throw new Error('Scheduled D1 evidence window identity is invalid')
    summaryDates.add(match[2])
    if (summaryByCity.has(summary.city)) throw new Error('Scheduled D1 evidence contains duplicate city summaries')
    summaryByCity.set(summary.city, summary)
  }
  if (summaryDates.size !== 1) throw new Error('Scheduled D1 evidence requires exactly one schedule date')
  const scheduleDate = [...summaryDates][0]
  const expectedCities = [...scheduledCitiesForTaipeiDate(scheduleDate)]
  if (expectedCities.length === 0) throw new Error('Scheduled D1 evidence date has no scheduled cities')

  const recordByCity = new Map(expectedCities.map((city) => [city, []]))
  for (const record of records) {
    if (record.workflowRunId !== workflowRunId
      || record.workflowRunAttempt !== workflowRunAttempt
      || record.scriptGitSha !== scriptGitSha) {
      throw new Error('Scheduled D1 observed metrics provenance does not match this workflow run')
    }
    const expectedWindowId = `v1:${record.city}:${scheduleDate}:0317`
    if (!recordByCity.has(record.city) || record.windowId !== expectedWindowId) {
      throw new Error('Scheduled D1 observed metrics do not match the scheduled shard')
    }
    recordByCity.get(record.city).push(record)
  }

  const actualCities = [...summaryByCity.keys()].sort()
  const expectedSorted = [...expectedCities].sort()
  const exactCitySet = actualCities.length === expectedSorted.length
    && actualCities.every((city, index) => city === expectedSorted[index])
  const cities = []
  for (const city of expectedCities) {
    const summary = summaryByCity.get(city) ?? null
    const cityRecords = recordByCity.get(city) ?? []
    const stageRowsWritten = sum(cityRecords.filter((record) => record.phase === 'stage'), 'rowsWritten')
    const cleanupRowsWritten = sum(cityRecords.filter((record) => record.phase === 'cleanup'), 'rowsWritten')
    const rowsWritten = stageRowsWritten + cleanupRowsWritten
    const successfulWindow = summary !== null
      && (summary.result === 'published' || summary.result === 'unchanged')
      && summary.durableRecordWrite === 'success'
      && (summary.activeProbeResult === 'success' || summary.activeProbeResult === 'degraded')
    const expectedSourceFiles = summary?.result === 'published'
      ? await readExpectedPublisherFiles(publisherRoot, city)
      : []
    const observedSourceFiles = cityRecords.map((record) => record.sourceFile).sort()
    const metricsComplete = summary?.result === 'published'
      ? expectedSourceFiles.some((name) => name.startsWith('import-'))
        && sameStrings(observedSourceFiles, expectedSourceFiles)
      : summary?.result === 'unchanged'
        ? cityRecords.length === 0
        : false
    cities.push(Object.freeze({
      city,
      windowId: summary?.windowId ?? `v1:${city}:${scheduleDate}:0317`,
      result: summary?.result ?? 'missing',
      activeVersion: summary?.activeVersion ?? null,
      durableRecordWrite: summary?.durableRecordWrite ?? 'missing',
      activeProbeResult: summary?.activeProbeResult ?? null,
      stageRowsWritten,
      cleanupRowsWritten,
      rowsWritten,
      expectedExecutions: expectedSourceFiles.length,
      observedExecutions: cityRecords.length,
      expectedSourceFiles: Object.freeze(expectedSourceFiles),
      observedSourceFiles: Object.freeze(observedSourceFiles),
      successfulWindow,
      metricsComplete,
    }))
  }
  const totalRowsWritten = cities.reduce((total, city) => total + city.rowsWritten, 0)
  const shardAcceptanceEvidence = exactCitySet
    && cities.every((city) => city.successfulWindow && city.metricsComplete)
    && totalRowsWritten <= budgetLimit

  return Object.freeze({
    schemaVersion: 1,
    event: 'snapshot_scheduled_d1_write_evidence',
    scheduleDate,
    workflowRunId,
    workflowRunAttempt,
    scriptGitSha,
    expectedCities: Object.freeze(expectedCities),
    actualCities: Object.freeze(actualCities),
    budgetLimit,
    totalRowsWritten,
    headroom: budgetLimit - totalRowsWritten,
    publishedCount: cities.filter((city) => city.result === 'published').length,
    unchangedCount: cities.filter((city) => city.result === 'unchanged').length,
    exactCitySet,
    shardAcceptanceEvidence,
    cities: Object.freeze(cities),
  })
}

export async function main(env = process.env, argv = process.argv.slice(2)) {
  const [summaryRoot, observedFile, outputFile] = argv
  if (!summaryRoot || !observedFile || !outputFile) {
    throw new Error('Usage: summarize-scheduled-d1-write-evidence.mjs <summary-root> <observed-jsonl> <output-json>')
  }
  let evidence
  try {
    evidence = await summarizeScheduledD1WriteEvidence({
      summaryRoot,
      publisherRoot: env.SNAPSHOT_D1_PUBLISHER_ROOT ?? DEFAULT_PUBLISHER_ROOT,
      observedFile,
      env,
    })
  } catch {
    evidence = {
      schemaVersion: 1,
      event: 'snapshot_scheduled_d1_write_evidence',
      scheduleDate: null,
      workflowRunId: bounded(env.GITHUB_RUN_ID, 64),
      workflowRunAttempt: positiveInteger(env.GITHUB_RUN_ATTEMPT),
      scriptGitSha: fullGitSha(env.GITHUB_SHA),
      expectedCities: [],
      actualCities: [],
      budgetLimit: positiveInteger(env.SNAPSHOT_D1_WRITE_BUDGET) ?? DEFAULT_BUDGET,
      totalRowsWritten: null,
      headroom: null,
      publishedCount: 0,
      unchangedCount: 0,
      exactCitySet: false,
      shardAcceptanceEvidence: false,
      cities: [],
    }
  }
  await writeFile(outputFile, JSON.stringify(evidence))
  console.log(JSON.stringify(evidence))
  return evidence
}

async function readWindowSummaries(root) {
  let names
  try {
    names = await readdir(root)
  } catch {
    return []
  }
  const summaries = []
  for (const name of names.filter((entry) => entry.endsWith('.json')).sort()) {
    const text = await readFile(join(root, name), 'utf8')
    summaries.push(parseWindowSummary(JSON.parse(text)))
  }
  return summaries
}

async function readObservedRecords(file) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return []
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_RAW_BYTES) throw new Error('Scheduled D1 observed metrics exceeded byte limit')
  return text.split('\n').filter(Boolean).map((line) => parseObservedD1WriteRecord(JSON.parse(line)))
}

async function readExpectedPublisherFiles(root, city) {
  let names
  try {
    names = await readdir(join(root, city))
  } catch {
    return []
  }
  return names.filter((name) => PUBLISHER_D1_FILE.test(name)).sort()
}

function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function sum(records, field) {
  return records.reduce((total, record) => total + record[field], 0)
}

function bounded(value, maxLength) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text && text.length <= maxLength ? text : null
}

function positiveInteger(value) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 1 ? number : null
}

function fullGitSha(value) {
  return typeof value === 'string' && /^[a-f0-9]{40}$/.test(value) ? value : null
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Scheduled D1 evidence summary failed')
    process.exitCode = 1
  })
}
