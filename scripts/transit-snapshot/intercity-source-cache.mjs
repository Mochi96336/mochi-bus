import {
  createR2StaticSourceStorage,
  createTdxStaticSourceCache,
  tdxStaticProbeUrl,
} from './tdx-static-source-cache.mjs'

const CACHE_PREFIX = 'tdx-source-cache/v1/intercity'

export function createIntercitySourceCache({ fetchImpl, storage, logger = console }) {
  return createTdxStaticSourceCache({
    fetchImpl,
    storage,
    cachePrefix: CACHE_PREFIX,
    sourceLabel: 'InterCity',
    eventName: 'tdx_intercity_persistent_cache',
    logger,
  })
}

export function createR2IntercitySourceCache({
  env = process.env,
  fetchImpl = globalThis.fetch,
  logger = console,
  storage = createR2StaticSourceStorage({ env }),
} = {}) {
  if (!storage || typeof fetchImpl !== 'function') return null
  return createIntercitySourceCache({ fetchImpl, storage, logger })
}

export const intercityProbeUrl = tdxStaticProbeUrl
