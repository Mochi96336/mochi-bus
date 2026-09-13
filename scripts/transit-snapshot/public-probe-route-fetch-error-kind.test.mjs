import { describe, expect, it, vi } from 'vitest'
import {
  classifyPublicApiFailure,
  createPublicApiAdapter,
  createRouteSampleObserver,
  PublicApiError,
  PublicApiPayloadError,
} from './run-public-probe.mjs'

const sample = Object.freeze({
  patternId: 'Hsinchu:0',
  routeUid: 'Hsinchu100',
  routeName: '100',
})

function routeFailureDetail(error) {
  const publicApi = {
    getJson: vi.fn(async () => { throw error }),
    postJson: vi.fn(),
    readPrefix: vi.fn(),
  }
  const observer = createRouteSampleObserver({ publicApi, city: 'Hsinchu', sample })
  return observer.publicApi.getJson('/api/v1/map/route?city=Hsinchu')
    .catch(() => observer.detail('pub_7f2d3c536e25'))
}

describe('public route fetch error kinds', () => {
  it.each([
    [400, 'http_400'],
    [404, 'http_404'],
    [429, 'http_429'],
    [401, 'http_4xx'],
    [503, 'http_5xx'],
    [302, 'http_other'],
  ])('bounds HTTP %s as %s', async (status, errorKind) => {
    expect(classifyPublicApiFailure(new PublicApiError(status))).toBe(errorKind)
    await expect(routeFailureDetail(new PublicApiError(status))).resolves.toEqual({
      message: 'public_probe_route_sample_detail',
      city: 'Hsinchu',
      sampleCaseId: 'pub_7f2d3c536e25',
      stage: 'route_fetch_failed',
      errorKind,
    })
  })

  it('distinguishes timeout, payload, and generic network failures', async () => {
    const timeout = new Error('do not log me')
    timeout.name = 'TimeoutError'
    expect(classifyPublicApiFailure(timeout)).toBe('timeout')
    expect(classifyPublicApiFailure(new PublicApiPayloadError())).toBe('payload_error')
    expect(classifyPublicApiFailure(new TypeError('private transport detail'))).toBe('network_error')

    await expect(routeFailureDetail(timeout)).resolves.toMatchObject({
      stage: 'route_fetch_failed',
      errorKind: 'timeout',
    })
    await expect(routeFailureDetail(new PublicApiPayloadError())).resolves.toMatchObject({
      stage: 'route_fetch_failed',
      errorKind: 'payload_error',
    })
    await expect(routeFailureDetail(new TypeError('private transport detail'))).resolves.toMatchObject({
      stage: 'route_fetch_failed',
      errorKind: 'network_error',
    })
  })

  it('does not attach errorKind to non-fetch route detail stages', async () => {
    const publicApi = {
      getJson: vi.fn(async () => ({ schemaVersion: 1, source: 'snapshot', variants: [] })),
      postJson: vi.fn(),
      readPrefix: vi.fn(),
    }
    const observer = createRouteSampleObserver({ publicApi, city: 'Hsinchu', sample })
    await observer.publicApi.getJson('/api/v1/map/route?city=Hsinchu')

    expect(observer.detail('pub_7f2d3c536e25')).toEqual({
      message: 'public_probe_route_sample_detail',
      city: 'Hsinchu',
      sampleCaseId: 'pub_7f2d3c536e25',
      stage: 'variant_missing',
    })
  })

  it('wraps only successful-response JSON decode failures as payload_error', async () => {
    const malformedAdapter = createPublicApiAdapter({
      baseUrl: 'https://example.test',
      fetchImpl: vi.fn(async () => new Response('{not-json', { status: 200 })),
    })
    await expect(malformedAdapter.getJson('/api/v1/map/route?city=Hsinchu'))
      .rejects.toBeInstanceOf(PublicApiPayloadError)

    const unavailableAdapter = createPublicApiAdapter({
      baseUrl: 'https://example.test',
      fetchImpl: vi.fn(async () => new Response('unavailable', { status: 503 })),
    })
    await expect(unavailableAdapter.getJson('/api/v1/map/route?city=Hsinchu'))
      .rejects.toMatchObject({ status: 503 })
  })

  it('does not leak arbitrary error text into the detail event', async () => {
    const detail = await routeFailureDetail(new TypeError('https://secret.invalid/private?token=abc'))
    expect(detail).toEqual({
      message: 'public_probe_route_sample_detail',
      city: 'Hsinchu',
      sampleCaseId: 'pub_7f2d3c536e25',
      stage: 'route_fetch_failed',
      errorKind: 'network_error',
    })
    expect(JSON.stringify(detail)).not.toContain('secret')
    expect(JSON.stringify(detail)).not.toContain('token')
  })
})
