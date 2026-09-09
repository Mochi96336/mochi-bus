import { createSnapshotTdxLazyAuthFetch } from './snapshot-tdx-lazy-auth.mjs'

const INSTALL_MARKER = Symbol.for('mochi-bus.snapshot-tdx-lazy-auth-installed')
const tokenFile = process.env.SNAPSHOT_TDX_ACCESS_TOKEN_FILE?.trim()

if (!globalThis[INSTALL_MARKER] && typeof globalThis.fetch === 'function') {
  globalThis.fetch = createSnapshotTdxLazyAuthFetch({
    originalFetch: globalThis.fetch,
    tokenFile,
  })
  globalThis[INSTALL_MARKER] = true
}

// snapshot:window spawns a separate publisher process for every city. Propagate
// this preload so the child keeps the same cache-before-auth ordering and can
// reuse the optional job-local token file after the first real upstream miss.
const option = `--import=${import.meta.url}`
const current = process.env.NODE_OPTIONS?.trim() ?? ''
if (!current.includes(option)) {
  process.env.NODE_OPTIONS = current ? `${current} ${option}` : option
}
