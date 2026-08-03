import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const DEFAULT_RUNTIME_CONFIG_PATH = '.generated/instance/instance-runtime.json'
export const DEFAULT_WRANGLER_CONFIG_PATH = '.generated/instance/wrangler.instance.jsonc'

const CLOUDFLARE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/
const D1_DATABASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
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
  return validateOperationalEnvironment(resources, env)
}

export function resolveOperationalResources(runtime, wrangler, {
  runtimePath = 'instance runtime',
  wranglerPath = 'instance Wrangler config',
} = {}) {
  if (!isRecord(runtime) || runtime.schemaVersion !== 1 || !isRecord(runtime.site)) {
    throw new Error(`Invalid operational runtime: ${runtimePath}`)
  }
  if (!isRecord(wrangler)) throw new Error(`Invalid operational Wrangler config: ${wranglerPath}`)

  const workerName = cloudflareName(wrangler.name, `${wranglerPath}.name`)
  const d1 = binding(wrangler.d1_databases, 'TRANSIT_DB', `${wranglerPath}.d1_databases`)
  const r2 = binding(wrangler.r2_buckets, 'TRANSIT_SHAPES', `${wranglerPath}.r2_buckets`)
  const d1DatabaseName = cloudflareName(d1.database_name, `${wranglerPath}.d1_databases.TRANSIT_DB.database_name`)
  const r2BucketName = cloudflareName(r2.bucket_name, `${wranglerPath}.r2_buckets.TRANSIT_SHAPES.bucket_name`)
  const d1DatabaseId = nullableDatabaseId(d1.database_id, `${wranglerPath}.d1_databases.TRANSIT_DB.database_id`)
  const publicOrigin = canonicalPublicOrigin(runtime.site.canonicalOrigin, `${runtimePath}.site.canonicalOrigin`)

  return Object.freeze({
    workerName,
    d1DatabaseName,
    d1DatabaseId,
    r2BucketName,
    publicOrigin,
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

  const snapshotOrigin = optionalEnvironmentValue(env.SNAPSHOT_SMOKE_BASE_URL)
  if (snapshotOrigin !== null) {
    resolveOperationalOrigin(resources, snapshotOrigin, 'SNAPSHOT_SMOKE_BASE_URL', { allowHttp: true })
  }
  const releaseOrigin = optionalEnvironmentValue(env.RELEASE_SMOKE_ORIGIN)
  if (releaseOrigin !== null) {
    resolveOperationalOrigin(resources, releaseOrigin, 'RELEASE_SMOKE_ORIGIN')
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
