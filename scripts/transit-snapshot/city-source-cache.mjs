import {
  createR2StaticSourceStorage,
  createTdxStaticSourceCache,
  tdxStaticProbeUrl,
} from './tdx-static-source-cache.mjs'

const CITY_CODE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/

export function createCitySourceCache({ city, fetchImpl, storage, logger = console }) {
  const safeCity = cityCode(city)
  return createTdxStaticSourceCache({
    fetchImpl,
    storage,
    cachePrefix: `tdx-source-cache/v1/city/${safeCity}`,
    sourceLabel: `City/${safeCity}`,
    eventName: 'tdx_city_persistent_cache',
    logger,
  })
}

export function createR2CitySourceCache({
  city,
  env = process.env,
  fetchImpl = globalThis.fetch,
  logger = console,
  storage = createR2StaticSourceStorage({ env }),
} = {}) {
  if (!storage || typeof fetchImpl !== 'function') return null
  return createCitySourceCache({ city, fetchImpl, storage, logger })
}

export const cityProbeUrl = tdxStaticProbeUrl

function cityCode(value) {
  if (typeof value !== 'string' || !CITY_CODE.test(value)) throw new TypeError('Invalid TDX city code')
  return value
}
