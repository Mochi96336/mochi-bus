import {
  createR2StaticSourceStorage,
  createTdxStaticSourceCache,
  tdxStaticProbeUrl,
} from './tdx-static-source-cache.mjs'
import {
  staticSourceMinimumRefreshMs,
  staticSourceRefreshFloorBypassed,
} from './static-source-refresh-policy.mjs'

// City code becomes part of an R2 object key, so keep this narrower than a URL segment.
const CITY_CODE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/

export function createCitySourceCache({ city, fetchImpl, storage, logger = console, env = process.env, now }) {
  const safeCity = cityCode(city)
  return createTdxStaticSourceCache({
    fetchImpl,
    storage,
    cachePrefix: `tdx-source-cache/v1/city/${safeCity}`,
    sourceLabel: `City/${safeCity}`,
    eventName: 'tdx_city_persistent_cache',
    logger,
    minimumRefreshMsForResource: (resource) => staticSourceMinimumRefreshMs(env, 'city', resource),
    bypassMinimumRefresh: staticSourceRefreshFloorBypassed(env),
    ...(now ? { now } : {}),
  })
}

export function createR2CitySourceCache({
  city,
  env = process.env,
  fetchImpl = globalThis.fetch,
  logger = console,
  storage = createR2StaticSourceStorage({ env }),
  now,
} = {}) {
  if (!storage || typeof fetchImpl !== 'function') return null
  return createCitySourceCache({ city, fetchImpl, storage, logger, env, now })
}

export const cityProbeUrl = tdxStaticProbeUrl

function cityCode(value) {
  if (typeof value !== 'string' || !CITY_CODE.test(value)) throw new TypeError('Invalid TDX city code')
  return value
}
