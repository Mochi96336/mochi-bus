import { describe, expect, it, vi } from 'vitest'
import { waitForPublicRelease } from './wait-public-release.mjs'

const EXPECTED = '0123456789abcdef0123456789abcdef01234567'
const PREVIOUS = '89abcdef0123456789abcdef0123456789abcdef'

function release(releaseSha, overrides = {}) {
  return Response.json({
    schemaVersion: 1,
    releaseSha,
    workerVersionId: 'worker-v1',
    workerCreatedAt: '2026-09-09T09:00:00.000Z',
    ...overrides,
  })
}

describe('public probe release propagation gate', () => {
  it('waits through an older release and returns only the exact pushed SHA', async () => {
    let clock = 0
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(release(PREVIOUS))
      .mockResolvedValueOnce(release(EXPECTED))
    const sleep = vi.fn(async (milliseconds) => { clock += milliseconds })

    await expect(waitForPublicRelease({
      baseUrl: 'https://bus.example',
      expectedSha: EXPECTED,
      fetchImpl,
      sleep,
      now: () => clock,
      timeoutMs: 20_000,
      pollMs: 5_000,
    })).resolves.toEqual({
      releaseSha: EXPECTED,
      workerVersionId: 'worker-v1',
      workerCreatedAt: '2026-09-09T09:00:00.000Z',
    })

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(sleep).toHaveBeenCalledWith(5_000)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(String(url)).toBe('https://bus.example/api/v1/health/release')
    expect(init).toMatchObject({ cache: 'no-store', headers: { 'Cache-Control': 'no-cache' } })
  })

  it('fails open across transient HTTP/transport errors until propagation succeeds', async () => {
    let clock = 0
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new Error('temporary network failure'))
      .mockResolvedValueOnce(new Response('deploying', { status: 503 }))
      .mockResolvedValueOnce(release(EXPECTED))
    const sleep = vi.fn(async (milliseconds) => { clock += milliseconds })

    await expect(waitForPublicRelease({
      baseUrl: 'https://bus.example', expectedSha: EXPECTED, fetchImpl, sleep,
      now: () => clock, timeoutMs: 20_000, pollMs: 2_000,
    })).resolves.toMatchObject({ releaseSha: EXPECTED })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  it('fails closed after the bounded deadline without leaking a full stale SHA', async () => {
    let clock = 0
    const fetchImpl = vi.fn(async () => release(PREVIOUS))
    const sleep = vi.fn(async (milliseconds) => { clock += milliseconds })

    await expect(waitForPublicRelease({
      baseUrl: 'https://bus.example', expectedSha: EXPECTED, fetchImpl, sleep,
      now: () => clock, timeoutMs: 5_000, pollMs: 2_000,
    })).rejects.toThrow('Public release did not reach expected SHA; last=89abcdef0123')
    expect(fetchImpl).toHaveBeenCalledTimes(4)
  })

  it('rejects malformed identity inputs before network access', async () => {
    const fetchImpl = vi.fn()
    await expect(waitForPublicRelease({
      baseUrl: 'https://bus.example/path', expectedSha: EXPECTED, fetchImpl,
    })).rejects.toThrow('Public release origin must be an absolute HTTP origin')
    await expect(waitForPublicRelease({
      baseUrl: 'https://bus.example', expectedSha: 'main', fetchImpl,
    })).rejects.toThrow('Expected release SHA must be a full lowercase Git SHA')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
