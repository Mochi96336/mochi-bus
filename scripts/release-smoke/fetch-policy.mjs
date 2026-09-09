const FINAL_ARRIVALS_PHASE = 'final-arrivals'
const ARRIVALS_PATH = /^\/api\/v1\/map\/place\/[^/]+\/arrivals$/

export function createReleaseSmokeFetch({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function')

  return function releaseSmokeFetch(input, init) {
    const rewritten = finalSnapshotOnlyInput(input)
    return fetchImpl(rewritten ?? input, init)
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

function requestUrl(input) {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  if (input instanceof Request) return input.url
  return ''
}
