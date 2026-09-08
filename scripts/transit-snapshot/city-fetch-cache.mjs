const TDX_ORIGIN = 'https://tdx.transportdata.tw'
const CITY_PATH = /^\/api\/basic\/v2\/Bus\/(Route|StopOfRoute|Shape|Schedule)\/City\/([A-Za-z][A-Za-z0-9_-]{0,63})$/

export function isCacheableCityRequest(input, init = {}) {
  if (requestMethod(input, init) !== 'GET') return false
  let url
  try {
    url = new URL(requestUrl(input))
  } catch {
    return false
  }
  if (url.origin !== TDX_ORIGIN) return false
  if (!CITY_PATH.test(url.pathname)) return false
  if (url.searchParams.size !== 1) return false
  return url.searchParams.get('$format') === 'JSON'
}

export function cityCacheIdentity(input) {
  const url = new URL(requestUrl(input))
  const match = CITY_PATH.exec(url.pathname)
  return match ? { resource: match[1], city: match[2] } : null
}

export function createCityFetchCache({
  fetchImpl = globalThis.fetch,
  persistentForCity,
  registerCandidate = () => undefined,
  logger = console,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function')
  if (typeof persistentForCity !== 'function') return fetchImpl

  return async function cachedCityFetch(input, init) {
    if (!isCacheableCityRequest(input, init)) return fetchImpl(input, init)

    const identity = cityCacheIdentity(input)
    const { resource, city } = identity
    let persistent = null
    try {
      persistent = persistentForCity(city)
    } catch (error) {
      logger?.warn?.(`TDX City persistent cache setup failed for ${city}/${resource}: ${errorMessage(error)}`)
    }
    if (!persistent) return fetchImpl(input, init)

    let sourceVersion = null
    try {
      const resolved = await persistent.resolve({ resource, input, init })
      sourceVersion = resolved?.sourceVersion ?? null
      if (resolved?.body) {
        logger?.log?.(JSON.stringify({
          event: 'tdx_city_cache',
          city,
          resource,
          resolution: 'persistent-hit',
        }))
        return jsonResponse(resolved.body)
      }
    } catch (error) {
      logger?.warn?.(`TDX City persistent cache resolve failed for ${city}/${resource}: ${errorMessage(error)}`)
    }

    let response
    try {
      response = await fetchImpl(input, init)
    } catch (error) {
      logger?.log?.(JSON.stringify({
        event: 'tdx_city_cache',
        city,
        resource,
        resolution: 'upstream-error',
        sourceVersion,
        status: null,
        bytes: null,
      }))
      throw error
    }
    if (!response.ok) {
      logger?.log?.(JSON.stringify({
        event: 'tdx_city_cache',
        city,
        resource,
        resolution: 'upstream-error',
        sourceVersion,
        status: response.status,
        bytes: contentLength(response),
      }))
      return response
    }

    const body = Buffer.from(await response.arrayBuffer())
    try {
      const candidate = await persistent.stage?.({ resource, body, sourceVersion })
      if (candidate) registerCandidate({ cache: persistent, candidate, city, resource })
    } catch (error) {
      logger?.warn?.(`TDX City persistent cache stage failed for ${city}/${resource}: ${errorMessage(error)}`)
    }
    logger?.log?.(JSON.stringify({
      event: 'tdx_city_cache',
      city,
      resource,
      resolution: 'miss',
      sourceVersion,
      status: response.status,
      bytes: body.byteLength,
    }))
    return jsonResponse(body, response.status)
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

function contentLength(response) {
  const value = response.headers.get('Content-Length')
  if (value === null) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
