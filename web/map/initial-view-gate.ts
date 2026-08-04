export type MapView = 'overview' | 'region' | 'catalogue' | 'route' | 'nearby' | 'place' | 'trip-select' | 'trip-results'

const MAP_VIEWS = new Set<MapView>([
  'overview',
  'region',
  'catalogue',
  'route',
  'nearby',
  'place',
  'trip-select',
  'trip-results',
])

export function readMapView(state: unknown): MapView | undefined {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return
  const view = (state as { mapView?: unknown }).mapView
  return typeof view === 'string' && MAP_VIEWS.has(view as MapView) ? view as MapView : undefined
}

export function mapViewFromUrl(params: URLSearchParams): MapView {
  if (params.get('region')) return 'region'
  if (!params.get('city')) return 'overview'
  if (params.has('route')) return 'route'
  if (params.has('place') || params.has('stopUid')) return 'place'
  if (params.has('lat') && params.has('lon')) return 'nearby'
  if (params.get('trip') === 'results') return 'trip-results'
  if (params.get('trip') === 'select') return 'trip-select'
  return 'catalogue'
}

export function mapGateTargetChanged(expected: MapView, params: URLSearchParams): boolean {
  return mapViewFromUrl(params) !== expected
}

const STYLE_ID = 'mochi-map-initial-view-gate'
const LOADING_WORDS = ['正在', '載入中']

export function drawerKeyMatchesMapView(view: MapView, key: string): boolean {
  if (!key) return false
  switch (view) {
    case 'overview': return key === 'overview'
    case 'region': return key.startsWith('region:')
    case 'catalogue': return key.startsWith('catalogue:')
    case 'route': return key.startsWith('route:')
    case 'nearby': return key.startsWith('nearby:')
    case 'place': return key.startsWith('place:')
    case 'trip-select': return key.startsWith('trip-select') || key.startsWith('trip:')
    case 'trip-results': return key.startsWith('trip-results') || key.startsWith('trip:results')
  }
}

export function initialMapViewIsSettled(options: {
  expected: MapView
  historyState: unknown
  drawerKey: string
  statusText: string
}): boolean {
  if (readMapView(options.historyState) !== options.expected) return false
  if (!drawerKeyMatchesMapView(options.expected, options.drawerKey)) return false
  return !LOADING_WORDS.some((word) => options.statusText.includes(word))
}

function installGateStyle(): void {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
html[data-mochi-map-booting="true"] .leaflet-tile-pane,
html[data-mochi-map-booting="true"] .leaflet-overlay-pane,
html[data-mochi-map-booting="true"] .leaflet-shadow-pane,
html[data-mochi-map-booting="true"] .leaflet-marker-pane,
html[data-mochi-map-booting="true"] .leaflet-tooltip-pane,
html[data-mochi-map-booting="true"] .leaflet-popup-pane {
  opacity: 0;
}
html[data-mochi-map-booting="true"] #map-app::before {
  position: fixed;
  inset: 0;
  z-index: 1;
  background:
    radial-gradient(circle at 50% 44%, var(--paper) 0 13%, transparent 34%),
    var(--canvas);
  content: "";
  pointer-events: none;
}
.leaflet-tile-pane,
.leaflet-overlay-pane,
.leaflet-shadow-pane,
.leaflet-marker-pane,
.leaflet-tooltip-pane,
.leaflet-popup-pane,
.leaflet-control-container {
  transition: opacity var(--motion-fast, 180ms) ease;
}
@media (prefers-reduced-motion: reduce) {
  .leaflet-tile-pane,
  .leaflet-overlay-pane,
  .leaflet-shadow-pane,
  .leaflet-marker-pane,
  .leaflet-tooltip-pane,
  .leaflet-popup-pane,
  .leaflet-control-container { transition: none; }
}
`
  document.head.appendChild(style)
}

export type TileBatchState = {
  loaded: number
  pending: number
}

export function tileBatchIsReady(state: TileBatchState): boolean {
  return state.loaded > 0 && state.pending === 0
}

function activeTileContainer(): Element | null {
  const pane = document.querySelector('.leaflet-tile-pane')
  if (!pane) return null
  const containers = Array.from(pane.querySelectorAll<HTMLElement>(':scope > .leaflet-tile-container'))
  if (!containers.length) return pane
  return containers.reduce((active, candidate) => {
    const activeZ = Number.parseInt(active.style.zIndex || '0', 10) || 0
    const candidateZ = Number.parseInt(candidate.style.zIndex || '0', 10) || 0
    return candidateZ >= activeZ ? candidate : active
  })
}

function currentTileBatch(): TileBatchState {
  const container = activeTileContainer()
  if (!container) return { loaded: 0, pending: 0 }
  const tiles = Array.from(container.querySelectorAll('.leaflet-tile'))
  const loaded = tiles.filter((tile) => tile.classList.contains('leaflet-tile-loaded')).length
  return { loaded, pending: tiles.length - loaded }
}

/**
 * Drawer hydration can finish while Leaflet still keeps the Taiwan tile level
 * in the DOM. Wait for the currently active (highest-z) tile level to complete,
 * then require two stable frames before exposing it.
 */
function waitForTargetTileBatch(timeoutMs = 900): Promise<void> {
  return new Promise((resolve) => {
    let done = false
    let observer: MutationObserver | undefined
    let timeout: number | undefined
    let settleFrame: number | undefined

    const finish = () => {
      if (done) return
      done = true
      observer?.disconnect()
      if (timeout !== undefined) window.clearTimeout(timeout)
      if (settleFrame !== undefined) window.cancelAnimationFrame(settleFrame)
      resolve()
    }

    const check = () => {
      const batch = currentTileBatch()
      if (!tileBatchIsReady(batch)) return
      if (settleFrame !== undefined) window.cancelAnimationFrame(settleFrame)
      settleFrame = window.requestAnimationFrame(() => {
        settleFrame = window.requestAnimationFrame(() => {
          const stable = currentTileBatch()
          if (tileBatchIsReady(stable) && stable.loaded >= batch.loaded) finish()
        })
      })
    }

    const pane = document.querySelector('.leaflet-tile-pane')
    if (pane) {
      observer = new MutationObserver(check)
      observer.observe(pane, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'src', 'style'],
      })
    }
    timeout = window.setTimeout(finish, timeoutMs)
    window.requestAnimationFrame(() => window.requestAnimationFrame(check))
  })
}

function twoFrames(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
}

/**
 * The Leaflet map is constructed at a Taiwan-wide default camera. Keep that
 * implementation detail behind a neutral canvas until URL hydration reaches
 * the requested city/place/route and the active tile batch has painted.
 */
export function installInitialMapViewGate(maxWaitMs = 5_000): () => void {
  installGateStyle()
  const root = document.documentElement
  const drawer = document.getElementById('map-drawer')
  const status = document.getElementById('map-status')
  if (!drawer || !status) return () => {}

  const expected = mapViewFromUrl(new URLSearchParams(location.search))
  if (expected === 'overview') return () => {}
  root.dataset.mochiMapBooting = 'true'
  let revealed = false
  let revealing = false
  let fallback: number | undefined

  const finishReveal = () => {
    if (revealed) return
    revealed = true
    root.removeAttribute('data-mochi-map-booting')
    root.removeAttribute('data-mochi-map-view-settled')
    observer.disconnect()
    window.removeEventListener('popstate', onPopState)
    if (fallback !== undefined) window.clearTimeout(fallback)
  }

  const reveal = async () => {
    if (revealed || revealing) return
    revealing = true
    await waitForTargetTileBatch()
    await twoFrames()
    finishReveal()
  }

  const check = () => {
    if (!initialMapViewIsSettled({
      expected,
      historyState: history.state,
      drawerKey: drawer.dataset.view ?? '',
      statusText: status.textContent?.trim() ?? '',
    })) return
    root.dataset.mochiMapViewSettled = 'true'
    void reveal()
  }

  // The gate belongs only to the URL that created this document. If Back or
  // Forward moves to another map target while hydration is still pending, drop
  // the old gate immediately instead of covering the new target until fallback.
  const onPopState = () => {
    if (mapGateTargetChanged(expected, new URLSearchParams(location.search))) {
      finishReveal()
      return
    }
    check()
  }

  const observer = new MutationObserver(check)
  observer.observe(drawer, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-view'] })
  observer.observe(status, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class'] })
  window.addEventListener('popstate', onPopState)
  fallback = window.setTimeout(finishReveal, maxWaitMs)
  check()

  return () => {
    finishReveal()
  }
}
