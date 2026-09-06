import { describe, expect, it, vi } from 'vitest'
import {
  createTdxStaticSourceProjectionFetch,
  STATIC_SOURCE_SELECT,
  tdxStaticSourceProjectionUrl,
} from './tdx-static-source-projection.mjs'

const base = 'https://tdx.transportdata.tw/api/basic/v2/Bus'

function projection(path) {
  const url = tdxStaticSourceProjectionUrl(`${base}/${path}?$format=JSON`)
  return url ? Object.fromEntries(url.searchParams) : null
}

describe('TDX static source projection', () => {
  it('projects every audited City static payload used by the publisher', () => {
    for (const resource of ['Route', 'StopOfRoute', 'Shape', 'Schedule']) {
      expect(projection(`${resource}/City/Taipei`)).toEqual({
        '$format': 'JSON',
        '$select': STATIC_SOURCE_SELECT[resource],
      })
    }
  })

  it('projects the nationwide InterCity payloads, including the Stop location index', () => {
    for (const resource of ['Route', 'Stop', 'StopOfRoute', 'Shape', 'Schedule']) {
      expect(projection(`${resource}/InterCity`)).toEqual({
        '$format': 'JSON',
        '$select': STATIC_SOURCE_SELECT[resource],
      })
    }
  })

  it('does not rewrite probes, filtered requests, City Stop, dynamic resources, non-TDX hosts, or writes', () => {
    expect(tdxStaticSourceProjectionUrl(`${base}/Route/City/Taipei?$select=UpdateTime&$format=JSON`)).toBeNull()
    expect(tdxStaticSourceProjectionUrl(`${base}/Route/City/Taipei?$filter=RouteUID%20eq%20'R1'&$format=JSON`)).toBeNull()
    expect(tdxStaticSourceProjectionUrl(`${base}/Stop/City/Taipei?$format=JSON`)).toBeNull()
    expect(tdxStaticSourceProjectionUrl(`${base}/EstimatedTimeOfArrival/City/Taipei?$format=JSON`)).toBeNull()
    expect(tdxStaticSourceProjectionUrl('https://example.com/api/basic/v2/Bus/Shape/InterCity?$format=JSON')).toBeNull()
    expect(tdxStaticSourceProjectionUrl(`${base}/Shape/InterCity?$format=JSON`, { method: 'POST' })).toBeNull()
  })

  it('forwards auth/options while changing only the eligible URL', async () => {
    const fetchImpl = vi.fn(async () => new Response('[]'))
    const projectedFetch = createTdxStaticSourceProjectionFetch({ fetchImpl })
    const init = { headers: { Authorization: 'Bearer token' }, signal: AbortSignal.timeout(1000) }

    await projectedFetch(`${base}/Schedule/City/Tainan?$format=JSON`, init)
    expect(fetchImpl).toHaveBeenCalledOnce()
    const [url, forwardedInit] = fetchImpl.mock.calls[0]
    expect(url).toBeInstanceOf(URL)
    expect(url.searchParams.get('$select')).toBe(STATIC_SOURCE_SELECT.Schedule)
    expect(forwardedInit).toBe(init)
  })
})
