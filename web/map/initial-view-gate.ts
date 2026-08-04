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

function waitForFirstTile(timeoutMs = 650): Promise<void> {
  if (document.querySelector('.leaflet-tile-loaded')) return Promise.resolve()
  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      observer.disconnect()
      window.clearTimeout(timeout)
      resolve()
    }
    const observer = new MutationObserver(() => {
      if (document.querySelector('.leaflet-tile-loaded')) finish()
    })
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] })
    const timeout = window.setTimeout(finish, timeoutMs)
  })
}

function twoFrames(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
}

/**
 * The Leaflet map is constructed at a Taiwan-wide default camera. Keep that
 * implementation detail behind a neutral canvas until URL hydration reaches
 * the requested city/place/route and the first matching tiles have painted.
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

  const reveal = async () => {
    if (revealed || revealing) return
    revealing = true
    await waitForFirstTile()
    await twoFrames()
    if (revealed) return
    revealed = true
    root.removeAttribute('data-mochi-map-booting')
    root.removeAttribute('data-mochi-map-view-settled')
    observer.disconnect()
    window.removeEventListener('popstate', check)
    window.clearTimeout(fallback)
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

  const observer = new MutationObserver(check)
  observer.observe(drawer, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-view'] })
  observer.observe(status, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class'] })
  window.addEventListener('popstate', check)
  const fallback = window.setTimeout(() => void reveal(), maxWaitMs)
  check()

  return () => {
    revealed = true
    observer.disconnect()
    window.clearTimeout(fallback)
    window.removeEventListener('popstate', check)
    root.removeAttribute('data-mochi-map-booting')
    root.removeAttribute('data-mochi-map-view-settled')
  }
}
