import {
  readNearbyAutoPreviewOrigin,
  withoutNearbyAutoPreviewOrigin,
  type NearbyAutoPreviewOrigin,
} from './nearby-auto-preview-history'

export type MapView = 'overview' | 'region' | 'catalogue' | 'route' | 'nearby' | 'place' | 'trip-select' | 'trip-results'

const mapViews = new Set<MapView>([
  'overview',
  'region',
  'catalogue',
  'route',
  'nearby',
  'place',
  'trip-select',
  'trip-results',
])

const mapDetailViews = new Set<MapView>(['route', 'nearby', 'place'])
const MAP_DETAIL_TRAIL_KEY = 'mapDetailTrail'
const MAP_DETAIL_TRAIL_LIMIT = 8
const MAP_HISTORY_COMPRESSION_FLAG = '__mochiMapHistoryCompressionInstalled__'

type MapDetailView = 'route' | 'nearby' | 'place'

type MapDetailTrailEntry = {
  view: MapDetailView
  url: string
  state: Record<string, unknown>
}

export type MapHistoryCity = {
  code: string
  region: string
}

export type MapHistoryMutation = {
  mode: 'replace' | 'push'
  state: { mapView: MapView; mapParent?: MapView }
  url: string
}

export type MapHistoryPushPlan = {
  mode: 'replace' | 'push'
  state: unknown
}

export type MapHistoryBackPlan = {
  state: Record<string, unknown>
  url: string
}

export function historyRecord(state: unknown = history.state): Record<string, unknown> {
  return state && typeof state === 'object' && !Array.isArray(state)
    ? state as Record<string, unknown>
    : {}
}

export function readMapView(state: unknown): MapView | undefined {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return
  const view = (state as { mapView?: unknown }).mapView
  return typeof view === 'string' && mapViews.has(view as MapView) ? view as MapView : undefined
}

export function mapViewFromUrl(params = new URLSearchParams(location.search)): MapView {
  if (params.get('region')) return 'region'
  if (!params.get('city')) return 'overview'
  if (params.has('route')) return 'route'
  if (params.has('place') || params.has('stopUid')) return 'place'
  if (params.has('lat') && params.has('lon')) return 'nearby'
  if (params.get('trip') === 'results') return 'trip-results'
  if (params.get('trip') === 'select') return 'trip-select'
  return 'catalogue'
}

export function canonicalMapHistoryState(
  currentState: unknown,
  params: URLSearchParams,
): { view: MapView; state: Record<string, unknown>; changed: boolean } {
  const view = mapViewFromUrl(params)
  const current = historyRecord(currentState)
  const parent = parentForView(view, current.mapParent)
  const changed = readMapView(current) !== view || current.mapParent !== parent
  const next: Record<string, unknown> = { ...current, mapView: view }
  if (parent) next.mapParent = parent
  else delete next.mapParent
  return { view, state: next, changed }
}

// route / nearby / place 是同一個「探索詳情槽」。槽內切換只 replace，瀏覽器 Back
// 直接回到路線目錄；抽屜自己的返回則由有限 trail 還原，不污染 browser history。
export function planMapHistoryPush(
  currentState: unknown,
  currentUrl: string,
  nextState: unknown,
): MapHistoryPushPlan {
  const currentView = readMapView(currentState)
  const nextView = readMapView(nextState)
  if (!nextView) return { mode: 'push', state: nextState }

  const next = historyRecord(nextState)
  const autoPreview = planNearbyAutoPreviewPlacePush(
    currentState,
    currentUrl,
    next,
    currentView,
    nextView,
  )
  if (autoPreview) return autoPreview

  if (!isMapDetailView(nextView)) {
    return { mode: 'push', state: withoutMapTransientState(next) }
  }
  if (!currentView || !isMapDetailView(currentView)) {
    return { mode: 'push', state: withoutMapTransientState(next) }
  }

  const existingTrail = readMapDetailTrail(currentState)
  const trail = currentView === nextView
    ? existingTrail
    : appendMapDetailTrail(existingTrail, {
      view: currentView,
      url: currentUrl,
      state: withoutMapTransientState(historyRecord(currentState)),
    })

  return {
    mode: 'replace',
    state: withMapDetailTrail(next, trail),
  }
}

export function planMapHistoryBack(currentState: unknown): MapHistoryBackPlan | undefined {
  const currentView = readMapView(currentState)
  if (!currentView || !isMapDetailView(currentView)) return
  const trail = readMapDetailTrail(currentState)
  const previous = trail.at(-1)
  if (!previous) return
  return {
    state: withMapDetailTrail(previous.state, trail.slice(0, -1)),
    url: previous.url,
  }
}

export function planInitialMapHistory(options: {
  state: unknown
  params: URLSearchParams
  cities: readonly MapHistoryCity[]
  validRegions: ReadonlySet<string>
  originalUrl: string
}): MapHistoryMutation[] {
  if (readMapView(options.state)) return []

  const mutations: MapHistoryMutation[] = [
    { mode: 'replace', state: { mapView: 'overview' }, url: '/map' },
  ]
  const regionCode = options.params.get('region')
  if (regionCode && options.validRegions.has(regionCode)) {
    mutations.push({
      mode: 'push',
      state: { mapView: 'region', mapParent: 'overview' },
      url: options.originalUrl,
    })
    return mutations
  }

  const cityCode = options.params.get('city')
  if (!cityCode) return mutations
  const city = options.cities.find((candidate) => candidate.code === cityCode)
  if (!city) return mutations

  mutations.push(
    {
      mode: 'push',
      state: { mapView: 'region', mapParent: 'overview' },
      url: `/map?region=${city.region}`,
    },
    {
      mode: 'push',
      state: { mapView: 'catalogue', mapParent: 'region' },
      url: `/map?city=${encodeURIComponent(city.code)}`,
    },
  )

  const detailView = mapViewFromUrl(options.params)
  if (detailView !== 'catalogue') {
    mutations.push({
      mode: 'push',
      state: { mapView: detailView, mapParent: 'catalogue' },
      url: options.originalUrl,
    })
  }
  return mutations
}

function isMapDetailView(view: MapView): view is MapDetailView {
  return mapDetailViews.has(view)
}

function planNearbyAutoPreviewPlacePush(
  currentState: unknown,
  currentUrl: string,
  next: Record<string, unknown>,
  currentView: MapView | undefined,
  nextView: MapView,
): MapHistoryPushPlan | undefined {
  const origin = readNearbyAutoPreviewOrigin(currentState)
  // Route-stop auto-preview intentionally returns straight to the route. Only map-origin
  // auto-preview needs a hidden Nearby step between the current surface and the place.
  if (!origin || nextView !== 'place' || currentView === 'route') return

  const current = historyRecord(currentState)
  const existingTrail = readMapDetailTrail(currentState)
  const currentParent = readMapView({ mapView: current.mapParent })
  const previousNearby = [...existingTrail].reverse().find((entry) => entry.view === 'nearby')
  const previousNearbyParent = readMapView({ mapView: previousNearby?.state.mapParent })
  const nearbyParent = nearbyParentForAutoPreview(currentView, currentParent, previousNearbyParent)

  // Selecting a new map point from an auto-previewed place replaces the previous Nearby
  // waypoint instead of nesting old searches indefinitely.
  const replacesPreviousNearby = currentView === 'place'
    && currentParent === 'nearby'
    && existingTrail.at(-1)?.view === 'nearby'
  const baseTrail = replacesPreviousNearby ? existingTrail.slice(0, -1) : existingTrail
  const nearbyState = withoutMapTransientState({
    ...current,
    mapView: 'nearby',
    mapParent: nearbyParent,
  })
  const trail = appendMapDetailTrail(baseTrail, {
    view: 'nearby',
    url: nearbyAutoPreviewUrl(currentUrl, origin),
    state: nearbyState,
  })

  return {
    mode: currentView && isMapDetailView(currentView) ? 'replace' : 'push',
    state: withMapDetailTrail({
      ...next,
      mapView: 'place',
      mapParent: 'nearby',
    }, trail),
  }
}

function nearbyParentForAutoPreview(
  currentView: MapView | undefined,
  currentParent: MapView | undefined,
  previousNearbyParent: MapView | undefined,
): MapView {
  if (currentView === 'place') {
    if (currentParent === 'nearby') return previousNearbyParent ?? 'catalogue'
    if (currentParent && currentParent !== 'overview' && currentParent !== 'region' && currentParent !== 'place') {
      return currentParent
    }
    return 'catalogue'
  }
  if (currentView === 'nearby') return currentParent ?? 'catalogue'
  if (!currentView || currentView === 'overview' || currentView === 'region') return 'catalogue'
  return currentView
}

function nearbyAutoPreviewUrl(currentUrl: string, origin: NearbyAutoPreviewOrigin): string {
  const source = new URL(currentUrl, 'https://mochi.invalid')
  const params = new URLSearchParams()
  const city = source.searchParams.get('city')
  if (city) params.set('city', city)
  params.set('lat', origin[0].toFixed(5))
  params.set('lon', origin[1].toFixed(5))
  return `/map?${params}`
}

function withoutMapDetailTrail(state: Record<string, unknown>): Record<string, unknown> {
  const next = { ...state }
  delete next[MAP_DETAIL_TRAIL_KEY]
  return next
}

function withoutMapTransientState(state: Record<string, unknown>): Record<string, unknown> {
  return withoutNearbyAutoPreviewOrigin(withoutMapDetailTrail(state))
}

function withMapDetailTrail(
  state: Record<string, unknown>,
  trail: readonly MapDetailTrailEntry[],
): Record<string, unknown> {
  const next = withoutMapTransientState(state)
  if (trail.length) next[MAP_DETAIL_TRAIL_KEY] = trail
  return next
}

function appendMapDetailTrail(
  trail: readonly MapDetailTrailEntry[],
  entry: MapDetailTrailEntry,
): MapDetailTrailEntry[] {
  const last = trail.at(-1)
  const appended = last?.url === entry.url ? [...trail] : [...trail, entry]
  return appended.slice(-MAP_DETAIL_TRAIL_LIMIT)
}

function readMapDetailTrail(state: unknown): MapDetailTrailEntry[] {
  const value = historyRecord(state)[MAP_DETAIL_TRAIL_KEY]
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is MapDetailTrailEntry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
    const candidate = entry as Partial<MapDetailTrailEntry>
    return typeof candidate.url === 'string'
      && Boolean(candidate.view && isMapDetailView(candidate.view))
      && readMapView(candidate.state) === candidate.view
  }).slice(-MAP_DETAIL_TRAIL_LIMIT)
}

function parentForView(view: MapView, currentParent: unknown): MapView | undefined {
  // The overview → region → catalogue spine is fixed. Detail views may preserve
  // a meaningful dynamic parent (for example route → trip results), but never a
  // root-level parent or a self-cycle that would make Back navigation ambiguous.
  if (view === 'overview') return undefined
  if (view === 'region') return 'overview'
  if (view === 'catalogue') return 'region'

  const parent = readMapView({ mapView: currentParent })
  if (!parent || parent === 'overview' || parent === 'region' || parent === view) return 'catalogue'
  return parent
}

function installMapHistoryCompression() {
  if (typeof history === 'undefined' || typeof location === 'undefined' || typeof window === 'undefined') return
  const managedHistory = history as History & { [MAP_HISTORY_COMPRESSION_FLAG]?: boolean }
  if (managedHistory[MAP_HISTORY_COMPRESSION_FLAG]) return

  const nativePushState = history.pushState.bind(history)
  const nativeReplaceState = history.replaceState.bind(history)
  const nativeBack = history.back.bind(history)

  Object.defineProperty(managedHistory, MAP_HISTORY_COMPRESSION_FLAG, { value: true })
  managedHistory.pushState = (data: unknown, unused: string, url?: string | URL | null) => {
    const currentUrl = `${location.pathname}${location.search}${location.hash}`
    const plan = planMapHistoryPush(history.state, currentUrl, data)
    if (plan.mode === 'replace') nativeReplaceState(plan.state, unused, url)
    else nativePushState(plan.state, unused, url)
  }
  managedHistory.replaceState = (data: unknown, unused: string, url?: string | URL | null) => {
    const nextView = readMapView(data)
    // Non-detail replacements clear the compressed trail, but keep a just-recorded
    // auto-preview origin until the immediately following place push consumes it.
    const nextState = nextView && !isMapDetailView(nextView)
      ? withoutMapDetailTrail(historyRecord(data))
      : data
    nativeReplaceState(nextState, unused, url)
  }
  managedHistory.back = () => {
    const plan = planMapHistoryBack(history.state)
    if (!plan) {
      nativeBack()
      return
    }
    nativeReplaceState(plan.state, '', plan.url)
    queueMicrotask(() => window.dispatchEvent(new PopStateEvent('popstate', { state: plan.state })))
  }
}

installMapHistoryCompression()
