import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'

export const D1_READ_INSIGHTS_SCHEMA_VERSION = 2
export const MAX_D1_INSIGHTS_ITEMS = 100
export const MAX_QUERY_SHAPE_LENGTH = 640
const DEFAULT_REPORT_PATH = '.transit-snapshot/d1-read-insights.json'
const GRAPHQL_ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql'
const QUERY_LIMIT = 25
const MAX_GRAPHQL_RESPONSE_BYTES = 512 * 1024
const MAX_GRAPHQL_ERROR_DETAIL = 360

const QUERY_GROUPS_DOCUMENT = `
query getD1QueriesOverviewQuery($accountTag: string, $filter: AccountD1QueriesAdaptiveGroupsFilter_InputObject) {
  viewer {
    accounts(filter: {accountTag: $accountTag}) {
      d1QueriesAdaptiveGroups(limit: 25, filter: $filter, orderBy: [sum_rowsRead_DESC]) {
        sum { queryDurationMs rowsRead rowsWritten rowsReturned }
        avg { queryDurationMs rowsRead rowsWritten rowsReturned }
        count
        dimensions { query }
      }
    }
  }
}`

const DAILY_TOTALS_DOCUMENT = `
query getD1DailyTotals($accountTag: string!, $start: Date, $end: Date, $databaseId: string) {
  viewer {
    accounts(filter: {accountTag: $accountTag}) {
      d1AnalyticsAdaptiveGroups(
        limit: 32
        filter: {date_geq: $start, date_leq: $end, databaseId: $databaseId}
        orderBy: [date_DESC]
      ) {
        sum { readQueries writeQueries rowsRead rowsWritten }
        dimensions { date databaseId }
      }
    }
  }
}`

export function sanitizeQueryShape(query) {
  if (typeof query !== 'string' || !query.trim()) return '<query-unavailable>'

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

  if (!normalized) return '<query-unavailable>'
  return normalized.length > MAX_QUERY_SHAPE_LENGTH
    ? `${normalized.slice(0, MAX_QUERY_SHAPE_LENGTH - 1)}…`
    : normalized
}

export async function fetchD1ReadAttribution({
  accountId,
  apiToken,
  databaseId,
  fetchImpl = fetch,
  now = () => new Date(),
} = {}) {
  requireToken(accountId, 'CLOUDFLARE_ACCOUNT_ID')
  requireToken(apiToken, 'CLOUDFLARE_API_TOKEN')
  requireToken(databaseId, 'D1_DATABASE_ID')

  const end = now()
  if (!(end instanceof Date) || Number.isNaN(end.getTime())) throw new Error('D1 insights clock is invalid')

  const oneDay = await fetchQueryGroups({
    accountId,
    apiToken,
    databaseId,
    fetchImpl,
    start: new Date(end.getTime() - 24 * 60 * 60 * 1000),
    end,
  })
  let queryWindowUsed = '1d'
  let queryGroups = oneDay
  if (oneDay.length === 0) {
    queryWindowUsed = '7d'
    queryGroups = await fetchQueryGroups({
      accountId,
      apiToken,
      databaseId,
      fetchImpl,
      start: new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000),
      end,
    })
  }

  const startDate = new Date(end.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const endDate = end.toISOString().slice(0, 10)
  const dailyTotals = await fetchDailyTotals({
    accountId,
    apiToken,
    databaseId,
    fetchImpl,
    startDate,
    endDate,
  })

  return Object.freeze({ queryWindowUsed, queryGroups, dailyTotals })
}

async function fetchQueryGroups({ accountId, apiToken, databaseId, fetchImpl, start, end }) {
  const payload = await fetchGraphql({
    apiToken,
    fetchImpl,
    body: {
      query: QUERY_GROUPS_DOCUMENT,
      operationName: 'getD1QueriesOverviewQuery',
      variables: {
        accountTag: accountId,
        filter: {
          AND: [{
            datetimeHour_geq: start.toISOString(),
            datetimeHour_leq: end.toISOString(),
            databaseId,
          }],
        },
      },
    },
  })
  const groups = payload?.data?.viewer?.accounts?.[0]?.d1QueriesAdaptiveGroups
  if (!Array.isArray(groups) || groups.length > QUERY_LIMIT) {
    throw new Error('D1 query analytics groups are invalid')
  }
  return groups
}

async function fetchDailyTotals({ accountId, apiToken, databaseId, fetchImpl, startDate, endDate }) {
  const payload = await fetchGraphql({
    apiToken,
    fetchImpl,
    body: {
      query: DAILY_TOTALS_DOCUMENT,
      operationName: 'getD1DailyTotals',
      variables: { accountTag: accountId, databaseId, start: startDate, end: endDate },
    },
  })
  const groups = payload?.data?.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups
  if (!Array.isArray(groups) || groups.length > 32) throw new Error('D1 daily analytics groups are invalid')
  return groups
}

async function fetchGraphql({ apiToken, fetchImpl, body }) {
  const response = await fetchImpl(GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
  const text = await response.text()
  if (new TextEncoder().encode(text).byteLength > MAX_GRAPHQL_RESPONSE_BYTES) {
    throw new Error('D1 GraphQL analytics response is too large')
  }
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error('D1 GraphQL analytics returned invalid JSON')
  }
  if (!response.ok || !payload?.data || (Array.isArray(payload?.errors) && payload.errors.length > 0)) {
    const detail = graphqlErrorDetail(payload?.errors, [apiToken, ...stringValues(body?.variables)])
    throw new Error(`D1 GraphQL analytics request failed (HTTP ${response.status})${detail ? `: ${detail}` : ''}`)
  }
  return payload
}

function graphqlErrorDetail(errors, sensitiveValues = []) {
  if (!Array.isArray(errors) || errors.length === 0) return ''
  const redactions = [...new Set(sensitiveValues.filter((value) => typeof value === 'string' && value.length > 0))]
    .sort((a, b) => b.length - a.length)
  const pieces = errors.slice(0, 3).map((error) => {
    const code = error?.extensions?.code
    const prefix = typeof code === 'string' || typeof code === 'number' ? `[${String(code)}] ` : ''
    let message = typeof error?.message === 'string' ? error.message : 'GraphQL error'
    for (const value of redactions) message = message.split(value).join('<redacted>')
    message = message.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
    return `${prefix}${message}`
  })
  const detail = pieces.join(' | ')
  return detail.length > MAX_GRAPHQL_ERROR_DETAIL
    ? `${detail.slice(0, MAX_GRAPHQL_ERROR_DETAIL - 1)}…`
    : detail
}

function stringValues(value, result = []) {
  if (typeof value === 'string') {
    result.push(value)
    return result
  }
  if (Array.isArray(value)) {
    for (const item of value) stringValues(item, result)
    return result
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) stringValues(item, result)
  }
  return result
}

export function buildD1ReadInsightsReport(raw, {
  generatedAt = new Date().toISOString(),
  requestedTimePeriod = '1d',
} = {}) {
  const groups = raw?.queryGroups
  const daily = raw?.dailyTotals
  if (!Array.isArray(groups) || groups.length > MAX_D1_INSIGHTS_ITEMS || !Array.isArray(daily) || daily.length > 32) {
    throw new Error('D1 read attribution payload is invalid')
  }

  const queries = groups.map((item, index) => normalizeGraphqlInsight(item, index))
    .sort((a, b) => b.totalRowsRead - a.totalRowsRead || b.numberOfTimesRun - a.numberOfTimesRun)
  const capturedTotalRowsRead = queries.reduce((sum, item) => checkedAdd(sum, item.totalRowsRead), 0)
  const capturedExecutions = queries.reduce((sum, item) => checkedAdd(sum, item.numberOfTimesRun), 0)
  const groupsWithQuery = groups.filter((item) => typeof item?.dimensions?.query === 'string' && item.dimensions.query.trim()).length
  const dailyTotals = daily.map((item, index) => normalizeDailyTotal(item, index))

  return Object.freeze({
    schemaVersion: D1_READ_INSIGHTS_SCHEMA_VERSION,
    generatedAt,
    requestedTimePeriod,
    queryWindowUsed: raw.queryWindowUsed === '7d' ? '7d' : '1d',
    queryDataset: Object.freeze({
      groupCount: groups.length,
      groupsWithQuery,
      groupsWithoutQuery: groups.length - groupsWithQuery,
      capturedTotalRowsRead,
      capturedExecutions,
    }),
    dailyTotals: Object.freeze(dailyTotals),
    queries: Object.freeze(queries),
  })
}

function normalizeGraphqlInsight(item, index) {
  if (!item || typeof item !== 'object') throw new Error(`D1 insight ${index} is invalid`)
  const shape = sanitizeQueryShape(item?.dimensions?.query)
  const avgRowsRead = nonNegativeFinite(item?.avg?.rowsRead ?? 0, `insight ${index}.avgRowsRead`)
  const avgRowsReturned = nonNegativeFinite(item?.avg?.rowsReturned ?? 0, `insight ${index}.avgRowsReturned`)
  return Object.freeze({
    queryFingerprint: createHash('sha256').update(shape).digest('hex').slice(0, 16),
    queryShape: shape,
    queryAvailable: shape !== '<query-unavailable>',
    totalRowsRead: nonNegativeSafeInteger(item?.sum?.rowsRead ?? 0, `insight ${index}.totalRowsRead`),
    avgRowsRead,
    numberOfTimesRun: nonNegativeSafeInteger(item?.count ?? 0, `insight ${index}.numberOfTimesRun`),
    avgDurationMs: nonNegativeFinite(item?.avg?.queryDurationMs ?? 0, `insight ${index}.avgDurationMs`),
    queryEfficiency: avgRowsRead > 0 ? avgRowsReturned / avgRowsRead : 0,
  })
}

function normalizeDailyTotal(item, index) {
  const date = item?.dimensions?.date
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`D1 daily total ${index}.date is invalid`)
  }
  return Object.freeze({
    date,
    rowsRead: nonNegativeSafeInteger(item?.sum?.rowsRead ?? 0, `daily ${index}.rowsRead`),
    rowsWritten: nonNegativeSafeInteger(item?.sum?.rowsWritten ?? 0, `daily ${index}.rowsWritten`),
    readQueries: nonNegativeSafeInteger(item?.sum?.readQueries ?? 0, `daily ${index}.readQueries`),
    writeQueries: nonNegativeSafeInteger(item?.sum?.writeQueries ?? 0, `daily ${index}.writeQueries`),
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

function checkedAdd(left, right) {
  const result = left + right
  if (!Number.isSafeInteger(result)) throw new Error('D1 read insights aggregate overflow')
  return result
}

function requireToken(value, name) {
  if (typeof value !== 'string' || !value) throw new Error(`${name} is required for D1 read attribution`)
  return value
}

async function writeSummary(report, path) {
  const rows = report.queries.slice(0, 10).map((item) =>
    `| \`${item.queryFingerprint}\` | ${item.totalRowsRead} | ${item.avgRowsRead} | ${item.numberOfTimesRun} | \`${escapeMarkdown(item.queryShape)}\` |`)
  const dailyRows = report.dailyTotals.map((item) =>
    `| ${item.date} | ${item.rowsRead} | ${item.rowsWritten} | ${item.readQueries} | ${item.writeQueries} |`)
  await appendFile(path, [
    '## D1 read attribution',
    '',
    `Requested query window: ${report.requestedTimePeriod}; used: ${report.queryWindowUsed}. Query groups: ${report.queryDataset.groupCount}; with query text: ${report.queryDataset.groupsWithQuery}; without: ${report.queryDataset.groupsWithoutQuery}.`,
    '',
    '| Query | totalRowsRead | avgRowsRead | executions | Sanitized shape |',
    '| --- | ---: | ---: | ---: | --- |',
    ...rows,
    '',
    '| Date | rowsRead | rowsWritten | readQueries | writeQueries |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...dailyRows,
    '',
  ].join('\n'))
}

function escapeMarkdown(value) {
  return String(value).replace(/\|/g, '\\|').replace(/`/g, "'")
}

export async function main(env = process.env) {
  const reportPath = env.D1_INSIGHTS_REPORT_PATH || DEFAULT_REPORT_PATH
  const raw = await fetchD1ReadAttribution({
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: env.CLOUDFLARE_API_TOKEN,
    databaseId: env.D1_DATABASE_ID,
  })
  const report = buildD1ReadInsightsReport(raw)
  await mkdir(dirname(reportPath), { recursive: true })
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  if (env.GITHUB_STEP_SUMMARY) await writeSummary(report, env.GITHUB_STEP_SUMMARY)
  console.log(JSON.stringify({
    event: 'd1_read_attribution',
    reportPath,
    requestedTimePeriod: report.requestedTimePeriod,
    queryWindowUsed: report.queryWindowUsed,
    queryDataset: report.queryDataset,
    dailyTotals: report.dailyTotals,
    topQueries: report.queries.slice(0, 5).map(({ queryFingerprint, queryAvailable, totalRowsRead, avgRowsRead, numberOfTimesRun, queryShape }) => ({
      queryFingerprint,
      queryAvailable,
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
      event: 'd1_read_attribution_error',
      message: error instanceof Error ? error.message : String(error),
    }))
    process.exitCode = 1
  })
}
