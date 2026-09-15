import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'

export const CLOUDFLARE_ANALYTICS_PREFLIGHT_SCHEMA_VERSION = 1
export const WORKER_ANALYTICS_PREFLIGHT_SCRIPT = 'mochi-analytics-preflight-never-deployed'
const DEFAULT_REPORT_PATH = '.transit-snapshot/cloudflare-analytics-credential-preflight.json'
const GRAPHQL_ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql'
const MAX_GRAPHQL_RESPONSE_BYTES = 512 * 1024
const MAX_ERROR_DETAIL = 360
const REQUEST_TIMEOUT_MS = 15_000

// Keep this probe aligned with the exact dataset and fields used by
// measure-worker-resources.mjs. The workflow contract test fails if either side drifts.
export const WORKER_ANALYTICS_PREFLIGHT_QUERY = `
query WorkerResourceMeasurement(
  $accountTag: string
  $datetimeStart: string
  $datetimeEnd: string
  $scriptName: string
) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      workersInvocationsAdaptive(
        limit: 100
        filter: {
          scriptName: $scriptName
          datetime_geq: $datetimeStart
          datetime_leq: $datetimeEnd
        }
      ) {
        dimensions {
          scriptName
          status
        }
        quantiles {
          memoryUsageBytesP50
          memoryUsageBytesP90
          memoryUsageBytesP99
          memoryUsageBytesP999
        }
        sum {
          errors
          requests
          subrequests
        }
      }
    }
  }
}
`

export async function probeCloudflareAnalyticsCredential({
  accountId,
  apiToken,
  fetchImpl = fetch,
  now = () => new Date(),
} = {}) {
  const generatedAt = safeNow(now)
  if (typeof apiToken !== 'string' || !apiToken || typeof accountId !== 'string' || !accountId) {
    return unavailable({ generatedAt, outcome: 'unconfigured' })
  }

  const end = new Date(generatedAt)
  const start = new Date(end.getTime() - 5 * 60 * 1000)
  let response
  try {
    response = await fetchImpl(GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: WORKER_ANALYTICS_PREFLIGHT_QUERY,
        operationName: 'WorkerResourceMeasurement',
        variables: {
          accountTag: accountId,
          datetimeStart: start.toISOString(),
          datetimeEnd: end.toISOString(),
          scriptName: WORKER_ANALYTICS_PREFLIGHT_SCRIPT,
        },
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch {
    return unavailable({ generatedAt, outcome: 'network_error' })
  }

  let text
  try {
    text = await response.text()
  } catch {
    return unavailable({ generatedAt, outcome: 'response_read_error', httpStatus: response.status })
  }
  if (new TextEncoder().encode(text).byteLength > MAX_GRAPHQL_RESPONSE_BYTES) {
    return unavailable({ generatedAt, outcome: 'response_too_large', httpStatus: response.status })
  }

  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    return unavailable({ generatedAt, outcome: 'invalid_json', httpStatus: response.status })
  }

  const errors = Array.isArray(payload?.errors) ? payload.errors : []
  if (!response.ok || errors.length > 0 || !payload?.data) {
    const errorDetail = boundedGraphqlError(errors, [apiToken, accountId])
    return unavailable({
      generatedAt,
      outcome: authorizationFailure(response.status, errorDetail) ? 'unauthorized' : 'api_error',
      httpStatus: response.status,
      errorDetail,
    })
  }

  const accounts = payload?.data?.viewer?.accounts
  if (!Array.isArray(accounts) || accounts.length !== 1) {
    return unavailable({ generatedAt, outcome: 'account_unavailable', httpStatus: response.status })
  }
  const rows = accounts[0]?.workersInvocationsAdaptive
  if (!Array.isArray(rows) || rows.length > 100) {
    return unavailable({ generatedAt, outcome: 'invalid_payload', httpStatus: response.status })
  }

  return Object.freeze({
    schemaVersion: CLOUDFLARE_ANALYTICS_PREFLIGHT_SCHEMA_VERSION,
    event: 'cloudflare_account_analytics_preflight',
    generatedAt,
    outcome: 'ready',
    ready: true,
    httpStatus: response.status,
    dataset: 'workersInvocationsAdaptive',
    operationName: 'WorkerResourceMeasurement',
    probeRows: rows.length,
    errorDetail: null,
  })
}

function unavailable({ generatedAt, outcome, httpStatus = null, errorDetail = null }) {
  return Object.freeze({
    schemaVersion: CLOUDFLARE_ANALYTICS_PREFLIGHT_SCHEMA_VERSION,
    event: 'cloudflare_account_analytics_preflight',
    generatedAt,
    outcome,
    ready: false,
    httpStatus: Number.isInteger(httpStatus) ? httpStatus : null,
    dataset: 'workersInvocationsAdaptive',
    operationName: 'WorkerResourceMeasurement',
    probeRows: null,
    errorDetail,
  })
}

function safeNow(now) {
  const value = now()
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new Error('Cloudflare analytics preflight clock is invalid')
  return value.toISOString()
}

function authorizationFailure(status, detail) {
  if (status === 401 || status === 403) return true
  return /(?:not authorized|unauthori[sz]ed|permission|forbidden)/i.test(detail || '')
}

function boundedGraphqlError(errors, sensitiveValues = []) {
  if (!Array.isArray(errors) || errors.length === 0) return null
  const redactions = [...new Set(sensitiveValues.filter((value) => typeof value === 'string' && value.length > 0))]
    .sort((a, b) => b.length - a.length)
  const detail = errors.slice(0, 3).map((error) => {
    const code = error?.extensions?.code
    const prefix = typeof code === 'string' || typeof code === 'number' ? `[${String(code)}] ` : ''
    let message = typeof error?.message === 'string' ? error.message : 'GraphQL error'
    for (const value of redactions) message = message.split(value).join('<redacted>')
    return `${prefix}${message.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()}`
  }).join(' | ')
  if (!detail) return null
  return detail.length > MAX_ERROR_DETAIL ? `${detail.slice(0, MAX_ERROR_DETAIL - 1)}…` : detail
}

async function writeSummary(report, path) {
  await appendFile(path, [
    '## Cloudflare Account Analytics credential preflight',
    '',
    `Outcome: **${report.outcome}**; READY: **${report.ready}**; HTTP: ${report.httpStatus ?? 'n/a'}.`,
    '',
    `Dataset: \`${report.dataset}\`; operation: \`${report.operationName}\`; probe rows: ${report.probeRows ?? 'n/a'}.`,
    ...(report.errorDetail ? ['', `Bounded API detail: \`${report.errorDetail.replace(/`/g, "'")}\``] : []),
    '',
  ].join('\n'))
}

export async function main(env = process.env) {
  const reportPath = env.CLOUDFLARE_ANALYTICS_PREFLIGHT_REPORT || DEFAULT_REPORT_PATH
  const report = await probeCloudflareAnalyticsCredential({
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: env.CLOUDFLARE_ANALYTICS_API_TOKEN,
  })
  await mkdir(dirname(reportPath), { recursive: true })
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  if (env.GITHUB_STEP_SUMMARY) await writeSummary(report, env.GITHUB_STEP_SUMMARY)
  console.log(JSON.stringify({
    event: report.event,
    outcome: report.outcome,
    ready: report.ready,
    httpStatus: report.httpStatus,
    dataset: report.dataset,
    operationName: report.operationName,
    probeRows: report.probeRows,
    errorDetail: report.errorDetail,
  }))
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify({
      event: 'cloudflare_account_analytics_preflight_error',
      message: error instanceof Error ? error.message : String(error),
    }))
    process.exitCode = 1
  })
}
