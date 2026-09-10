import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'

export const D1_READ_INSIGHTS_SCHEMA_VERSION = 1
export const MAX_D1_INSIGHTS_ITEMS = 100
export const MAX_QUERY_SHAPE_LENGTH = 640
const DEFAULT_RAW_PATH = '.transit-snapshot/d1-read-insights.raw.json'
const DEFAULT_REPORT_PATH = '.transit-snapshot/d1-read-insights.json'

export function sanitizeQueryShape(query) {
  if (typeof query !== 'string' || !query.trim()) return '<unknown>'

  const withoutComments = query
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\r\n]*/g, ' ')
  const withoutStrings = withoutComments
    .replace(/'(?:''|[^'])*'/g, '?')
    .replace(/"(?:""|[^"])*"/g, '?')
  const withoutNumbers = withoutStrings
    .replace(/\b(?:0x[0-9a-f]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)\b/gi, '?')
  const normalized = withoutNumbers
    .replace(/\s+/g, ' ')
    .trim()

  if (!normalized) return '<unknown>'
  return normalized.length > MAX_QUERY_SHAPE_LENGTH
    ? `${normalized.slice(0, MAX_QUERY_SHAPE_LENGTH - 1)}…`
    : normalized
}

export function buildD1ReadInsightsReport(raw, {
  generatedAt = new Date().toISOString(),
  timePeriod = '1d',
} = {}) {
  if (!Array.isArray(raw) || raw.length > MAX_D1_INSIGHTS_ITEMS) {
    throw new Error('D1 read insights payload must be a bounded array')
  }

  const queries = raw.map((item, index) => normalizeInsight(item, index))
    .sort((a, b) => b.totalRowsRead - a.totalRowsRead || b.numberOfTimesRun - a.numberOfTimesRun)
  const capturedTotalRowsRead = queries.reduce((sum, item) => checkedAdd(sum, item.totalRowsRead), 0)
  const capturedExecutions = queries.reduce((sum, item) => checkedAdd(sum, item.numberOfTimesRun), 0)

  return Object.freeze({
    schemaVersion: D1_READ_INSIGHTS_SCHEMA_VERSION,
    generatedAt,
    timePeriod,
    capturedQueryCount: queries.length,
    capturedTotalRowsRead,
    capturedExecutions,
    queries: Object.freeze(queries),
  })
}

function normalizeInsight(item, index) {
  if (!item || typeof item !== 'object') throw new Error(`D1 insight ${index} is invalid`)
  const shape = sanitizeQueryShape(item.query)
  return Object.freeze({
    queryFingerprint: createHash('sha256').update(shape).digest('hex').slice(0, 16),
    queryShape: shape,
    totalRowsRead: nonNegativeSafeInteger(item.totalRowsRead, `insight ${index}.totalRowsRead`),
    avgRowsRead: nonNegativeFinite(item.avgRowsRead, `insight ${index}.avgRowsRead`),
    numberOfTimesRun: nonNegativeSafeInteger(item.numberOfTimesRun, `insight ${index}.numberOfTimesRun`),
    avgDurationMs: nonNegativeFinite(item.avgDurationMs, `insight ${index}.avgDurationMs`),
    queryEfficiency: nullableNonNegativeFinite(item.queryEfficiency, `insight ${index}.queryEfficiency`),
  })
}

function nonNegativeSafeInteger(value, name) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${name} must be a non-negative safe integer`)
  return number
}

function nonNegativeFinite(value, name) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) throw new Error(`${name} must be a non-negative finite number`)
  return number
}

function nullableNonNegativeFinite(value, name) {
  if (value === undefined || value === null) return null
  return nonNegativeFinite(value, name)
}

function checkedAdd(left, right) {
  const result = left + right
  if (!Number.isSafeInteger(result)) throw new Error('D1 read insights aggregate overflow')
  return result
}

async function writeSummary(report, path) {
  const rows = report.queries.slice(0, 10).map((item) =>
    `| \`${item.queryFingerprint}\` | ${item.totalRowsRead} | ${item.avgRowsRead} | ${item.numberOfTimesRun} | \`${escapeMarkdown(item.queryShape)}\` |`)
  await appendFile(path, [
    '## D1 read insights',
    '',
    `Window: ${report.timePeriod}; captured queries: ${report.capturedQueryCount}; captured rows read: ${report.capturedTotalRowsRead}.`,
    '',
    '| Query | totalRowsRead | avgRowsRead | executions | Sanitized shape |',
    '| --- | ---: | ---: | ---: | --- |',
    ...rows,
    '',
  ].join('\n'))
}

function escapeMarkdown(value) {
  return String(value).replace(/\|/g, '\\|').replace(/`/g, "'")
}

export async function main(env = process.env) {
  const rawPath = env.D1_INSIGHTS_RAW_PATH || DEFAULT_RAW_PATH
  const reportPath = env.D1_INSIGHTS_REPORT_PATH || DEFAULT_REPORT_PATH
  const timePeriod = env.D1_INSIGHTS_TIME_PERIOD || '1d'
  const raw = JSON.parse(await readFile(rawPath, 'utf8'))
  const report = buildD1ReadInsightsReport(raw, { timePeriod })
  await mkdir(dirname(reportPath), { recursive: true })
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  if (env.GITHUB_STEP_SUMMARY) await writeSummary(report, env.GITHUB_STEP_SUMMARY)
  console.log(JSON.stringify({
    event: 'd1_read_insights',
    reportPath,
    timePeriod: report.timePeriod,
    capturedQueryCount: report.capturedQueryCount,
    capturedTotalRowsRead: report.capturedTotalRowsRead,
    capturedExecutions: report.capturedExecutions,
    topQueries: report.queries.slice(0, 5).map(({ queryFingerprint, totalRowsRead, avgRowsRead, numberOfTimesRun, queryShape }) => ({
      queryFingerprint,
      totalRowsRead,
      avgRowsRead,
      numberOfTimesRun,
      queryShape,
    })),
  }))
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify({
      event: 'd1_read_insights_error',
      message: error instanceof Error ? error.message : String(error),
    }))
    process.exitCode = 1
  })
}
