import { describe, expect, it, vi } from 'vitest'
import {
  createSnapshotTdxLazyAuthFetch,
  isSnapshotTdxTerminalAuthError,
  snapshotTdxLazyAccessToken,
} from './snapshot-tdx-lazy-auth.mjs'
import { TDX_TOKEN_ENDPOINT } from './snapshot-tdx-token.mjs'

const CITY_URL = 'https://tdx.transportdata.tw/api/basic/v2/Bus/Route/City/ChiayiCounty?$format=JSON'

function credentials() {
  return {
    TDX_CLIENT_ID: 'client-id-private',
    TDX_CLIENT_SECRET: 'client-secret-private',
  }
}

function lazyHeaders() {
  return { Authorization: `Bearer ${snapshotTdxLazyAccessToken()}` }
}

describe('snapshot lazy TDX terminal auth failure', () => {
  it('memoizes one bounded OAuth rejection instead of reacquiring for later data attempts', async () => {
    const originalFetch = vi.fn(async (input) => {
      expect(String(input)).toBe(TDX_TOKEN_ENDPOINT)
      return new Response(JSON.stringify({
        error: 'unauthorized_client',
        error_description: 'client-id-private client-secret-private must never escape',
      }), { status: 400 })
    })
    const lazyFetch = createSnapshotTdxLazyAuthFetch({
      originalFetch,
      env: credentials(),
    })

    for (let attempt = 0; attempt < 2; attempt += 1) {
      let error
      try {
        await lazyFetch(CITY_URL, { headers: lazyHeaders() })
      } catch (caught) {
        error = caught
      }
      expect(isSnapshotTdxTerminalAuthError(error)).toBe(true)
      expect(error?.message).toBe('TDX token preflight failed (400; unauthorized_client)')
      expect(error?.message).not.toMatch(/client-id-private|client-secret-private|must never escape/)
    }

    expect(originalFetch).toHaveBeenCalledOnce()
  })
})
