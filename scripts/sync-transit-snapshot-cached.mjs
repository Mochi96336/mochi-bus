import {
  createIntercityCachedFetch,
  createR2IntercityCacheStore,
} from './transit-snapshot/intercity-source-cache.mjs'

const upstreamFetch = globalThis.fetch.bind(globalThis)
let store = null
try {
  store = await createR2IntercityCacheStore(process.env)
} catch (error) {
  console.warn(JSON.stringify({
    event: 'tdx_intercity_source_cache',
    action: 'disabled',
    reason: 'store-init-failed',
    message: error instanceof Error ? error.message : String(error),
  }))
}

if (store) {
  globalThis.fetch = createIntercityCachedFetch({
    upstreamFetch,
    store,
    forceRefresh: process.env.SNAPSHOT_FORCE === '1',
    logger: (event) => console.log(JSON.stringify(event)),
  })
} else {
  console.warn(JSON.stringify({
    event: 'tdx_intercity_source_cache',
    action: 'disabled',
    reason: 'r2-credentials-unavailable',
  }))
}

await import('./sync-transit-snapshot.mjs')
