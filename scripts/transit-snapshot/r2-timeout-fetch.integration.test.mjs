import { afterEach, describe, expect, it, vi } from 'vitest'
import { AwsClient } from 'aws4fetch'
import { createR2TimeoutFetch } from './r2-timeout-fetch.mjs'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('aws4fetch snapshot timeout integration', () => {
  it('sends signed R2 requests through the installed global timeout wrapper', async () => {
    const networkFetch = vi.fn(async (_input, init) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      return new Response('{}', { status: 200 })
    })
    globalThis.fetch = createR2TimeoutFetch({ fetchImpl: networkFetch, timeoutMs: 50 })
    const client = new AwsClient({
      accessKeyId: 'test-access-key',
      secretAccessKey: 'test-secret-key',
      service: 's3',
      region: 'auto',
    })

    await client.fetch('https://account.r2.cloudflarestorage.com/test-bucket/key')

    expect(networkFetch).toHaveBeenCalledOnce()
    const request = networkFetch.mock.calls[0][0]
    expect(request).toBeInstanceOf(Request)
    expect(new URL(request.url).hostname).toBe('account.r2.cloudflarestorage.com')
  })
})
