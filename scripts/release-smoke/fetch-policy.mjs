const FINAL_ARRIVALS_PHASE = 'final-arrivals'
const ARRIVALS_PATH = /^\/api\/v1\/map\/place\/[^/]+\/arrivals$/
const RELEASE_IDENTITY_PATH = '/api/v1/health/release'
const RELEASE_IDENTITY_ATTEMPTS = 3
const RELEASE_IDENTITY_RETRY_DELAY_MS = 250

export function createReleaseSmokeFetch({
  fetchImpl = globalThis.fetch,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function')
  if (typeof sleep !== 'function') throw new TypeError('sleep must be a function')

  return async function releaseSmokeFetch(input, init) {
    const rewritten = finalSnapshotOnlyInput(input)
    const forwarded = rewritten ?? input
    if (!isReleaseIdentityInput(forwarded)) return fetchImpl(forwarded, init)

    for (let attempt = 1; attempt <= RELEASE_IDENTITY_ATTEMPTS; attempt += 1) {
      try {
        const response = await fetchImpl(forwarded, init)
        if (!retryableReleaseIdentityStatus(response?.status)
          || attempt === RELEASE_IDENTITY_ATTEMPTS) return response
      } catch (error) {
        if (attempt === RELEASE_IDENTITY_ATTEMPTS) throw error
      }
      await sleep(RELEASE_IDENTITY_RETRY_DELAY_MS)
    }

    throw new Error('unreachable release identity retry state')
  }
}

export async function withReleaseSmokeFetch(operation, { globalObject = globalThis } = {}) {
  if (typeof operation !== 'function') throw new TypeError('operation must be a function')
  if (!globalObject || typeof globalObject !== 'object') throw new TypeError('globalObject must be an object')

  const originalFetch = globalObject.fetch
  globalObject.fetch = createReleaseSmokeFetch({ fetchImpl: originalFetch })
  try {
    return await operation()
  } finally {
    globalObject.fetch = originalFetch
  }
}

export function finalSnapshotOnlyUrl(input) {
  let url
  try {
    url = new URL(requestUrl(input))
  } catch {
    return null
  }
  if (!ARRIVALS_PATH.test(url.pathname)) return null

  const probe = url.searchParams.get('release_smoke')
  if (typeof probe !== 'string' || !probe.endsWith(`:${FINAL_ARRIVALS_PHASE}`)) return null

  url.searchParams.set('realtime', '0')
  return url
}

function finalSnapshotOnlyInput(input) {
  const url = finalSnapshotOnlyUrl(input)
  if (!url) return null
  return input instanceof Request ? new Request(url, input) : url
}

function isReleaseIdentityInput(input) {
  let url
  try {
    url = new URL(requestUrl(input))
  } catch {
    return false
  }
  return url.pathname === RELEASE_IDENTITY_PATH
}

function retryableReleaseIdentityStatus(status) {
  return status === 408 || status === 429 || (Number.isInteger(status) && status >= 500 && status <= 599)
}

function requestUrl(input) {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  if (input instanceof Request) return input.url
  return ''
}
