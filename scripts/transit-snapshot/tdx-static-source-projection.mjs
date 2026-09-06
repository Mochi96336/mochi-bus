const TDX_ORIGIN = 'https://tdx.transportdata.tw'
const STATIC_PATH = /^\/api\/basic\/v2\/Bus\/(Route|Stop|StopOfRoute|Shape|Schedule)\/(InterCity|City\/([A-Za-z][A-Za-z0-9_-]{0,63}))$/

export const STATIC_SOURCE_SELECT = Object.freeze({
  Route: 'RouteUID,RouteName,DepartureStopNameZh,DestinationStopNameZh',
  Stop: 'StopUID,LocationCityCode',
  StopOfRoute: 'RouteUID,SubRouteUID,SubRouteName,Direction,Stops',
  Shape: 'RouteUID,Direction,EncodedPolyline,UpdateTime',
  Schedule: 'RouteUID,SubRouteUID,Direction,Timetables,Frequencys',
})

export function tdxStaticSourceProjectionUrl(input, init = {}) {
  if (requestMethod(input, init) !== 'GET') return null
  let url
  try {
    url = new URL(requestUrl(input))
  } catch {
    return null
  }
  if (url.origin !== TDX_ORIGIN) return null
  const match = STATIC_PATH.exec(url.pathname)
  if (!match) return null
  if (url.searchParams.size !== 1 || url.searchParams.get('$format') !== 'JSON') return null

  const resource = match[1]
  // Stop is only consumed from the nationwide InterCity dataset by the snapshot
  // publisher. Do not accidentally project a future City/Stop caller under this
  // narrow, audited contract.
  if (resource === 'Stop' && match[2] !== 'InterCity') return null
  url.searchParams.set('$select', STATIC_SOURCE_SELECT[resource])
  return url
}

export function createTdxStaticSourceProjectionFetch({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function')
  return function projectedStaticSourceFetch(input, init) {
    const projected = tdxStaticSourceProjectionUrl(input, init)
    return fetchImpl(projected ?? input, init)
  }
}

function requestUrl(input) {
  if (input instanceof Request) return input.url
  return String(input)
}

function requestMethod(input, init) {
  const explicit = nonEmpty(init?.method)
  if (explicit) return explicit.toUpperCase()
  if (input instanceof Request) return input.method.toUpperCase()
  return 'GET'
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}
