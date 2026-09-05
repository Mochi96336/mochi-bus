import { describe, expect, it, vi } from 'vitest'
import {
  createR2TimeoutFetch,
  isCloudflareR2Url,
  SNAPSHOT_R2_REQUEST_TIMEOUT_MS,
} from './r2-timeout-fetch.mjs'

describe('snapshot R2 timeout fetch', () => {
  it('recognizes only the Cloudflare S3-compatible R2 origin', () => {
    expect(isCloudflareR2Url('https://abc123.r2.cloudflarestorage.com/bucket/key')).toBe(true)
    expect(isCloudflareR2Url('http://abc123.r2.cloudflarestorage.com/bucket/key')).toBe(false)
    expect(isCloudflareR2Url('https://r2.cloudflarestorage.com.evil.example/key')).toBe(false)
    expect(isCloudflareR2Url('https://tdx.transportdata.tw/api/basic/v2/Bus/Route/City/Taipei')).toBe(false)
  })

  it('leaves non-R2 requests untouched', async () => {
    const init = { headers: { Accept: 'application/json' } }
    const fetchImpl = vi.fn(async () => new Response('ok'))
    const wrapped = createR2TimeoutFetch({ fetchImpl })

    await wrapped('https://tdx.transportdata.tw/api/basic/v2/Bus/Route/City/Taipei', init)

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://tdx.transportdata.tw/api/basic/v2/Bus/Route/City/Taipei',
      init,
    )
  })

  it('adds the publisher timeout to R2 requests', async () => {
    const fetchImpl = vi.fn(async (_input, init) => {
      expect(init.signal).toBeInstanceOf(AbortSignal)
      expect(init.signal.aborted).toBe(false)
      return new Response('ok')
    })
    const wrapped = createR2TimeoutFetch({ fetchImpl })

    await wrapped('https://abc123.r2.cloudflarestorage.com/transit/key', { method: 'GET' })
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(SNAPSHOT_R2_REQUEST_TIMEOUT_MS).toBe(20_000)
  })

  it('composes an existing abort signal instead of replacing it', async () => {
    const controller = new AbortController()
    let observedSignal
    const fetchImpl = vi.fn(async (_input, init) => {
      observedSignal = init.signal
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
      })
    })
    const wrapped = createR2TimeoutFetch({ fetchImpl, timeoutMs: 60_000 })
    const pending = wrapped('https://abc123.r2.cloudflarestorage.com/transit/key', {
      signal: controller.signal,
    })
    controller.abort(new Error('caller cancelled'))

    await expect(pending).rejects.toThrow('caller cancelled')
    expect(observedSignal).not.toBe(controller.signal)
    expect(observedSignal.aborted).toBe(true)
  })

  it('actually aborts a stalled R2 request at the configured boundary', async () => {
    const fetchImpl = vi.fn(async (_input, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
    }))
    const wrapped = createR2TimeoutFetch({ fetchImpl, timeoutMs: 5 })

    await expect(wrapped('https://abc123.r2.cloudflarestorage.com/transit/key'))
      .rejects.toMatchObject({ name: 'TimeoutError' })
  })
})
