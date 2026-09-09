import {
  createR2StaticSourceStorage,
  createTdxStaticSourceCache,
  tdxStaticProbeUrl,
} from './tdx-static-source-cache.mjs'
import {
  staticSourceMinimumRefreshMs,
  staticSourceRefreshFloorBypassed,
} from './static-source-refresh-policy.mjs'

const CACHE_PREFIX = 'tdx-source-cache/v1/intercity'

export function createIntercitySourceCache({ fetchImpl, storage, logger = console, env = process.env, now }) {
  return createTdxStaticSourceCache({
    fetchImpl,
    storage,
    cachePrefix: CACHE_PREFIX,
    sourceLabel: 'InterCity',
    eventName: 'tdx_intercity_persistent_cache',
    logger,
    minimumRefreshMsForResource: (resource) => staticSourceMinimumRefreshMs(env, 'intercity', resource),
    bypassMinimumRefresh: staticSourceRefreshFloorBypassed(env),
    ...(now ? { now } : {}),
  })
}

export function createR2IntercitySourceCache({
  env = process.env,
  fetchImpl = globalThis.fetch,
  logger = console,
  storage = createR2StaticSourceStorage({ env }),
  now,
} = {}) {
  if (!storage || typeof fetchImpl !== 'function') return null
  return createIntercitySourceCache({ fetchImpl, storage, logger, env, now })
}

export const intercityProbeUrl = tdxStaticProbeUrl
