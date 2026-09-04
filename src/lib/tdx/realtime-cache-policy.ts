const TDX_ORIGIN = 'https://tdx.transportdata.tw'

// Shared credentials are quota constrained. These floors deliberately sit just
// above the product's normal polling cadence so consecutive UI polls can share
// one upstream response. BYOK keeps each call site's original freshness policy.
export const SHARED_ETA_CACHE_SECONDS = 45
export const SHARED_VEHICLE_CACHE_SECONDS = 30

export function tdxRealtimeCacheSeconds(
  url: URL,
  requestedSeconds: number,
  hasPersonalAccessToken = false,
): number {
  if (hasPersonalAccessToken || url.origin !== TDX_ORIGIN) return requestedSeconds

  if (url.pathname.includes('/EstimatedTimeOfArrival/')) {
    return Math.max(requestedSeconds, SHARED_ETA_CACHE_SECONDS)
  }
  if (url.pathname.includes('/RealTimeByFrequency/')) {
    return Math.max(requestedSeconds, SHARED_VEHICLE_CACHE_SECONDS)
  }
  return requestedSeconds
}
