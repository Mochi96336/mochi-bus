import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const MAX_JSON_BYTES = 2_097_152
const HTTP_TIMEOUT_MS = 20_000
const SAFE_CITY = /^[A-Za-z][A-Za-z0-9]{0,63}$/
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SECONDARY_CITY_CANARIES = Object.freeze(['Chiayi'])

export function resolveDiagnosticTargets(config) {
  const enabledCities = config?.transit?.enabledCities ?? config?.enabledCities
  const defaultCity = config?.transit?.defaultCity ?? config?.defaultCity
  const demoQuery = config?.transit?.demoQuery ?? config?.demoQuery
  const publicOrigin = config?.site?.canonicalOrigin ?? config?.publicOrigin
  let origin
  try {
    origin = new URL(publicOrigin)
  } catch {
    throw new Error('invalid diagnostic configuration')
  }
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash
    || !Array.isArray(enabledCities) || enabledCities.length === 0
    || enabledCities.some((city) => typeof city !== 'string' || !SAFE_CITY.test(city))
    || new Set(enabledCities).size !== enabledCities.length
    || typeof defaultCity !== 'string' || !enabledCities.includes(defaultCity)
    || !(demoQuery === null || (demoQuery && typeof demoQuery === 'object'
      && typeof demoQuery.city === 'string' && enabledCities.includes(demoQuery.city)))) {
    throw new Error('invalid diagnostic configuration')
  }

  const cities = []
  for (const city of [
    demoQuery?.city ?? defaultCity,
    defaultCity,
    ...SECONDARY_CITY_CANARIES.filter((candidate) => enabledCities.includes(candidate)),
    ...enabledCities,
  ]) {
    if (!cities.includes(city)) cities.push(city)
    if (cities.length === Math.min(2, enabledCities.length)) break
  }
  return Object.freeze({ origin: origin.origin, cities: Object.freeze(cities) })
}

export async function diagnoseRoutes({ origin, cities, fetchImpl = fetch }) {
  if (typeof origin !== 'string' || !Array.isArray(cities) || cities.length === 0
    || cities.some((city) => typeof city !== 'string' || !SAFE_CITY.test(city))
    || typeof fetchImpl !== 'function') {
    throw new Error('invalid diagnostic input')
  }
  const results = []
  for (const city of cities) {
    results.push(await diagnoseCity({ origin, city, fetchImpl }))
  }
  return Object.freeze(results)
}

export function summarizeRoutesPayload(value, city, responseMeta = {}) {
  const object = value && typeof value === 'object' && !Array.isArray(value) ? value : null
  const routes = Array.isArray(object?.routes) ? object.routes : null
  const source = object?.source === 'snapshot' || object?.source === 'tdx' ? object.source : 'other'
  const routeCount = routes?.length ?? null
  const invalidRouteIdentityCount = routes === null ? null : routes.filter((route) => !route
    || typeof route.routeName !== 'string' || route.routeName.length === 0
    || typeof route.routeUid !== 'string' || route.routeUid.length === 0).length
  const contractReason = !object ? 'object'
    : object.schemaVersion !== 2 ? 'schema_version'
      : object.city !== city ? 'city'
        : source !== 'snapshot' ? 'source'
          : typeof object.snapshotVersion !== 'string' || !SAFE_IDENTIFIER.test(object.snapshotVersion) ? 'snapshot_version'
            : routes === null ? 'routes_shape'
              : routes.length === 0 ? 'routes_empty'
                : invalidRouteIdentityCount !== 0 ? 'route_identity'
                  : null

  return Object.freeze({
    city,
    result: contractReason === null ? 'ok' : 'error',
    stage: contractReason === null ? 'contract_ok' : 'contract',
    status: safeStatus(responseMeta.status),
    contentType: safeContentType(responseMeta.contentType),
    schemaVersion: Number.isSafeInteger(object?.schemaVersion) ? object.schemaVersion : null,
    responseCityMatches: object?.city === city,
    source,
    snapshotVersionValid: typeof object?.snapshotVersion === 'string' && SAFE_IDENTIFIER.test(object.snapshotVersion),
    routeCount: safeCount(routeCount),
    invalidRouteIdentityCount: safeCount(invalidRouteIdentityCount),
    contractReason,
  })
}

async function diagnoseCity({ origin, city, fetchImpl }) {
  let response
  try {
    response = await fetchImpl(new URL(`/api/v1/map/routes?city=${encodeURIComponent(city)}`, origin), {
      headers: {
        'Cache-Control': 'no-cache',
        'User-Agent': 'mochi-bus-release-routes-diagnostic/1',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
  } catch {
    return failure(city, 'network')
  }

  const status = safeStatus(response?.status)
  const contentType = safeContentType(response?.headers?.get?.('Content-Type'))
  if (!response?.ok) return failure(city, 'http_status', { status, contentType })
  if (contentType !== 'json') return failure(city, 'content_type', { status, contentType })

  let body
  try {
    body = await readBoundedText(response, MAX_JSON_BYTES)
  } catch {
    return failure(city, 'body_read', { status, contentType })
  }

  let value
  try {
    value = JSON.parse(body)
  } catch {
    return failure(city, 'json_parse', { status, contentType })
  }
  return summarizeRoutesPayload(value, city, { status, contentType })
}

async function readBoundedText(response, maximumBytes) {
  if (!response.body) return ''
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

function failure(city, stage, meta = {}) {
  return Object.freeze({
    city,
    result: 'error',
    stage,
    status: safeStatus(meta.status),
    contentType: safeContentType(meta.contentType),
    schemaVersion: null,
    responseCityMatches: false,
    source: 'other',
    snapshotVersionValid: false,
    routeCount: null,
    invalidRouteIdentityCount: null,
    contractReason: null,
  })
}

function safeStatus(value) {
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : null
}

function safeContentType(value) {
  const normalized = String(value ?? '').toLowerCase()
  if (normalized === 'json' || normalized.includes('json')) return 'json'
  if (normalized === 'html' || normalized.includes('html')) return 'html'
  return normalized ? 'other' : 'missing'
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 10_000_000 ? value : null
}

export async function main(env = process.env) {
  const configPath = env.RELEASE_ROUTES_DIAGNOSTIC_INSTANCE ?? 'instances/mochi-production.json'
  let config
  try {
    config = JSON.parse(await readFile(configPath, 'utf8'))
  } catch {
    console.error(JSON.stringify({ event: 'release_routes_diagnostic', result: 'error', stage: 'configuration' }))
    process.exitCode = 1
    return
  }

  let targets
  try {
    targets = resolveDiagnosticTargets(config)
  } catch {
    console.error(JSON.stringify({ event: 'release_routes_diagnostic', result: 'error', stage: 'configuration' }))
    process.exitCode = 1
    return
  }

  const reports = await diagnoseRoutes(targets)
  for (const report of reports) console.log(JSON.stringify({ event: 'release_routes_diagnostic', ...report }))
  if (reports.some((report) => report.result !== 'ok')) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
