import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const TDX_ORIGIN = 'https://tdx.transportdata.tw'
const INTERCITY_PATH = /^\/api\/basic\/v2\/Bus\/(Stop|StopOfRoute|Route|Shape|Schedule)\/InterCity$/
const SAFE_SCOPE = /[^A-Za-z0-9._-]+/g

export function intercityCacheScope(env = process.env) {
  const explicit = nonEmpty(env.MOCHI_TDX_INTERCITY_CACHE_SCOPE)
  if (explicit) return sanitize(explicit)

  const runId = nonEmpty(env.GITHUB_RUN_ID)
  if (!runId) return null
  const attempt = nonEmpty(env.GITHUB_RUN_ATTEMPT) ?? '1'
  return sanitize(`github-${runId}-${attempt}`)
}

export function isCacheableIntercityRequest(input, init = {}) {
  const method = requestMethod(input, init)
  if (method !== 'GET') return false

  let url
  try {
    url = new URL(requestUrl(input))
  } catch {
    return false
  }
  if (url.origin !== TDX_ORIGIN) return false
  if (!INTERCITY_PATH.test(url.pathname)) return false
  if (url.searchParams.size !== 1) return false
  return url.searchParams.get('$format') === 'JSON'
}

export function intercityCacheResource(input) {
  const url = new URL(requestUrl(input))
  return INTERCITY_PATH.exec(url.pathname)?.[1] ?? null
}

export function createIntercityFetchCache({
  fetchImpl = globalThis.fetch,
  root = join('.transit-snapshot', 'tdx-intercity-cache'),
  scope = intercityCacheScope(),
  logger = console,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function')
  if (!scope) return fetchImpl

  const safeScope = sanitize(scope)
  return async function cachedIntercityFetch(input, init) {
    if (!isCacheableIntercityRequest(input, init)) return fetchImpl(input, init)

    const resource = intercityCacheResource(input)
    const cachePath = join(root, safeScope, `${resource}.json`)
    const cached = await readCache(cachePath)
    if (cached !== null) {
      logger?.log?.(JSON.stringify({ event: 'tdx_intercity_cache', resource, resolution: 'hit' }))
      return jsonResponse(cached)
    }

    const response = await fetchImpl(input, init)
    if (!response.ok) return response

    const body = Buffer.from(await response.arrayBuffer())
    try {
      await writeCache(cachePath, body)
      logger?.log?.(JSON.stringify({ event: 'tdx_intercity_cache', resource, resolution: 'miss' }))
    } catch (error) {
      logger?.warn?.(`TDX InterCity cache write failed for ${resource}: ${errorMessage(error)}`)
    }
    return jsonResponse(body, response.status)
  }
}

async function readCache(path) {
  try {
    return await readFile(path)
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return null
    throw error
  }
}

async function writeCache(path, body) {
  await mkdir(dirname(path), { recursive: true })
  const digest = createHash('sha256').update(body).digest('hex').slice(0, 12)
  const temporary = `${path}.${process.pid}.${digest}.tmp`
  try {
    await writeFile(temporary, body, { flag: 'wx' })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

function jsonResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function requestUrl(input) {
  if (input instanceof Request) return input.url
  return String(input)
}

function requestMethod(input, init) {
  const explicit = nonEmpty(init?.method)
  if (explicit) return explicit.toUpperCase()
  if (input instanceof Request) return input.method.toUpperCase()
  return 'GET'
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function sanitize(value) {
  return String(value).replace(SAFE_SCOPE, '_').slice(0, 160)
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
