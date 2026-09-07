import { assertPublisherR2Credentials } from './transit-snapshot/publisher-r2-preflight.mjs'

// Keep the raw script entrypoint fail-closed too. Supported npm/workflow paths
// preflight earlier, but direct `node scripts/sync-transit-snapshot.mjs` calls
// must not acquire TDX data when R2 publication authority is unavailable.
await assertPublisherR2Credentials()
await import('./sync-transit-snapshot-core.mjs')
