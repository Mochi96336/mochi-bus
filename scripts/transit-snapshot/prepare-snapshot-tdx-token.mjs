import {
  acquireSnapshotTdxToken,
  DEFAULT_SNAPSHOT_TDX_TOKEN_FILE,
  writeSnapshotTdxTokenFile,
} from './snapshot-tdx-token.mjs'

const target = process.env.SNAPSHOT_TDX_ACCESS_TOKEN_FILE ?? DEFAULT_SNAPSHOT_TDX_TOKEN_FILE
const record = await acquireSnapshotTdxToken()
await writeSnapshotTdxTokenFile(target, record)

// Deliberately report only non-secret lifetime metadata. The token and credential
// identities stay exclusively in the mode-0600 job-local file.
console.log(JSON.stringify({
  event: 'snapshot_tdx_token_preflight',
  result: 'success',
  expiresAt: new Date(record.expiresAt).toISOString(),
}))
