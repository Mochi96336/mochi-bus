import { describe, expect, it, vi } from 'vitest'
import {
  classifyPublicProbeRequestFailureDetail,
  createPublicApiAdapter,
  PublicApiError,
} from './run-public-probe.mjs'

async function httpFailureDetail(contentType) {
  const headers = new Headers()
  if (contentType !== null) headers.set('Content-Type', contentType)
  const fetchImpl = vi.fn(async () => new Response(null, {
    status: 502,
    headers,
  }))
  const api = createPublicApiAdapter({
    baseUrl: 'https://bus.example',
    fetchImpl,
    expensiveIntervalMs: 0,
  })

  try {
    await api.getJson('/api/v1/map/route?city=Hsinchu&route=100')
    throw new Error('expected public API failure')
  } catch (error) {
    return classifyPublicProbeRequestFailureDetail(error)
  }
}

describe('public probe HTTP response-kind diagnostics', () => {
  it.each([
    ['application/json; charset=UTF-8', 'json'],
    ['application/problem+json', 'json'],
    ['text/html; charset=utf-8', 'html'],
    ['application/xhtml+xml', 'html'],
    ['text/plain; charset=utf-8', 'other'],
    [null, 'missing'],
  ])('classifies %s without retaining the raw header', async (contentType, expectedKind) => {
    const detail = await httpFailureDetail(contentType)

    expect(detail).toEqual({
      requestFailureReason: 'http_error',
      requestHttpStatusClass: '5xx',
      requestHttpResponseKind: expectedKind,
    })
    expect(detail).not.toHaveProperty('status')
    expect(detail).not.toHaveProperty('contentType')
    expect(JSON.stringify(detail)).not.toContain(contentType ?? 'missing-header-value')
  })

  it('fail-closes arbitrary response-kind values to the bounded missing class', () => {
    expect(classifyPublicProbeRequestFailureDetail(
      new PublicApiError(502, 'private/raw/content-type'),
    )).toEqual({
      requestFailureReason: 'http_error',
      requestHttpStatusClass: '5xx',
      requestHttpResponseKind: 'missing',
    })
  })
})
