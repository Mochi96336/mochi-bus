import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  createReleaseSmokeFetch,
  finalSnapshotOnlyUrl,
  withReleaseSmokeFetch,
} from './fetch-policy.mjs'

const origin = 'https://bus.example.test'
const initialArrivals = `${origin}/api/v1/map/place/place-1/arrivals?city=Taipei&release_smoke=run:sha:initial-arrivals`
const finalArrivals = `${origin}/api/v1/map/place/place-1/arrivals?city=Taipei&release_smoke=run:sha:final-arrivals`
const authoritativeSource = readFileSync(new URL('./run-authoritative-post-deploy.mjs', import.meta.url), 'utf8')

describe('release smoke fetch policy', () => {
  it('keeps initial realtime coverage but makes final arrivals snapshot-only', () => {
    expect(finalSnapshotOnlyUrl(initialArrivals)).toBeNull()
    const rewritten = finalSnapshotOnlyUrl(finalArrivals)
    expect(rewritten).toBeInstanceOf(URL)
    expect(rewritten.searchParams.get('city')).toBe('Taipei')
    expect(rewritten.searchParams.get('release_smoke')).toBe('run:sha:final-arrivals')
    expect(rewritten.searchParams.get('realtime')).toBe('0')
  })

  it('does not rewrite unrelated or lookalike requests', () => {
    expect(finalSnapshotOnlyUrl(`${origin}/api/v1/map/vehicles?release_smoke=run:sha:final-arrivals`)).toBeNull()
    expect(finalSnapshotOnlyUrl(`${origin}/api/v1/map/place/place-1/arrivals?release_smoke=run:sha:browser`)).toBeNull()
    expect(finalSnapshotOnlyUrl('not a url')).toBeNull()
  })

  it('preserves Request method and headers while rewriting only the URL', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }))
    const wrapped = createReleaseSmokeFetch({ fetchImpl })
    const request = new Request(finalArrivals, {
      method: 'POST',
      headers: { 'X-Smoke-Test': 'preserve-me' },
      body: '{}',
    })

    await wrapped(request)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const forwarded = fetchImpl.mock.calls[0][0]
    expect(forwarded).toBeInstanceOf(Request)
    expect(forwarded.method).toBe('POST')
    expect(forwarded.headers.get('X-Smoke-Test')).toBe('preserve-me')
    expect(new URL(forwarded.url).searchParams.get('realtime')).toBe('0')
  })

  it('passes non-target input and init through unchanged', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }))
    const wrapped = createReleaseSmokeFetch({ fetchImpl })
    const init = { headers: { Accept: 'application/json' } }

    await wrapped(initialArrivals, init)
    expect(fetchImpl).toHaveBeenCalledWith(initialArrivals, init)
  })

  it('restores the original fetch even when the smoke operation throws', async () => {
    const originalFetch = vi.fn(async () => new Response('{}'))
    const globalObject = { fetch: originalFetch }
    const failure = new Error('synthetic smoke failure')

    await expect(withReleaseSmokeFetch(async () => {
      expect(globalObject.fetch).not.toBe(originalFetch)
      throw failure
    }, { globalObject })).rejects.toBe(failure)
    expect(globalObject.fetch).toBe(originalFetch)
  })

  it('installs the tested lifecycle only around the authoritative production smoke call', () => {
    expect(authoritativeSource).toContain("import { withReleaseSmokeFetch } from './fetch-policy.mjs'")
    expect(authoritativeSource).toContain('await withReleaseSmokeFetch(async () => {')
    expect(authoritativeSource).toContain('await runPostDeploySmoke({ ...env, RELEASE_SMOKE_ORIGIN: origin })')
  })
})
