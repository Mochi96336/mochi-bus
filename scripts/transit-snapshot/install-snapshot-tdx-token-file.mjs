import { createSnapshotTdxTokenFileFetch } from './snapshot-tdx-token.mjs'

const INSTALL_MARKER = Symbol.for('mochi-bus.snapshot-tdx-token-file-installed')
const tokenFile = process.env.SNAPSHOT_TDX_ACCESS_TOKEN_FILE?.trim()

if (tokenFile && !globalThis[INSTALL_MARKER] && typeof globalThis.fetch === 'function') {
  globalThis.fetch = createSnapshotTdxTokenFileFetch({
    originalFetch: globalThis.fetch,
    tokenFile,
  })
  globalThis[INSTALL_MARKER] = true
}
