import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync('scripts/sync-transit-snapshot-core.mjs', 'utf8')

describe('snapshot publisher TDX retry contract', () => {
  it('does not wrap a terminal lazy-auth failure in the outer data-request retry loop', () => {
    expect(source).toContain("import { isSnapshotTdxTerminalAuthError } from './transit-snapshot/snapshot-tdx-lazy-auth.mjs'")
    expect(source).toContain('if (isSnapshotTdxTerminalAuthError(error) || attempt === TDX_MAX_ATTEMPTS - 1)')
  })

  it('preserves retry for transport failures and HTTP 429', () => {
    expect(source).toContain('await new Promise((resolve) => setTimeout(resolve, 2 ** (attempt + 1) * 1000))')
    expect(source).toContain('if (response.status !== 429 || attempt === TDX_MAX_ATTEMPTS - 1)')
    expect(source).toContain("response.headers.get('Retry-After')")
  })
})
