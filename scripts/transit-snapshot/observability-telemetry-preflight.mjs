import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'

export const OBSERVABILITY_TELEMETRY_PREFLIGHT_SCHEMA_VERSION = 1
export const MAX_TELEMETRY_KEYS = 512
const DEFAULT_REPORT_PATH = '.transit-snapshot/observability-telemetry-preflight.json'
const MAX_RESPONSE_BYTES = 512 * 1024
const MAX_ERROR_DETAIL = 320
const REQUEST_TIMEOUT_MS = 15_000

const EXPECTED_D1_TRACE_KEYS = Object.freeze({
  rowsRead: 'cloudflare.d1.response.rows_read',
  rowsWritten: 'cloudflare.d1.response.rows_written',
  sqlDurationMs: 'cloudflare.d1.response.sql_duration_ms',
  queryText: 'db.query.text',
  operationName: 'db.operation.name',
})

export async function probeObservabilityTelemetry({
  accountId,
  apiToken,
  fetchImpl = fetch,
  generatedAt = new Date().toISOString(),
} = {}) {
  requireSecret(accountId, 'CLOUDFLARE_ACCOUNT_ID')
  requireSecret(apiToken, 'CLOUDFLARE_API_TOKEN')

  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/observability/telemetry/keys`
  let response
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch {
    return buildUnavailableReport({ generatedAt, outcome: 'network_error' })
  }

  let text
  try {
    text = await response.text()
  } catch {
    return buildUnavailableReport({ generatedAt, outcome: 'response_read_error', httpStatus: response.status })
  }
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
    return buildUnavailableReport({ generatedAt, outcome: 'response_too_large', httpStatus: response.status })
  }

  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    return buildUnavailableReport({ generatedAt, outcome: 'invalid_json', httpStatus: response.status })
  }

  if (!response.ok || payload?.success !== true) {
    const errorDetail = boundedErrorDetail(payload?.errors, [apiToken, accountId])
    return buildUnavailableReport({
      generatedAt,
      outcome: authorizationFailure(response.status, errorDetail) ? 'unauthorized' : 'api_error',
      httpStatus: response.status,
      errorDetail,
    })
  }

  const keys = payload?.result
  if (!Array.isArray(keys) || keys.length > MAX_TELEMETRY_KEYS) {
    return buildUnavailableReport({ generatedAt, outcome: 'invalid_payload', httpStatus: response.status })
  }

  const names = new Set()
  for (const item of keys) {
    const key = item?.key
    if (typeof key !== 'string' || !key || key.length > 240) {
      return buildUnavailableReport({ generatedAt, outcome: 'invalid_payload', httpStatus: response.status })
    }
    names.add(key)
  }

  return Object.freeze({
    schemaVersion: OBSERVABILITY_TELEMETRY_PREFLIGHT_SCHEMA_VERSION,
    generatedAt,
    outcome: 'authorized',
    authorized: true,
    httpStatus: response.status,
    keyCount: names.size,
    d1TraceKeys: Object.freeze(Object.fromEntries(
      Object.entries(EXPECTED_D1_TRACE_KEYS).map(([label, key]) => [label, names.has(key)]),
    )),
    errorDetail: null,
  })
}

function buildUnavailableReport({ generatedAt, outcome, httpStatus = null, errorDetail = null }) {
  return Object.freeze({
    schemaVersion: OBSERVABILITY_TELEMETRY_PREFLIGHT_SCHEMA_VERSION,
    generatedAt,
    outcome,
    authorized: false,
    httpStatus: Number.isInteger(httpStatus) ? httpStatus : null,
    keyCount: null,
    d1TraceKeys: Object.freeze(Object.fromEntries(
      Object.keys(EXPECTED_D1_TRACE_KEYS).map((label) => [label, false]),
    )),
    errorDetail,
  })
}

function authorizationFailure(status, detail) {
  if (status === 401 || status === 403) return true
  return /(?:not authorized|unauthori[sz]ed|permission|forbidden)/i.test(detail || '')
}

function boundedErrorDetail(errors, sensitiveValues = []) {
  if (!Array.isArray(errors) || errors.length === 0) return null
  const redactions = [...new Set(sensitiveValues.filter((value) => typeof value === 'string' && value.length > 0))]
    .sort((a, b) => b.length - a.length)
  const detail = errors.slice(0, 3).map((error) => {
    const code = typeof error?.code === 'string' || typeof error?.code === 'number'
      ? `[${String(error.code)}] `
      : ''
    let message = typeof error?.message === 'string' ? error.message : 'Cloudflare API error'
    for (const value of redactions) message = message.split(value).join('<redacted>')
    return `${code}${message.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()}`
  }).join(' | ')
  if (!detail) return null
  return detail.length > MAX_ERROR_DETAIL ? `${detail.slice(0, MAX_ERROR_DETAIL - 1)}…` : detail
}

function requireSecret(value, name) {
  if (typeof value !== 'string' || !value) throw new Error(`${name} is required for observability telemetry preflight`)
}

async function writeSummary(report, path) {
  await appendFile(path, [
    '## Workers Observability telemetry preflight',
    '',
    `Outcome: **${report.outcome}**; authorized: **${report.authorized}**; HTTP: ${report.httpStatus ?? 'n/a'}; discovered keys: ${report.keyCount ?? 'n/a'}.`,
    '',
    '| D1 trace field | Seen |',
    '| --- | --- |',
    ...Object.entries(report.d1TraceKeys).map(([key, seen]) => `| ${key} | ${seen ? 'yes' : 'no'} |`),
    ...(report.errorDetail ? ['', `Bounded API detail: \`${report.errorDetail.replace(/`/g, "'")}\``] : []),
    '',
  ].join('\n'))
}

export async function main(env = process.env) {
  const reportPath = env.OBSERVABILITY_TELEMETRY_PREFLIGHT_REPORT || DEFAULT_REPORT_PATH
  const report = await probeObservabilityTelemetry({
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: env.CLOUDFLARE_API_TOKEN,
  })
  await mkdir(dirname(reportPath), { recursive: true })
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  if (env.GITHUB_STEP_SUMMARY) await writeSummary(report, env.GITHUB_STEP_SUMMARY)
  console.log(JSON.stringify({
    event: 'observability_telemetry_preflight',
    outcome: report.outcome,
    authorized: report.authorized,
    httpStatus: report.httpStatus,
    keyCount: report.keyCount,
    d1TraceKeys: report.d1TraceKeys,
    errorDetail: report.errorDetail,
  }))
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify({
      event: 'observability_telemetry_preflight_error',
      message: error instanceof Error ? error.message : String(error),
    }))
    process.exitCode = 1
  })
}
