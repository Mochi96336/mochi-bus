import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { SUPPORTED_CITY_CODES } from './config.mjs'

export const DEFAULT_RUNTIME_CONFIG_PATH = '.generated/instance/instance-runtime.json'
export const DEFAULT_WRANGLER_CONFIG_PATH = '.generated/instance/wrangler.instance.jsonc'

const CLOUDFLARE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/
const D1_DATABASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const RATE_LIMIT_NAMESPACE_ID = /^[1-9][0-9]{0,19}$/
const INSTANCE_ID = /^[a-z][a-z0-9-]{2,62}$/
const SUPPORTED_CITY_SET = new Set(SUPPORTED_CITY_CODES)
const RESOURCE_ENVIRONMENT = Object.freeze([
  ['TRANSIT_D1_DATABASE_NAME', 'd1DatabaseName'],
  ['TRANSIT_DATABASE_ID', 'd1DatabaseId'],
  ['TRANSIT_R2_BUCKET_NAME', 'r2BucketName'],
])

export function loadOperationalResources({
  cwd = process.cwd(),
  env = process.env,
  readFile = readFileSync,
} = {}) {
  const runtimePath = resolve(cwd, env.MOCHI_BUS_RUNTIME_CONFIG?.trim() || DEFAULT_RUNTIME_CONFIG_PATH)
  const wranglerPath = resolve(cwd, env.MOCHI_BUS_WRANGLER_CONFIG?.trim() || DEFAULT_WRANGLER_CONFIG_PATH)
  const resources = resolveOperationalResources(
    readJson(runtimePath, readFile),
    readJson(wranglerPath, readFile),
    { runtimePath, wranglerPath },
  )
  validateOperationalEnvironment(resources, env)
  validateOperationalOrigins(resources, env)
  return resources
}

export function resolveOperationalResources(runtime, wrangler, {
  runtimePath = 'instance runtime',
  wranglerPath = 'instance Wrangler config',
} = {}) {
  if (!isRecord(runtime) || runtime.schemaVersion !== 1 || !isRecord(runtime.site)
    || !isRecord(runtime.transit)) {
    throw new Error(`Invalid operational runtime: ${runtimePath}`)
  }
  if (!isRecord(wrangler)) throw new Error(`Invalid operational Wrangler config: ${wranglerPath}`)

  const instanceId = instanceIdentifier(runtime.instanceId, `${runtimePath}.instanceId`)
  const enabledCities = cityList(runtime.transit.enabledCities, `${runtimePath}.transit.enabledCities`)
  const defaultCity = city(runtime.transit.defaultCity, `${runtimePath}.transit.defaultCity`)
  if (!enabledCities.includes(defaultCity)) {
    throw new Error(`${runtimePath}.transit.defaultCity must be enabled`)
  }
  const demoQuery = releaseSmokeDemoQuery(
    runtime.transit.demoQuery,
    enabledCities,
    `${runtimePath}.transit.demoQuery`,
  )

  const workerName = cloudflareName(wrangler.name, `${wranglerPath}.name`)
  const d1 = binding(wrangler.d1_databases, 'TRANSIT_DB', `${wranglerPath}.d1_databases`)
  const r2 = binding(wrangler.r2_buckets, 'TRANSIT_SHAPES', `${wranglerPath}.r2_buckets`)
  const d1DatabaseName = cloudflareName(d1.database_name, `${wranglerPath}.d1_databases.TRANSIT_DB.database_name`)
  const r2BucketName = cloudflareName(r2.bucket_name, `${wranglerPath}.r2_buckets.TRANSIT_SHAPES.bucket_name`)
  const d1DatabaseId = nullableDatabaseId(d1.database_id, `${wranglerPath}.d1_databases.TRANSIT_DB.database_id`)
  const publicOrigin = canonicalPublicOrigin(runtime.site.canonicalOrigin, `${runtimePath}.site.canonicalOrigin`)
  const rateLimitNamespaceIds = Object.freeze({
    standard: optionalRateLimitNamespace(
      wrangler.ratelimits,
      'API_STANDARD_RATE_LIMITER',
      `${wranglerPath}.ratelimits`,
    ),
    expensive: optionalRateLimitNamespace(
      wrangler.ratelimits,
      'API_EXPENSIVE_RATE_LIMITER',
      `${wranglerPath}.ratelimits`,
    ),
  })

  return Object.freeze({
    instanceId,
    enabledCities,
    defaultCity,
    demoQuery,
    workerName,
    d1DatabaseName,
    d1DatabaseId,
    r2BucketName,
    publicOrigin,
    rateLimitNamespaceIds,
  })
}

export function validateOperationalEnvironment(resources, env = process.env) {
  for (const [name, property] of RESOURCE_ENVIRONMENT) {
    const supplied = optionalEnvironmentValue(env[name])
    if (supplied === null) continue
    const expected = resources[property]
    const matches = property === 'd1DatabaseId'
      ? typeof expected === 'string' && supplied.toLowerCase() === expected.toLowerCase()
      : supplied === expected
    if (!matches) throw new Error(`${name} must match generated operational identity`)
  }
  return resources
}

export function resolveOperationalOrigin(resources, value, label, { allowHttp = false } = {}) {
  const supplied = optionalEnvironmentValue(value)
  if (supplied === null) {
    if (resources.publicOrigin) return resources.publicOrigin
    throw new Error(`${label} is required when the instance canonical origin is request-derived`)
  }

  const origin = explicitOrigin(supplied, label, { allowHttp })
  if (resources.publicOrigin && origin !== resources.publicOrigin) {
    throw new Error(`${label} must match generated public origin ${resources.publicOrigin}`)
  }
  return origin
}

function validateOperationalOrigins(resources, env) {
  const snapshotOrigin = optionalEnvironmentValue(env.SNAPSHOT_SMOKE_BASE_URL)
  if (snapshotOrigin !== null) {
    resolveOperationalOrigin(resources, snapshotOrigin, 'SNAPSHOT_SMOKE_BASE_URL', { allowHttp: true })
  }
  const releaseOrigin = optionalEnvironmentValue(env.RELEASE_SMOKE_ORIGIN)
  if (releaseOrigin !== null) {
    resolveOperationalOrigin(resources, releaseOrigin, 'RELEASE_SMOKE_ORIGIN')
  }
}

function readJson(path, readFile) {
  let source
  try {
    source = readFile(path, 'utf8')
  } catch (error) {
    throw new Error(`Cannot read operational config ${path}: ${errorMessage(error)}`)
  }
  try {
    return JSON.parse(source)
  } catch (error) {
    throw new Error(`Invalid JSON in operational config ${path}: ${errorMessage(error)}`)
  }
}

function binding(entries, expectedBinding, path) {
  if (!Array.isArray(entries)) throw new Error(`${path} must be an array`)
  const matches = entries.filter((entry) => isRecord(entry) && entry.binding === expectedBinding)
  if (matches.length !== 1) throw new Error(`${path} must contain exactly one ${expectedBinding} binding`)
  return matches[0]
}

function optionalRateLimitNamespace(entries, expectedName, path) {
  if (entries === undefined) return null
  if (!Array.isArray(entries)) throw new Error(`${path} must be an array when present`)
  const matches = entries.filter((entry) => isRecord(entry) && entry.name === expectedName)
  if (matches.length > 1) throw new Error(`${path} must not contain duplicate ${expectedName} bindings`)
  if (matches.length === 0) return null
  const namespaceId = matches[0].namespace_id
  if (typeof namespaceId !== 'string' || !RATE_LIMIT_NAMESPACE_ID.test(namespaceId)) {
    throw new Error(`${path}.${expectedName}.namespace_id must be a positive integer string`)
  }
  return namespaceId
}

function instanceIdentifier(value, path) {
  if (typeof value !== 'string' || !INSTANCE_ID.test(value)) {
    throw new Error(`${path} must be a valid instance ID`)
  }
  return value
}

function cityList(value, path) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${path} must be a non-empty array`)
  const result = []
  const seen = new Set()
  value.forEach((entry, index) => {
    const code = city(entry, `${path}[${index}]`)
    if (seen.has(code)) throw new Error(`${path} must not contain duplicate cities`)
    seen.add(code)
    result.push(code)
  })
  return Object.freeze(result)
}

function city(value, path) {
  if (typeof value !== 'string' || !SUPPORTED_CITY_SET.has(value)) {
    throw new Error(`${path} must be a supported city`)
  }
  return value
}

function releaseSmokeDemoQuery(value, enabledCities, path) {
  if (value === null) return null
  if (!isRecord(value)) throw new Error(`${path} must be null or an object`)
  const queryCity = city(value.city, `${path}.city`)
  if (!enabledCities.includes(queryCity)) throw new Error(`${path}.city must be enabled`)
  if (typeof value.routeName !== 'string' || value.routeName.length === 0 || value.routeName.length > 160) {
    throw new Error(`${path}.routeName must be a non-empty route name`)
  }
  return Object.freeze({ city: queryCity, routeName: value.routeName })
}

function cloudflareName(value, path) {
  if (typeof value !== 'string' || !CLOUDFLARE_NAME.test(value)) {
    throw new Error(`${path} must be a valid Cloudflare resource name`)
  }
  return value
}

function nullableDatabaseId(value, path) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || !D1_DATABASE_ID.test(value)) {
    throw new Error(`${path} must be a valid D1 database ID or null`)
  }
  return value
}

function canonicalPublicOrigin(value, path) {
  if (value === 'request') return null
  if (typeof value !== 'string') throw new Error(`${path} must be request or a fixed HTTPS origin`)
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${path} must be request or a fixed HTTPS origin`)
  }
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password) {
    throw new Error(`${path} must be request or a fixed HTTPS origin`)
  }
  return url.origin
}

function explicitOrigin(value, label, { allowHttp }) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${label} must be an absolute ${allowHttp ? 'HTTP' : 'HTTPS'} origin`)
  }
  const supportedProtocol = url.protocol === 'https:' || (allowHttp && url.protocol === 'http:')
  if (!supportedProtocol || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error(`${label} must be an absolute ${allowHttp ? 'HTTP' : 'HTTPS'} origin`)
  }
  return url.origin
}

function optionalEnvironmentValue(value) {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  return text === '' ? null : text
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
