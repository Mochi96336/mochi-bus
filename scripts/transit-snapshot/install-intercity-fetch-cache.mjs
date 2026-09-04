import { createIntercityFetchCache, intercityCacheScope } from './intercity-fetch-cache.mjs'

const INSTALL_MARKER = Symbol.for('mochi-bus.tdx-intercity-cache-installed')
const scope = intercityCacheScope()

if (!globalThis[INSTALL_MARKER] && scope && typeof globalThis.fetch === 'function') {
  globalThis.fetch = createIntercityFetchCache({ fetchImpl: globalThis.fetch, scope })
  globalThis[INSTALL_MARKER] = true
}

// run-snapshot-window.mjs spawns the city publisher with process.execPath.
// Propagate this preload through NODE_OPTIONS so every city process in the same
// workflow run shares the same on-disk InterCity cache.
if (scope) {
  const option = `--import=${import.meta.url}`
  const current = process.env.NODE_OPTIONS?.trim() ?? ''
  if (!current.includes(option)) {
    process.env.NODE_OPTIONS = current ? `${current} ${option}` : option
  }
}
