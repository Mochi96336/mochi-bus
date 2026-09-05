const R2_HOST_SUFFIX = '.r2.cloudflarestorage.com'
export const SNAPSHOT_R2_REQUEST_TIMEOUT_MS = 20_000

export function createR2TimeoutFetch({
  fetchImpl = globalThis.fetch,
  timeoutMs = SNAPSHOT_R2_REQUEST_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function')
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be positive')

  return function r2TimeoutFetch(input, init) {
    const url = requestUrl(input)
    if (!isCloudflareR2Url(url)) return fetchImpl(input, init)

    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    const existingSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    const signal = existingSignal
      ? AbortSignal.any([existingSignal, timeoutSignal])
      : timeoutSignal
    return fetchImpl(input, { ...init, signal })
  }
}

export function isCloudflareR2Url(value) {
  try {
    const url = value instanceof URL ? value : new URL(String(value))
    return url.protocol === 'https:' && url.hostname.endsWith(R2_HOST_SUFFIX)
  } catch {
    return false
  }
}

function requestUrl(input) {
  return input instanceof Request ? input.url : input
}
