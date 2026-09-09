import { pathToFileURL } from 'node:url'
import { loadOperationalResources } from '../instance/operational-resources.mjs'
import { resolveDiagnosticTargets } from './diagnose-routes.mjs'

const SAFE_CITY = /^[A-Za-z][A-Za-z0-9]{0,63}$/
const MAX_D1_RESPONSE_BYTES = 65_536
const D1_TIMEOUT_MS = 15_000
const D1_READ_LIMIT_MARKER = "Your account has exceeded D1's free tier daily row read limit."
const D1_WRITE_LIMIT_MARKER = "Your account has exceeded D1's free tier daily row write limit."
const D1_FAILURE_CLASSES = new Set([
  'none',
  'free_rows_read_limit',
  'free_rows_write_limit',
  'network',
  'response_invalid',
  'api_rejected',
  'result_invalid',
  'unknown',
])

export const ACTIVE_ROUTE_CATALOG_SQL = `
SELECT active_version
FROM dataset_versions
WHERE city_code = ?
LIMIT 1
`

export const ACTIVE_ROUTE_COUNTS_SQL = `
SELECT
  (SELECT COUNT(*) FROM routes WHERE version = ? AND city_code = ?) AS routes,
  (SELECT COUNT(*) FROM patterns WHERE version = ? AND city_code = ?) AS patterns,
  (SELECT COUNT(*) FROM stop_places WHERE version = ? AND city_code = ?) AS places,
  (SELECT COUNT(*) FROM routes r
    WHERE r.version = ? AND r.city_code = ?
      AND NOT EXISTS (
        SELECT 1 FROM patterns p
        WHERE p.version = r.version AND p.city_code = r.city_code AND p.route_uid = r.route_uid
      )) AS route_without_pattern
`

class D1DiagnosticFailure extends Error {
  constructor(failureClass) {
    super('D1 diagnostic query failed')
    this.name = 'D1DiagnosticFailure'
    this.failureClass = D1_FAILURE_CLASSES.has(failureClass) ? failureClass : 'unknown'
  }
}

export async function requestDiagnosticD1({
  accountId,
  apiToken,
  databaseId,
  sql,
  params,
  fetchImpl = fetch,
}) {
  if (!accountId || !apiToken || !databaseId || typeof sql !== 'string'
    || !sql.trim().toUpperCase().startsWith('SELECT') || !Array.isArray(params)
    || typeof fetchImpl !== 'function') {
    throw new D1DiagnosticFailure('unknown')
  }

  let response
  try {
    response = await fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/query`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ sql, params }),
        signal: AbortSignal.timeout(D1_TIMEOUT_MS),
      },
    )
  } catch {
    throw new D1DiagnosticFailure('network')
  }

  let text
  try {
    text = await readBoundedText(response, MAX_D1_RESPONSE_BYTES)
  } catch {
    throw new D1DiagnosticFailure('response_invalid')
  }

  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new D1DiagnosticFailure('response_invalid')
  }

  if (!response?.ok || payload?.success !== true) {
    throw new D1DiagnosticFailure(classifyD1ApiFailure(payload))
  }
  const result = Array.isArray(payload?.result) ? payload.result : null
  if (!result || result.length !== 1
    || result[0]?.success !== true || !Array.isArray(result[0]?.results)) {
    throw new D1DiagnosticFailure('result_invalid')
  }
  return result[0].results
}

export function classifyD1ApiFailure(payload) {
  const messages = Array.isArray(payload?.errors)
    ? payload.errors.map((item) => typeof item?.message === 'string' ? item.message : '')
    : []
  if (messages.some((message) => message.includes(D1_READ_LIMIT_MARKER))) {
    return 'free_rows_read_limit'
  }
  if (messages.some((message) => message.includes(D1_WRITE_LIMIT_MARKER))) {
    return 'free_rows_write_limit'
  }
  return 'api_rejected'
}

export async function diagnoseRouteCatalogD1({ cities, query }) {
  if (!Array.isArray(cities) || cities.length === 0
    || cities.some((city) => typeof city !== 'string' || !SAFE_CITY.test(city))
    || typeof query !== 'function') {
    throw new Error('invalid D1 diagnostic input')
  }

  const reports = []
  for (const city of cities) {
    try {
      const activeRows = await query(ACTIVE_ROUTE_CATALOG_SQL, [city])
      const activeVersion = activeRows?.[0]?.active_version
      if (typeof activeVersion !== 'string' || activeVersion.length === 0) {
        reports.push(report(city, 'error', 'active_pointer_missing'))
        continue
      }

      const countRows = await query(ACTIVE_ROUTE_COUNTS_SQL, [
        activeVersion, city,
        activeVersion, city,
        activeVersion, city,
        activeVersion, city,
      ])
      const row = countRows?.[0] ?? {}
      const counts = {
        routes: safeCount(row.routes),
        patterns: safeCount(row.patterns),
        places: safeCount(row.places),
        routeWithoutPattern: safeCount(row.route_without_pattern),
      }
      if (Object.values(counts).some((value) => value === null)) {
        reports.push(report(city, 'error', 'd1_result_invalid', {
          activeVersionPresent: true,
        }))
        continue
      }

      const activeRowsEmpty = counts.routes === 0 || counts.patterns === 0 || counts.places === 0
      reports.push(report(
        city,
        activeRowsEmpty ? 'error' : 'ok',
        activeRowsEmpty ? 'active_rows_empty' : 'reference_ok',
        { activeVersionPresent: true, ...counts },
      ))
    } catch (error) {
      reports.push(report(city, 'error', 'd1_query_failed', {
        d1FailureClass: error instanceof D1DiagnosticFailure ? error.failureClass : 'unknown',
      }))
    }
  }
  return Object.freeze(reports)
}

function report(city, result, stage, details = {}) {
  return Object.freeze({
    city,
    result,
    stage,
    d1FailureClass: safeD1FailureClass(details.d1FailureClass),
    activeVersionPresent: details.activeVersionPresent === true,
    routes: safeCount(details.routes),
    patterns: safeCount(details.patterns),
    places: safeCount(details.places),
    routeWithoutPattern: safeCount(details.routeWithoutPattern),
  })
}

function safeD1FailureClass(value) {
  return D1_FAILURE_CLASSES.has(value) ? value : 'none'
}

function safeCount(value) {
  if (value === undefined || value === null || value === '') return null
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 0 && number <= 10_000_000 ? number : null
}

async function readBoundedText(response, maximumBytes) {
  if (!response?.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let received = 0
  let body = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > maximumBytes) throw new Error('response too large')
      body += decoder.decode(value, { stream: true })
    }
    body += decoder.decode()
    return body
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

export async function main(env = process.env) {
  let resources
  let targets
  try {
    resources = loadOperationalResources({ env })
    targets = resolveDiagnosticTargets(resources)
    if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN || !resources.d1DatabaseId) {
      throw new Error('missing D1 diagnostic configuration')
    }
  } catch {
    console.log(JSON.stringify({
      event: 'release_routes_d1_diagnostic',
      result: 'error',
      stage: 'configuration',
    }))
    return
  }

  const query = (sql, params) => requestDiagnosticD1({
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: env.CLOUDFLARE_API_TOKEN,
    databaseId: resources.d1DatabaseId,
    sql,
    params,
  })
  const reports = await diagnoseRouteCatalogD1({ cities: targets.cities, query })
  for (const item of reports) {
    console.log(JSON.stringify({ event: 'release_routes_d1_diagnostic', ...item }))
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
