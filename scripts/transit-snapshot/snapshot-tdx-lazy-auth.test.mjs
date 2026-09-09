import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCityFetchCache } from './city-fetch-cache.mjs'
import {
  createSnapshotTdxLazyAuthFetch,
  snapshotTdxLazyAccessToken,
} from './snapshot-tdx-lazy-auth.mjs'
import { TDX_TOKEN_ENDPOINT } from './snapshot-tdx-token.mjs'

const CITY_URL = 'https://tdx.transportdata.tw/api/basic/v2/Bus/Route/City/Taipei?$format=JSON'
const roots = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function credentials() {
  return {
    TDX_CLIENT_ID: 'client-id-private',
    TDX_CLIENT_SECRET: 'client-secret-private',
  }
}

async function tokenPath() {
  const root = await mkdtemp(join(tmpdir(), 'mochi-lazy-tdx-auth-'))
  roots.push(root)
  return join(root, 'token.json')
}

function lazyHeaders() {
  return { Authorization: `Bearer ${snapshotTdxLazyAccessToken()}` }
}

describe('snapshot lazy TDX auth', () => {
  it('keeps the core token handshake and a persistent City cache hit completely off network', async () => {
    const originalFetch = vi.fn()
    const lazyFetch = createSnapshotTdxLazyAuthFetch({
      originalFetch,
      env: {},
    })
    const persistent = {
      resolve: vi.fn(async () => ({ sourceVersion: '2026-09-01', body: Buffer.from('[]') })),
    }
    const cachedFetch = createCityFetchCache({
      fetchImpl: lazyFetch,
      persistentForCity: () => persistent,
      logger: { log: vi.fn(), warn: vi.fn() },
    })

    const tokenResponse = await cachedFetch(TDX_TOKEN_ENDPOINT, { method: 'POST' })
    await expect(tokenResponse.json()).resolves.toMatchObject({
      access_token: snapshotTdxLazyAccessToken(),
    })
    await expect((await cachedFetch(CITY_URL, { headers: lazyHeaders() })).json()).resolves.toEqual([])

    expect(persistent.resolve).toHaveBeenCalledOnce()
    expect(originalFetch).not.toHaveBeenCalled()
  })

  it('acquires a real bearer only after a cache miss and reuses it in process', async () => {
    const seenAuthorization = []
    const originalFetch = vi.fn(async (input, init) => {
      const url = String(input)
      if (url === TDX_TOKEN_ENDPOINT) {
        return new Response(JSON.stringify({ access_token: 'real-token-private', expires_in: 3600 }))
      }
      seenAuthorization.push(new Headers(init?.headers).get('Authorization'))
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    const lazyFetch = createSnapshotTdxLazyAuthFetch({
      originalFetch,
      env: credentials(),
      now: () => 1_000_000,
    })
    const persistent = {
      resolve: vi.fn(async () => ({ sourceVersion: null, body: null })),
      stage: vi.fn(async () => null),
    }
    const cachedFetch = createCityFetchCache({
      fetchImpl: lazyFetch,
      persistentForCity: () => persistent,
      logger: { log: vi.fn(), warn: vi.fn() },
    })

    await cachedFetch(TDX_TOKEN_ENDPOINT, { method: 'POST' })
    await cachedFetch(CITY_URL, { headers: lazyHeaders() })
    await cachedFetch(CITY_URL, { headers: lazyHeaders() })

    const oauthCalls = originalFetch.mock.calls.filter(([input]) => String(input) === TDX_TOKEN_ENDPOINT)
    expect(oauthCalls).toHaveLength(1)
    expect(seenAuthorization).toEqual(['Bearer real-token-private', 'Bearer real-token-private'])
  })

  it('shares one OAuth acquisition across concurrent InterCity-style misses', async () => {
    let releaseToken
    const tokenGate = new Promise((resolve) => { releaseToken = resolve })
    const originalFetch = vi.fn(async (input, init) => {
      if (String(input) === TDX_TOKEN_ENDPOINT) {
        await tokenGate
        return new Response(JSON.stringify({ access_token: 'shared-token-private', expires_in: 3600 }))
      }
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer shared-token-private')
      return new Response('[]')
    })
    const lazyFetch = createSnapshotTdxLazyAuthFetch({
      originalFetch,
      env: credentials(),
      now: () => 2_000_000,
    })

    const first = lazyFetch('https://tdx.transportdata.tw/api/basic/v2/Bus/Route/InterCity?$format=JSON', {
      headers: lazyHeaders(),
    })
    const second = lazyFetch('https://tdx.transportdata.tw/api/basic/v2/Bus/Shape/InterCity?$format=JSON', {
      headers: lazyHeaders(),
    })
    releaseToken()
    await Promise.all([first, second])

    const oauthCalls = originalFetch.mock.calls.filter(([input]) => String(input) === TDX_TOKEN_ENDPOINT)
    expect(oauthCalls).toHaveLength(1)
  })

  it('reuses the job-local token file across publisher processes without another OAuth call', async () => {
    const file = await tokenPath()
    const firstFetch = vi.fn(async (input, init) => {
      if (String(input) === TDX_TOKEN_ENDPOINT) {
        return new Response(JSON.stringify({ access_token: 'file-token-private', expires_in: 3600 }))
      }
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer file-token-private')
      return new Response('[]')
    })
    const firstProcess = createSnapshotTdxLazyAuthFetch({
      originalFetch: firstFetch,
      tokenFile: file,
      env: credentials(),
      now: () => 3_000_000,
    })
    await firstProcess(CITY_URL, { headers: lazyHeaders() })

    const secondFetch = vi.fn(async (_input, init) => {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer file-token-private')
      return new Response('[]')
    })
    const secondProcess = createSnapshotTdxLazyAuthFetch({
      originalFetch: secondFetch,
      tokenFile: file,
      env: credentials(),
      now: () => 3_000_001,
    })
    await secondProcess(CITY_URL, { headers: lazyHeaders() })

    expect(firstFetch.mock.calls.filter(([input]) => String(input) === TDX_TOKEN_ENDPOINT)).toHaveLength(1)
    expect(secondFetch).toHaveBeenCalledOnce()
    expect(String(secondFetch.mock.calls[0]?.[0])).toBe(CITY_URL)
  })
})
