import { describe, expect, it } from 'vitest'
import {
  SHARED_ETA_CACHE_SECONDS,
  SHARED_VEHICLE_CACHE_SECONDS,
  tdxRealtimeCacheSeconds,
} from './realtime-cache-policy'

describe('TDX realtime cache policy', () => {
  it('raises shared ETA requests above the 30 second UI polling cadence', () => {
    const url = new URL('https://tdx.transportdata.tw/api/basic/v2/Bus/EstimatedTimeOfArrival/City/Taipei/307?$format=JSON')
    expect(tdxRealtimeCacheSeconds(url, 12)).toBe(SHARED_ETA_CACHE_SECONDS)
    expect(SHARED_ETA_CACHE_SECONDS).toBe(45)
  })

  it('lets consecutive shared vehicle polls reuse one upstream response', () => {
    const url = new URL('https://tdx.transportdata.tw/api/basic/v2/Bus/RealTimeByFrequency/City/Taipei/307?$format=JSON')
    expect(tdxRealtimeCacheSeconds(url, 15)).toBe(SHARED_VEHICLE_CACHE_SECONDS)
    expect(SHARED_VEHICLE_CACHE_SECONDS).toBe(30)
  })

  it('never shortens an explicit longer cache lifetime', () => {
    const eta = new URL('https://tdx.transportdata.tw/api/basic/v2/Bus/EstimatedTimeOfArrival/InterCity?$format=JSON')
    expect(tdxRealtimeCacheSeconds(eta, 120)).toBe(120)
  })

  it('keeps static and non-TDX requests untouched', () => {
    const route = new URL('https://tdx.transportdata.tw/api/basic/v2/Bus/Route/City/Taipei?$format=JSON')
    const other = new URL('https://example.com/EstimatedTimeOfArrival/City/Taipei')
    expect(tdxRealtimeCacheSeconds(route, 3600)).toBe(3600)
    expect(tdxRealtimeCacheSeconds(other, 12)).toBe(12)
  })

  it('keeps BYOK realtime freshness at the call-site value', () => {
    const eta = new URL('https://tdx.transportdata.tw/api/basic/v2/Bus/EstimatedTimeOfArrival/City/Taipei/307?$format=JSON')
    const vehicle = new URL('https://tdx.transportdata.tw/api/basic/v2/Bus/RealTimeByFrequency/City/Taipei/307?$format=JSON')
    expect(tdxRealtimeCacheSeconds(eta, 12, true)).toBe(12)
    expect(tdxRealtimeCacheSeconds(vehicle, 15, true)).toBe(15)
  })
})
