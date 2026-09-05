import { createCityFetchCache } from './city-fetch-cache.mjs'
import { createCitySourceCache } from './city-source-cache.mjs'
import { createIntercityFetchCache, intercityCacheScope } from './intercity-fetch-cache.mjs'
import { createIntercitySourceCache } from './intercity-source-cache.mjs'
import { createR2StaticSourceStorage } from './tdx-static-source-cache.mjs'
import { registerTdxStaticSourceCandidate } from './tdx-static-source-promotion.mjs'

const INSTALL_MARKER = Symbol.for('mochi-bus.tdx-static-cache-installed')
const scope = intercityCacheScope()

if (!globalThis[INSTALL_MARKER] && typeof globalThis.fetch === 'function') {
  const upstreamFetch = globalThis.fetch
  const storage = createR2StaticSourceStorage()
  let fetchImpl = upstreamFetch

  // City snapshots are already sharded one city per scheduled slot, so they do
  // not need another on-disk run cache. Persist fresh bytes as candidates in R2;
  // state.json is promoted only after the publisher validates the complete model.
  if (storage) {
    const cityCaches = new Map()
    fetchImpl = createCityFetchCache({
      fetchImpl,
      registerCandidate: registerTdxStaticSourceCandidate,
      persistentForCity: (city) => {
        let cache = cityCaches.get(city)
        if (!cache) {
          cache = createCitySourceCache({ city, fetchImpl: upstreamFetch, storage })
          cityCaches.set(city, cache)
        }
        return cache
      },
    })
  }

  // InterCity keeps the workflow-attempt disk layer only for already-promoted
  // persistent hits (or when R2 is unavailable). Fresh candidates never cross a
  // process boundary before validation.
  if (scope) {
    const persistent = storage
      ? createIntercitySourceCache({ fetchImpl: upstreamFetch, storage })
      : null
    fetchImpl = createIntercityFetchCache({
      fetchImpl,
      scope,
      persistent,
      registerCandidate: registerTdxStaticSourceCandidate,
    })
  }

  globalThis.fetch = fetchImpl
  globalThis[INSTALL_MARKER] = true
}

// run-snapshot-window.mjs spawns the city publisher with process.execPath.
// Propagate this preload through NODE_OPTIONS so every city process in the same
// workflow run gets the same static-source cache policy.
if (scope) {
  const option = `--import=${import.meta.url}`
  const current = process.env.NODE_OPTIONS?.trim() ?? ''
  if (!current.includes(option)) {
    process.env.NODE_OPTIONS = current ? `${current} ${option}` : option
  }
}
