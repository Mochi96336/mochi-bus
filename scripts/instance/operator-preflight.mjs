import { pathToFileURL } from 'node:url'
import { loadOperationsPlan } from './operations-plan.mjs'
import { loadOperationalResources, resolveOperationalOrigin } from './operational-resources.mjs'

const OPERATIONS = new Set(['deploy', 'snapshot', 'publicProbe', 'windowWatchdog'])
const CLOUDFLARE_ACCOUNT_ID = /^[0-9a-f]{32}$/i
const POSITIVE_INTEGER = /^[1-9][0-9]{0,19}$/
const API_BASE = 'https://api.cloudflare.com/client/v4/'
const API_TIMEOUT_MS = 15_000

export function resolveOperatorPreflight({
  operation,
  forceEnabled = false,
  plan = loadOperationsPlan(),
  resources = loadOperationalResources(),
  env = process.env,
} = {}) {
  if (!OPERATIONS.has(operation)) {
    throw new Error(`Unsupported operator preflight: ${operation || '<empty>'}`)
  }

  const enabled = operation === 'deploy'
    || (operation === 'snapshot'
      ? forceEnabled || plan.snapshotSchedule !== 'manual'
      : Boolean(plan.checks[operation]))
  if (!enabled) {
    return Object.freeze({
      operation,
      enabled: false,
      profile: plan.profile,
      origin: null,
      remoteChecks: Object.freeze([]),
      warnings: Object.freeze([]),
    })
  }

  const missing = []
  const warnings = []
  requireEnvironment(env, 'CLOUDFLARE_API_TOKEN', missing)
  requireEnvironment(env, 'CLOUDFLARE_ACCOUNT_ID', missing)
  if (hasEnvironment(env, 'CLOUDFLARE_ACCOUNT_ID')
    && !CLOUDFLARE_ACCOUNT_ID.test(env.CLOUDFLARE_ACCOUNT_ID.trim())) {
    throw new Error('CLOUDFLARE_ACCOUNT_ID must be a 32-character hexadecimal account ID')
  }

  if (!resources.d1DatabaseId) {
    throw new Error(`${operation} requires a provisioned D1 database ID`)
  }

  if (operation === 'snapshot') {
    requireEnvironment(env, 'TDX_CLIENT_ID', missing)
    requireEnvironment(env, 'TDX_CLIENT_SECRET', missing)
    const hasR2AccessKey = hasEnvironment(env, 'R2_ACCESS_KEY_ID')
    const hasR2Secret = hasEnvironment(env, 'R2_SECRET_ACCESS_KEY')
    if (hasR2AccessKey !== hasR2Secret) {
      throw new Error('R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY must be configured together')
    }
    if (!hasR2AccessKey) {
      if (plan.profile === 'starter') {
        warnings.push('R2 S3 credentials are absent; the manual starter snapshot will use the slow Wrangler fallback')
      } else {
        missing.push('R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY')
      }
    }
  }

  let origin = null
  if (operation === 'publicProbe' || operation === 'snapshot'
    || (operation === 'deploy' && plan.checks.releaseSmoke)) {
    const overrideName = operation === 'deploy' ? 'RELEASE_SMOKE_ORIGIN' : 'SNAPSHOT_SMOKE_BASE_URL'
    origin = resolveOperationalOrigin(
      resources,
      environmentValue(env, overrideName),
      overrideName,
      { allowHttp: operation !== 'deploy' },
    )
  }

  if (operation === 'deploy' && plan.profile === 'operator') {
    const standard = resources.rateLimitNamespaceIds?.standard ?? null
    const expensive = resources.rateLimitNamespaceIds?.expensive ?? null
    if (!POSITIVE_INTEGER.test(String(standard ?? ''))
      || !POSITIVE_INTEGER.test(String(expensive ?? ''))
      || standard === expensive) {
      throw new Error('Operator deployment requires two distinct positive rate-limit namespace IDs')
    }
  }

  if (missing.length > 0) {
    throw new Error(`Missing required operator configuration: ${[...new Set(missing)].join(', ')}`)
  }

  const remoteChecks = [{
    kind: 'd1',
    id: resources.d1DatabaseId,
    name: resources.d1DatabaseName,
  }]
  if (operation === 'deploy' || operation === 'snapshot') {
    remoteChecks.push({ kind: 'r2', name: resources.r2BucketName })
  }

  return Object.freeze({
    operation,
    enabled: true,
    profile: plan.profile,
    origin,
    remoteChecks: Object.freeze(remoteChecks.map((check) => Object.freeze(check))),
    warnings: Object.freeze(warnings),
  })
}

export async function runOperatorPreflight({
  operation,
  forceEnabled = false,
  plan = loadOperationsPlan(),
  resources = loadOperationalResources(),
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const resolved = resolveOperatorPreflight({ operation, forceEnabled, plan, resources, env })
  if (!resolved.enabled) return resolved

  const accountId = env.CLOUDFLARE_ACCOUNT_ID.trim()
  const apiToken = env.CLOUDFLARE_API_TOKEN.trim()
  const checkedResources = []
  for (const check of resolved.remoteChecks) {
    if (check.kind === 'd1') {
      await verifyD1Database({ accountId, apiToken, check, fetchImpl })
    } else if (check.kind === 'r2') {
      await verifyR2Bucket({ accountId, apiToken, check, fetchImpl })
    }
    checkedResources.push(Object.freeze({ kind: check.kind, name: check.name }))
  }

  return Object.freeze({
    ...resolved,
    checkedResources: Object.freeze(checkedResources),
  })
}

export function parseOperatorPreflightArguments(argv = process.argv.slice(2), env = process.env) {
  const positional = []
  let forceEnabled = env.MOCHI_BUS_PREFLIGHT_FORCE_ENABLED === 'true'
  for (const argument of argv) {
    if (argument === '--force-enabled') {
      forceEnabled = true
    } else if (argument.startsWith('--')) {
      throw new Error(`Unknown operator preflight option: ${argument}`)
    } else {
      positional.push(argument)
    }
  }
  if (positional.length !== 1) throw new Error('Operator preflight requires exactly one operation')
  return Object.freeze({ operation: positional[0], forceEnabled })
}

export async function main({ argv = process.argv.slice(2), env = process.env } = {}) {
  const arguments_ = parseOperatorPreflightArguments(argv, env)
  const result = await runOperatorPreflight({ ...arguments_, env })
  console.log(JSON.stringify({
    message: 'instance_operator_preflight',
    operation: result.operation,
    enabled: result.enabled,
    profile: result.profile,
    originConfigured: result.origin !== null,
    checkedResources: result.checkedResources ?? [],
    warnings: result.warnings,
  }))
  return result
}

async function verifyD1Database({ accountId, apiToken, check, fetchImpl }) {
  const body = await cloudflareJson(
    new URL(`accounts/${accountId}/d1/database/${check.id}`, API_BASE),
    apiToken,
    'D1 database',
    fetchImpl,
  )
  const returnedId = typeof body?.result?.uuid === 'string' ? body.result.uuid.toLowerCase() : null
  if (returnedId !== check.id.toLowerCase() || body?.result?.name !== check.name) {
    throw new Error(`Cloudflare D1 identity mismatch for ${check.name}`)
  }
}

async function verifyR2Bucket({ accountId, apiToken, check, fetchImpl }) {
  const body = await cloudflareJson(
    new URL(`accounts/${accountId}/r2/buckets/${encodeURIComponent(check.name)}`, API_BASE),
    apiToken,
    'R2 bucket',
    fetchImpl,
  )
  if (body?.result?.name !== check.name) {
    throw new Error(`Cloudflare R2 identity mismatch for ${check.name}`)
  }
}

async function cloudflareJson(url, apiToken, resource, fetchImpl) {
  let response
  try {
    response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${apiToken}`, Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    })
  } catch {
    throw new Error(`Cloudflare ${resource} preflight request failed`)
  }
  if (!response?.ok) {
    throw new Error(`Cloudflare ${resource} preflight failed with HTTP ${response?.status ?? 'unknown'}`)
  }
  let body
  try {
    body = await response.json()
  } catch {
    throw new Error(`Cloudflare ${resource} preflight returned invalid JSON`)
  }
  if (!body || body.success !== true || !body.result) {
    throw new Error(`Cloudflare ${resource} preflight was not successful`)
  }
  return body
}

function requireEnvironment(env, name, missing) {
  if (!hasEnvironment(env, name)) missing.push(name)
}

function hasEnvironment(env, name) {
  return typeof env[name] === 'string' && env[name].trim().length > 0
}

function environmentValue(env, name) {
  return hasEnvironment(env, name) ? env[name].trim() : null
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
