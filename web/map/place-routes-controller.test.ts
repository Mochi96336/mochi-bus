import { describe, expect, it, vi } from 'vitest'
import type {
  NearbyPlace,
  PlaceArrivalsResponse,
  PlaceRoute,
  RouteMapVariant,
} from './map-api-client'
import {
  createPlaceRoutesController,
  placeRouteRank,
  rankPlaceRoutes,
  type PlaceRouteFailure,
  type PlaceRoutePreview,
  type PlaceRoutesPresentation,
} from './place-routes-controller'

function place(id = 'PLACE'): NearbyPlace {
  return { placeId: id, name: id, latitude: 25, longitude: 121, distanceMeters: 120 }
}

function route(
  routeName: string,
  estimateSeconds: number | null,
  routeUid = `TPE-${routeName}`,
): PlaceRoute {
  return {
    routeUid,
    routeName,
    variantKey: `${routeName}:0`,
    direction: 0,
    label: `往 ${routeName} 終點`,
    subRouteName: routeName,
    stopUid: `${routeName}-STOP`,
    stopName: `${routeName} 站`,
    stopSequence: 1,
    estimateSeconds,
    etaLabel: estimateSeconds === null ? '未發車' : `${Math.ceil(estimateSeconds / 60)} 分`,
    stopStatus: 0,
  }
}

function variant(routeName: string): RouteMapVariant {
  return {
    variantKey: `${routeName}:0`,
    routeName,
    routeUid: `TPE-${routeName}`,
    direction: 0,
    label: `往 ${routeName} 終點`,
    subRouteName: routeName,
    shape: {
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: [[121, 25], [121.1, 25.1]] },
    },
    stops: { type: 'FeatureCollection', features: [] },
    updatedAt: null,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function createHarness(options: {
  loadRoutes?: (cityCode: string, placeId: string, signal?: AbortSignal) => Promise<PlaceArrivalsResponse>
  loadVariant?: (cityCode: string, routeName: string, variantKey: string) => Promise<RouteMapVariant | undefined>
  renderPreview?: (preview: PlaceRoutePreview) => void
  favoriteRouteUids?: () => Iterable<string>
  previewLimit?: number
} = {}) {
  let cityCode: string | undefined = 'Taipei'
  let latestRequestId = 0
  let cleared = 0
  let invalidatedOtherPreviews = 0
  const starts: Array<{ cityCode: string; place: NearbyPlace }> = []
  const presentations: PlaceRoutesPresentation[] = []
  const previews: PlaceRoutePreview[] = []
  const completions: PlaceRoutesPresentation[] = []
  const failures: PlaceRouteFailure[] = []
  const loadRoutes = vi.fn(options.loadRoutes ?? (async () => ({
    routes: [route('307', 120), route('605', 60)],
  })))
  const loadVariant = vi.fn(options.loadVariant ?? (async (_city: string, routeName: string) => variant(routeName)))
  const renderPreview = options.renderPreview ?? ((preview: PlaceRoutePreview) => previews.push(preview))
  const controller = createPlaceRoutesController({
    currentCityCode: () => cityCode,
    beginRequest: () => {
      latestRequestId += 1
      return { requestId: latestRequestId, signal: new AbortController().signal }
    },
    isStaleRequest: (requestId) => requestId !== latestRequestId,
    loadRoutes,
    loadVariant,
    favoriteRouteUids: options.favoriteRouteUids ?? (() => []),
    routeColor: (routeName) => `color:${routeName}`,
    clearPreview: () => { cleared += 1 },
    invalidateOtherPreviews: () => { invalidatedOtherPreviews += 1 },
    onStart: (request) => starts.push(request),
    onRoutes: (presentation) => presentations.push(presentation),
    renderPreview,
    onComplete: (presentation) => completions.push(presentation),
    onError: (failure) => failures.push(failure),
    previewLimit: options.previewLimit,
  })

  return {
    controller,
    loadRoutes,
    loadVariant,
    starts,
    presentations,
    previews,
    completions,
    failures,
    cleared: () => cleared,
    invalidatedOtherPreviews: () => invalidatedOtherPreviews,
    setCityCode(value: string | undefined) { cityCode = value },
    invalidateRequest() { latestRequestId += 1 },
  }
}

describe('Place routes controller', () => {
  it('ranks routes by ETA with a bounded favorite-frequency preference', () => {
    const favorite = route('307', 120, 'FAVORITE')
    const fastest = route('1', 100, 'FASTEST')
    const unavailable = route('605', null, 'NONE')

    expect(placeRouteRank(favorite, new Map([['FAVORITE', 2]]))).toBe(90)
    expect(rankPlaceRoutes([unavailable, fastest, favorite], ['FAVORITE', 'FAVORITE']))
      .toEqual([favorite, fastest, unavailable])
  })

  it('loads sorted routes, bounded variants, previews, and one core completion', async () => {
    const routes = Array.from({ length: 10 }, (_, index) => route(`R${index}`, 600 - index * 10))
    const harness = createHarness({
      loadRoutes: async () => ({ routes, warning: 'tdx-rate-limit' }),
      favoriteRouteUids: () => ['TPE-R0', 'TPE-R0'],
    })

    await expect(harness.controller.open(place())).resolves.toBe(true)

    expect(harness.starts).toHaveLength(1)
    expect(harness.presentations).toHaveLength(1)
    expect(harness.presentations[0].warning).toBe('tdx-rate-limit')
    expect(harness.presentations[0].routes.map((entry) => entry.route.routeName)).toEqual([
      'R9', 'R8', 'R7', 'R6', 'R5', 'R4', 'R0', 'R3', 'R2', 'R1',
    ])
    expect(harness.loadVariant).toHaveBeenCalledTimes(8)
    expect(harness.previews.map((entry) => entry.variant.routeName)).toEqual([
      'R9', 'R8', 'R7', 'R6', 'R5', 'R4', 'R0', 'R3',
    ])
    expect(harness.completions).toEqual(harness.presentations)
    expect(harness.cleared()).toBe(1)
    expect(harness.invalidatedOtherPreviews()).toBe(1)
    expect(harness.failures).toEqual([])
  })

  it('completes the core result before auxiliary shapes resolve', async () => {
    const slow = deferred<RouteMapVariant | undefined>()
    const fast = deferred<RouteMapVariant | undefined>()
    const harness = createHarness({
      loadRoutes: async () => ({ routes: [route('SLOW', 10), route('FAST', 20)] }),
      loadVariant: async (_city, routeName) => routeName === 'SLOW' ? slow.promise : fast.promise,
    })

    const loading = harness.controller.open(place())
    await vi.waitFor(() => expect(harness.loadVariant).toHaveBeenCalledTimes(2))
    expect(harness.completions).toEqual(harness.presentations)

    fast.resolve(variant('FAST'))
    await vi.waitFor(() => expect(harness.previews.map((entry) => entry.variant.routeName)).toEqual(['FAST']))
    expect(harness.completions).toHaveLength(1)

    slow.resolve(variant('SLOW'))
    await expect(loading).resolves.toBe(true)
    expect(harness.previews.map((entry) => entry.variant.routeName)).toEqual(['FAST', 'SLOW'])
    expect(harness.completions).toHaveLength(1)
  })

  it('skips missing or failed variants without blocking completion', async () => {
    const harness = createHarness({
      loadVariant: async (_city, routeName) => {
        if (routeName === '307') throw new Error('shape unavailable')
        return routeName === '605' ? variant(routeName) : undefined
      },
    })

    await expect(harness.controller.open(place())).resolves.toBe(true)

    expect(harness.previews.map((entry) => entry.variant.routeName)).toEqual(['605'])
    expect(harness.completions).toHaveLength(1)
    expect(harness.failures).toEqual([])
  })

  it('reports renderer failures after preserving the usable core result', async () => {
    const renderError = new Error('preview renderer failed')
    const harness = createHarness({
      renderPreview: () => { throw renderError },
    })

    await expect(harness.controller.open(place())).resolves.toBe(false)

    expect(harness.presentations).toHaveLength(1)
    expect(harness.completions).toEqual(harness.presentations)
    expect(harness.failures).toEqual([{ cityCode: 'Taipei', place: place(), error: renderError }])
    expect(harness.loadRoutes).toHaveBeenCalledOnce()
  })

  it('rejects stale arrivals after cancellation or a newer place starts', async () => {
    const first = deferred<PlaceArrivalsResponse>()
    const harness = createHarness({
      loadRoutes: async (_city, placeId) => placeId === 'OLD'
        ? first.promise
        : { routes: [route('NEW', 30)] },
    })

    const oldLoad = harness.controller.open(place('OLD'))
    const newLoad = harness.controller.open(place('NEW'))
    await expect(newLoad).resolves.toBe(true)
    first.resolve({ routes: [route('OLD', 10)] })
    await expect(oldLoad).resolves.toBe(false)

    expect(harness.presentations.map((entry) => entry.place.placeId)).toEqual(['NEW'])
    expect(harness.completions.map((entry) => entry.place.placeId)).toEqual(['NEW'])
    expect(harness.previews.map((entry) => entry.variant.routeName)).toEqual(['NEW'])
  })

  it('suppresses stale previews after city change or request invalidation without undoing core completion', async () => {
    const pendingVariant = deferred<RouteMapVariant | undefined>()
    const cityChanged = createHarness({ loadVariant: () => pendingVariant.promise })
    const loading = cityChanged.controller.open(place())
    await vi.waitFor(() => expect(cityChanged.presentations).toHaveLength(1))
    expect(cityChanged.completions).toEqual(cityChanged.presentations)
    cityChanged.setCityCode('NewTaipei')
    pendingVariant.resolve(variant('307'))
    await expect(loading).resolves.toBe(false)
    expect(cityChanged.previews).toEqual([])
    expect(cityChanged.completions).toHaveLength(1)

    const staleVariant = deferred<RouteMapVariant | undefined>()
    const stale = createHarness({ loadVariant: () => staleVariant.promise })
    const staleLoad = stale.controller.open(place())
    await vi.waitFor(() => expect(stale.presentations).toHaveLength(1))
    expect(stale.completions).toEqual(stale.presentations)
    stale.invalidateRequest()
    staleVariant.resolve(variant('307'))
    await expect(staleLoad).resolves.toBe(false)
    expect(stale.previews).toEqual([])
    expect(stale.completions).toHaveLength(1)
  })

  it('reports active arrivals failures but suppresses cancelled failures', async () => {
    const routeError = new Error('route failure')
    const activeRoute = createHarness({ loadRoutes: async () => { throw routeError } })
    await expect(activeRoute.controller.open(place())).resolves.toBe(false)
    expect(activeRoute.failures).toEqual([{ cityCode: 'Taipei', place: place(), error: routeError }])

    const pending = deferred<PlaceArrivalsResponse>()
    const cancelled = createHarness({ loadRoutes: () => pending.promise })
    const cancelledLoad = cancelled.controller.open(place())
    cancelled.controller.cancel()
    pending.reject(new Error('cancelled failure'))
    await expect(cancelledLoad).resolves.toBe(false)
    expect(cancelled.failures).toEqual([])
  })

  it('does not start without an active city and rejects invalid preview limits', async () => {
    const harness = createHarness()
    harness.setCityCode(undefined)
    await expect(harness.controller.open(place())).resolves.toBe(false)
    expect(harness.loadRoutes).not.toHaveBeenCalled()

    expect(() => createHarness({ previewLimit: 0 })).toThrow('positive integer')
  })
})
