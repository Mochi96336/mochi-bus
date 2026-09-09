import { pathToFileURL } from 'node:url'
import { loadOperationalResources } from '../instance/operational-resources.mjs'
import { queryD1 } from '../transit-snapshot/window-d1.mjs'
import { resolveDiagnosticTargets } from './diagnose-routes.mjs'

const SAFE_CITY = /^[A-Za-z][A-Za-z0-9]{0,63}$/

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
    } catch {
      reports.push(report(city, 'error', 'd1_query_failed'))
    }
  }
  return Object.freeze(reports)
}

function report(city, result, stage, details = {}) {
  return Object.freeze({
    city,
    result,
    stage,
    activeVersionPresent: details.activeVersionPresent === true,
    routes: safeCount(details.routes),
    patterns: safeCount(details.patterns),
    places: safeCount(details.places),
    routeWithoutPattern: safeCount(details.routeWithoutPattern),
  })
}

function safeCount(value) {
  if (value === undefined || value === null || value === '') return null
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 0 && number <= 10_000_000 ? number : null
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

  const query = (sql, params) => queryD1({
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: env.CLOUDFLARE_API_TOKEN,
    databaseId: resources.d1DatabaseId,
    fetchImpl: fetch,
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
