import { mkdtemp, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  acquireSnapshotTdxToken,
  createSnapshotTdxTokenFileFetch,
  readSnapshotTdxTokenFile,
  TDX_TOKEN_ENDPOINT,
  writeSnapshotTdxTokenFile,
} from './snapshot-tdx-token.mjs'

const roots = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function tokenPath() {
  const root = await mkdtemp(join(tmpdir(), 'mochi-snapshot-tdx-token-'))
  roots.push(root)
  return join(root, 'nested', 'token.json')
}

function credentials() {
  return {
    TDX_CLIENT_ID: 'client-id-private',
    TDX_CLIENT_SECRET: 'client-secret-private',
  }
}

describe('snapshot TDX shared token', () => {
  it('acquires once and writes a mode-0600 job-local token file', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      access_token: 'access-token-private',
      expires_in: 3600,
    }), { status: 200 }))
    const record = await acquireSnapshotTdxToken({
      env: credentials(),
      fetchImpl,
      now: () => 1_000_000,
      sleep: vi.fn(),
    })
    const file = await tokenPath()
    await writeSnapshotTdxTokenFile(file, record)

    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(TDX_TOKEN_ENDPOINT)
    const options = fetchImpl.mock.calls[0]?.[1]
    expect(options?.method).toBe('POST')
    expect(String(options?.body)).toContain('grant_type=client_credentials')
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    await expect(readSnapshotTdxTokenFile(file, 1_000_001)).resolves.toMatchObject({
      accessToken: 'access-token-private',
      expiresAt: 4_600_000,
    })
  })

  it('reports only bounded OAuth classification on a terminal auth failure', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      error: 'unauthorized_client',
      error_description: 'client-id-private client-secret-private should never escape',
    }), { status: 400 }))

    let error
    try {
      await acquireSnapshotTdxToken({
        env: credentials(),
        fetchImpl,
        maxAttempts: 1,
        sleep: vi.fn(),
      })
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe('TDX token preflight failed (400; unauthorized_client)')
    expect(error.message).not.toMatch(/client-id-private|client-secret-private|should never escape/)
  })

  it('retries a 429 once using Retry-After without multiplying successful token acquisition', async () => {
    const sleep = vi.fn()
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('{"error":"temporarily_unavailable"}', {
        status: 429,
        headers: { 'Retry-After': '3' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'ok', expires_in: 600 })))

    await expect(acquireSnapshotTdxToken({
      env: credentials(),
      fetchImpl,
      sleep,
      maxAttempts: 2,
      now: () => 10_000,
    })).resolves.toMatchObject({ accessToken: 'ok' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledWith(3000)
  })

  it('serves only the exact token POST from the shared file and never calls upstream again', async () => {
    const file = await tokenPath()
    await writeSnapshotTdxTokenFile(file, {
      schemaVersion: 1,
      accessToken: 'file-token-private',
      obtainedAt: 1000,
      expiresAt: 3_601_000,
    })
    const originalFetch = vi.fn(async () => new Response('upstream'))
    const fetchImpl = createSnapshotTdxTokenFileFetch({
      originalFetch,
      tokenFile: file,
      now: () => 2000,
    })

    const tokenResponse = await fetchImpl(TDX_TOKEN_ENDPOINT, { method: 'POST' })
    await expect(tokenResponse.json()).resolves.toMatchObject({ access_token: 'file-token-private' })
    expect(originalFetch).not.toHaveBeenCalled()

    const dataUrl = 'https://tdx.transportdata.tw/api/basic/v2/Bus/Route/City/Taipei'
    await expect((await fetchImpl(dataUrl)).text()).resolves.toBe('upstream')
    expect(originalFetch).toHaveBeenCalledOnce()
  })

  it('fails closed instead of re-authenticating per city when the shared file is expired', async () => {
    const file = await tokenPath()
    await writeSnapshotTdxTokenFile(file, {
      schemaVersion: 1,
      accessToken: 'expired-private',
      obtainedAt: 1000,
      expiresAt: 61_000,
    })
    const originalFetch = vi.fn()
    const fetchImpl = createSnapshotTdxTokenFileFetch({
      originalFetch,
      tokenFile: file,
      now: () => 60_000,
    })

    await expect(fetchImpl(TDX_TOKEN_ENDPOINT, { method: 'POST' }))
      .rejects.toThrow('Shared TDX snapshot token file is invalid or expired')
    expect(originalFetch).not.toHaveBeenCalled()
  })
})
