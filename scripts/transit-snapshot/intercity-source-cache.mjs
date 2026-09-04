const CACHE_SCHEMA_VERSION = 1
const CACHE_PREFIX = 'source-cache/tdx/intercity/v1'
const CACHE_MANIFEST_KEY = `${CACHE_PREFIX}/manifest.json`
const MAX_RESOURCE_BYTES = 96 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 15_000
const MAX_UPSTREAM_ATTEMPTS = 5

export const INTERCITY_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const INTERCITY_RESOURCES = Object.freeze([
  'Stop',
  'StopOfRoute',
  'Route',
  'Shape',
  'Schedule',
])

const INTERCITY_PATH = new RegExp(
  `/api/basic/v2/Bus/(${INTERCITY_RESOURCES.join('|')})/InterCity/?$`,
)

export function intercityResourceFromUrl(input) {
  let url
  try {
    url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url)
  } catch {
    return null
  }
  return url.pathname.match(INTERCITY_PATH)?.[1] ?? null
}

export function freshIntercityManifest(manifest, now = new Date()) {
  if (!manifest || manifest.schemaVersion !== CACHE_SCHEMA_VERSION) return false
  if (typeof manifest.version !== 'string' || !manifest.version) return false
  const generatedAt = Date.parse(manifest.generatedAt)
  const expiresAt = Date.parse(manifest.expiresAt)
  if (!Number.isFinite(generatedAt) || !Number.isFinite(expiresAt)) return false
  if (expiresAt <= dateValue(now)) return false
  if (!manifest.resources || typeof manifest.resources !== 'object') return false
  return INTERCITY_RESOURCES.every((resource) => validResourceEntry(manifest.resources[resource]))
}

export function createIntercityCachedFetch({
  upstreamFetch,
  store,
  now = () => new Date(),
  ttlMs = INTERCITY_CACHE_TTL_MS,
  forceRefresh = false,
  logger = () => {},
}) {
  if (typeof upstreamFetch !== 'function') throw new TypeError('upstreamFetch is required')
  if (!store) return upstreamFetch
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new TypeError('ttlMs must be positive')

  let manifestLoaded = false
  let manifest = null
  let refreshPromise = null
  let forceRefreshPending = forceRefresh
  const memory = new Map()

  return async function cachedFetch(input, init) {
    const requestUrl = fetchUrl(input)
    const resource = intercityResourceFromUrl(requestUrl)
    if (!resource) return upstreamFetch(input, init)

    const inMemory = memory.get(resource)
    if (inMemory) return cachedJsonResponse(inMemory)

    const currentManifest = await loadManifest()
    if (!forceRefreshPending && freshIntercityManifest(currentManifest, now())) {
      const cached = await readCachedResource(currentManifest, resource)
      if (cached) {
        memory.set(resource, cached)
        emit(logger, {
          event: 'tdx_intercity_source_cache',
          action: 'hit',
          resource,
          version: currentManifest.version,
        })
        return cachedJsonResponse(cached)
      }
    }

    if (!refreshPromise) {
      const reason = forceRefreshPending
        ? 'forced'
        : freshIntercityManifest(currentManifest, now()) ? 'resource-missing' : 'expired-or-missing'
      refreshPromise = refreshAll({ requestUrl, input, init, previousManifest: currentManifest, reason })
    }
    const refreshed = await refreshPromise
    forceRefreshPending = false
    for (const [name, body] of refreshed.bodies) memory.set(name, body)
    return cachedJsonResponse(memory.get(resource))
  }

  async function loadManifest() {
    if (manifestLoaded) return manifest
    manifestLoaded = true
    try {
      manifest = await store.readManifest()
    } catch (error) {
      emit(logger, {
        event: 'tdx_intercity_source_cache',
        action: 'read-failed',
        message: errorMessage(error),
      })
      manifest = null
    }
    return manifest
  }

  async function readCachedResource(currentManifest, resource) {
    const entry = currentManifest.resources[resource]
    try {
      const body = await store.readResource(entry)
      if (!body) return null
      const bytes = asUint8Array(body)
      if (bytes.byteLength !== entry.bytes || bytes.byteLength > MAX_RESOURCE_BYTES) return null
      return bytes
    } catch (error) {
      emit(logger, {
        event: 'tdx_intercity_source_cache',
        action: 'resource-read-failed',
        resource,
        version: currentManifest.version,
        message: errorMessage(error),
      })
      return null
    }
  }

  async function refreshAll({ requestUrl, input, init, previousManifest, reason }) {
    const generatedAt = asDate(now()).toISOString()
    const version = generatedAt.replace(/[-:.]/g, '')
    const expiresAt = new Date(new Date(generatedAt).getTime() + ttlMs).toISOString()
    const headers = requestHeaders(input, init)
    const bodies = new Map()

    for (const resource of INTERCITY_RESOURCES) {
      const url = intercityResourceUrl(requestUrl, resource)
      const response = await fetchUpstreamResource(upstreamFetch, url, headers)
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (bytes.byteLength > MAX_RESOURCE_BYTES) {
        throw new Error(`TDX InterCity ${resource} response exceeds cache limit`)
      }
      assertJsonArray(bytes, resource)
      bodies.set(resource, bytes)
    }

    const resources = Object.fromEntries(INTERCITY_RESOURCES.map((resource) => {
      const body = bodies.get(resource)
      return [resource, {
        key: `${CACHE_PREFIX}/${version}/${resource}.json`,
        bytes: body.byteLength,
      }]
    }))
    const nextManifest = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      source: 'TDX Bus/InterCity',
      version,
      generatedAt,
      expiresAt,
      resources,
    }

    let persisted = false
    try {
      await Promise.all(INTERCITY_RESOURCES.map((resource) =>
        store.writeResource(resources[resource], bodies.get(resource))))
      await store.writeManifest(nextManifest)
      persisted = true
      manifest = nextManifest
      manifestLoaded = true
      emit(logger, {
        event: 'tdx_intercity_source_cache',
        action: 'refreshed',
        reason,
        version,
        bytes: INTERCITY_RESOURCES.reduce((total, resource) => total + resources[resource].bytes, 0),
      })
    } catch (error) {
      emit(logger, {
        event: 'tdx_intercity_source_cache',
        action: 'write-failed',
        reason,
        version,
        message: errorMessage(error),
      })
    }

    if (persisted && previousManifest?.version && previousManifest.version !== version) {
      try {
        await store.deleteResources?.(Object.values(previousManifest.resources ?? {}).filter(validResourceEntry))
      } catch (error) {
        emit(logger, {
          event: 'tdx_intercity_source_cache',
          action: 'cleanup-failed',
          version: previousManifest.version,
          message: errorMessage(error),
        })
      }
    }

    return { manifest: nextManifest, bodies }
  }
}

export async function createR2IntercityCacheStore(env = process.env) {
  const accountId = nullableText(env.CLOUDFLARE_ACCOUNT_ID)
  const accessKeyId = nullableText(env.R2_ACCESS_KEY_ID)
  const secretAccessKey = nullableText(env.R2_SECRET_ACCESS_KEY)
  const bucket = nullableText(env.TRANSIT_R2_BUCKET_NAME)
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null

  const { AwsClient } = await import('aws4fetch')
  const client = new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' })
  const baseUrl = `https://${accountId}.r2.cloudflarestorage.com/${bucket}`
  const objectUrl = (key) => `${baseUrl}/${key.split('/').map(encodeURIComponent).join('/')}`

  return Object.freeze({
    async readManifest() {
      const response = await client.fetch(objectUrl(CACHE_MANIFEST_KEY))
      if (response.status === 404) {
        await response.body?.cancel().catch(() => undefined)
        return null
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        throw new Error(`R2 InterCity cache manifest GET failed (${response.status})`)
      }
      const bytes = await boundedResponseBytes(response, 128 * 1024)
      try {
        return JSON.parse(new TextDecoder().decode(bytes))
      } catch {
        return null
      }
    },

    async readResource(entry) {
      const response = await client.fetch(objectUrl(entry.key))
      if (response.status === 404) {
        await response.body?.cancel().catch(() => undefined)
        return null
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        throw new Error(`R2 InterCity cache resource GET failed (${response.status})`)
      }
      return boundedResponseBytes(response, MAX_RESOURCE_BYTES)
    },

    async writeResource(entry, body) {
      await r2Mutation(client, objectUrl(entry.key), {
        method: 'PUT',
        body,
        headers: { 'Content-Type': 'application/json' },
      })
    },

    async writeManifest(nextManifest) {
      await r2Mutation(client, objectUrl(CACHE_MANIFEST_KEY), {
        method: 'PUT',
        body: JSON.stringify(nextManifest),
        headers: { 'Content-Type': 'application/json' },
      })
    },

    async deleteResources(entries) {
      await Promise.all(entries.map((entry) => r2Mutation(client, objectUrl(entry.key), { method: 'DELETE' }, true)))
    },
  })
}

async function fetchUpstreamResource(upstreamFetch, url, headers) {
  let lastError
  for (let attempt = 1; attempt <= MAX_UPSTREAM_ATTEMPTS; attempt += 1) {
    let response
    try {
      response = await upstreamFetch(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      lastError = error
      if (attempt < MAX_UPSTREAM_ATTEMPTS) {
        await delay(2 ** attempt * 1000)
        continue
      }
      throw error
    }
    if (response.ok) return response

    const retryable = response.status === 429 || response.status >= 500
    const retryAfter = retryAfterSeconds(response.headers.get('Retry-After'))
    await response.body?.cancel().catch(() => undefined)
    if (!retryable || attempt === MAX_UPSTREAM_ATTEMPTS) {
      throw new Error(`TDX InterCity cache refresh failed (${response.status})`)
    }
    await delay(retryAfter === null ? 2 ** attempt * 1000 : Math.min(30, retryAfter) * 1000)
  }
  throw lastError ?? new Error('TDX InterCity cache refresh exhausted')
}

async function r2Mutation(client, url, init, allowMissing = false) {
  let lastError
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await client.fetch(url, init)
      await response.body?.cancel().catch(() => undefined)
      if (response.ok || (allowMissing && response.status === 404)) return
      lastError = new Error(`R2 InterCity cache mutation failed (${response.status})`)
      if (response.status !== 429 && response.status < 500) throw lastError
    } catch (error) {
      lastError = error
    }
    if (attempt < 4) await delay(500 * attempt)
  }
  throw lastError
}

async function boundedResponseBytes(response, maximumBytes) {
  const contentLength = Number(response.headers.get('Content-Length'))
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error('InterCity cache object exceeds read limit')
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > maximumBytes) throw new Error('InterCity cache object exceeds read limit')
  return bytes
}

function intercityResourceUrl(requestUrl, resource) {
  const url = new URL(requestUrl)
  url.pathname = url.pathname.replace(INTERCITY_PATH, `/api/basic/v2/Bus/${resource}/InterCity`)
  url.search = '?$format=JSON'
  return url
}

function requestHeaders(input, init) {
  if (input instanceof Request) {
    const headers = new Headers(input.headers)
    if (init?.headers) {
      for (const [name, value] of new Headers(init.headers)) headers.set(name, value)
    }
    return headers
  }
  return new Headers(init?.headers)
}

function fetchUrl(input) {
  if (input instanceof URL) return input
  if (input instanceof Request) return new URL(input.url)
  return new URL(String(input))
}

function cachedJsonResponse(bytes) {
  return new Response(bytes.slice(), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function assertJsonArray(bytes, resource) {
  let parsed
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new Error(`TDX InterCity ${resource} response is not valid JSON`)
  }
  if (!Array.isArray(parsed)) throw new Error(`TDX InterCity ${resource} response is not an array`)
}

function validResourceEntry(value) {
  return Boolean(value
    && typeof value.key === 'string'
    && value.key.startsWith(`${CACHE_PREFIX}/`)
    && Number.isInteger(value.bytes)
    && value.bytes >= 0
    && value.bytes <= MAX_RESOURCE_BYTES)
}

function retryAfterSeconds(value) {
  if (value === null) return null
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null
}

function asUint8Array(value) {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  throw new TypeError('InterCity cache resource must be bytes')
}

function asDate(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw new TypeError('Invalid cache clock')
  return date
}

function dateValue(value) {
  return asDate(value).getTime()
}

function nullableText(value) {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  return text || null
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function emit(logger, event) {
  try {
    logger(Object.freeze(event))
  } catch {
    // Cache telemetry must never affect snapshot publication.
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
