import L from 'leaflet'
import type { TripSelectionKind } from '../../src/domain/map/trip-selection'
import { createTripRuntimeStore } from './trip-runtime-store'
import { createTripController, type TripPlanContext, type TripResultsPresentation } from './trip-controller'
import { createTripPlanLoader, type TripPlanLoadPhase } from './trip-plan-loader'
import { createTripResultsSnapshot, parseTripResultsSnapshot } from './trip-results-snapshot'
import { createTripResultsView } from './trip-results-view'
import { createJourneyPreviewController } from './journey-preview-controller'
import { createJourneyPreviewMap } from './journey-preview-map'
import {
  createPlaceRoutesController,
  type PlaceRoutePreview,
  type PlaceRoutesPresentation,
} from './place-routes-controller'
import { createPlaceRoutesView } from './place-routes-view'
import { createNearbyPlacesController, type NearbyPreviewSource } from './nearby-places-controller'
import { createNearbyPlacesMap } from './nearby-places-map'
import { createNearbyResultsState } from './nearby-results-state'
import { createNearbyPlacesView, nearbyPlacesFailureMessage } from './nearby-places-view'
import { createLoadingHandoff } from '../lib/loading-gate'
import { createPreviewStopDotManager, createSelectablePreviewLineRenderer } from './preview-map-primitives'
import { createNavRequestCoordinator } from '../../src/domain/map/nav-request'
import { captureMapCamera, restoreMapCamera, type MapCameraState } from '../../src/domain/map/journey-camera'
import {
  isHomeDirection,
  readBoards,
  setActiveCity,
  toggleHomeDirection,
  type FavoriteBus,
} from '../boards/store'
import { tdxWarningMessages } from '../../src/domain/tdx-warning'
import { isTdxTokenRejectedError } from '../tdx/api-client'
import { splitRouteDisplayName } from '../lib/route-display'
import { createMapCameraController } from './camera-controller'
import { createDrawerRenderer, type DrawerView } from './drawer-view'
import { createMapStatus } from './map-status'
import {
  buttonGrid,
  degradedNotice,
  drawerBack,
  heading,
  paragraph,
  retryButton,
} from './drawer-primitives'
import { createMapFeatureDiscovery, type MapFeature } from './feature-discovery'
import { createCityNetworkController } from './city-network-controller'
import { createRouteDetailController } from './route-detail-controller'
import { createRouteDetailSurface } from './route-detail-surface'
import { bindTextTooltip } from './leaflet-tooltip'
import {
  canonicalMapHistoryState,
  historyRecord,
  mapViewFromUrl,
  planInitialMapHistory,
  readMapView,
} from './history-state'
import { createTimetableSummaryController } from './timetable-summary-controller'
import { createVehicleRefreshController } from './vehicle-refresh-controller'
import { routePalette, stopFillAccent, stopFillGreen, stopHaloColor } from './theme'
import {
  mapApi,
  type MapCity,
  type NearbyPlace,
  type PlaceRoute,
  type RegionCode,
  type RouteItem,
  type RouteMapVariant,
  type RouteTimetableResponse,
  type SearchPlace,
  type VehiclePositionsResponse,
} from './map-api-client'
import { renderTimetableSummary, timetableSummaryText } from './timetable-view'
import {
  createPlaceSearchBox,
  createPlaceSearchResultButton,
  createReselectTripEndpointButton,
  createTripCandidateList,
  createTripEndpointSummary,
} from './trip-selection-view'
import 'leaflet/dist/leaflet.css'
import './style.css'
const regions: Array<{
  code: RegionCode
  name: string
  center: [number, number]
  maxZoom: number
}> = [
  { code: 'north', name: '北部', center: [24.98, 121.25], maxZoom: 8 },
  { code: 'central', name: '中部', center: [23.95, 120.62], maxZoom: 8 },
  { code: 'south', name: '南部', center: [22.95, 120.35], maxZoom: 8 },
  { code: 'east', name: '東部', center: [23.65, 121.35], maxZoom: 8 },
  { code: 'islands', name: '離島', center: [24.1, 119.25], maxZoom: 7 },
]

const TAIWAN_OVERVIEW_BOUNDS: L.LatLngBoundsExpression = [
  [21.75, 119.85],
  [25.45, 122.05],
]
const desktopMapLayout = window.matchMedia('(min-width: 641px)')

function overviewMaxZoom(baseZoom: number): number {
  // 桌機抽屜在側邊，不會吃掉地圖高度；四分之三級能善用多出的工作區，
  // 手機底部抽屜仍維持原本的地理尺度。
  return baseZoom + (desktopMapLayout.matches ? .75 : 0)
}

const mapNode = requiredElement('map')
const drawer = requiredElement('map-drawer')
const drawerRenderer = createDrawerRenderer(drawer)
const renderDrawer = (view: DrawerView) => drawerRenderer.render(view)
const statusNode = requiredElement('map-status')
const mapStatus = createMapStatus(statusNode, requiredElement('map-announcer'))
const mapFeatureDiscovery = createMapFeatureDiscovery(browserStorage())
const networkButton = document.createElement('button')
networkButton.className = 'network-toggle map-feature-button'
networkButton.type = 'button'
networkButton.title = '顯示全路網與全部站點'
networkButton.setAttribute('aria-label', '切換全路網與全部站點')
decorateMapFeatureButton(networkButton, 'network', '▦', '路網')
networkButton.hidden = true
document.getElementById('map-app')?.appendChild(networkButton)

// 觸控裝置沒有 hover、手指也比游標粗得多,才需要放大命中範圍;
// 滑鼠本身夠精準,放大命中範圍反而讓 hover 判定跟不上游標移動(看起來卡住不會變回原狀)。
const hoverCapable = window.matchMedia('(hover: hover)').matches

window.addEventListener('popstate', () => void hydrateMapLocation())

// 互動圖層一律用 SVG:canvas 會以整張地圖大小攔截點擊,
// 疊在上層的 pane 會擋住下層線條的 click(候選路線點不到、誤觸地圖點擊)。
const map = L.map(mapNode, {
  zoomControl: false,
  minZoom: 6,
  maxZoom: 19,
  zoomSnap: .25,
  zoomDelta: .5,
}).setView([23.75, 120.9], overviewMaxZoom(7))
const camera = createMapCameraController(map, mapNode, drawer)

map.createPane('routePreviewPane').style.zIndex = '420'
// 預覽小站點獨立一層:同 pane 內只看插入順序,多條建議路線輪流蓋掉
// 彼此的小點;墊在預覽線之上、選定路線與互動圓點之下才穩。
map.createPane('previewDotPane').style.zIndex = '425'
map.createPane('routePane').style.zIndex = '440'
map.createPane('stopPane').style.zIndex = '480'
map.createPane('networkPane').style.zIndex = '410'
// hover 高亮線疊在全路網淡線之上、預覽線之下;獨立 pane 讓它拿到自己的
// renderer(SVG),重繪高亮不會連帶重畫整張全路網 canvas。
map.createPane('networkHoverPane').style.zIndex = '415'
map.createPane('vehiclePane').style.zIndex = '520'

// 全路網一次畫數百條線與站點,效能上仍用 canvas;
// networkPane 在所有互動 pane 之下,canvas 攔截不會影響其他圖層。
// 整層 non-interactive:Leaflet canvas 對每次 mousemove 逐一 hit-test
// 上百條線會讓桌機 hover 卡死,命中改由 network-pick 的網格索引回答。
const networkRenderer = L.canvas({ pane: 'networkPane' })

L.control.zoom({ position: 'bottomleft' }).addTo(map)
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map)

const selectionLayer = L.layerGroup().addTo(map)
const routeLayer = L.layerGroup().addTo(map)
const previewLayer = L.layerGroup().addTo(map)
const selectablePreviewLine = createSelectablePreviewLineRenderer({ hoverCapable })
const previewStopDots = createPreviewStopDotManager({ map })
const journeyPreviewMap = createJourneyPreviewMap({ map, layer: previewLayer, hoverCapable })
const nearbyLayer = L.layerGroup().addTo(map)
const nearbyPlacesMap = createNearbyPlacesMap({
  layer: nearbyLayer,
  hoverCapable,
  createStopMarker: unifiedStopMarker,
  onOpenPlace: openNearbyPlace,
})
const nearbyResults = createNearbyResultsState({ renderPlaces: nearbyPlacesMap.renderPlaces, renderEndpoints: drawTripEndpoints })
const networkLayer = L.layerGroup().addTo(map)
const vehicleLayer = L.layerGroup().addTo(map)
let cities: MapCity[] = readBootstrapCities()
let activeCity: MapCity | undefined
let routes: RouteItem[] = []
// routes 屬於哪個縣市:深連結直接進路線不會經過 chooseCity,目錄是空的
let routesCityCode: string | undefined
let category = '全部'
let routeSearchQuery = ''
let routeScrollTop = 0
const trip = createTripRuntimeStore()
const tripPlanLoader = createTripPlanLoader({
  loadDirect: mapApi.direct,
  loadTransfer: mapApi.transfer,
  loadJourneyEta: mapApi.journeyEta,
  isCredentialRejectedError: isTdxTokenRejectedError,
})
let interactionMode: 'browse' | 'nearby' | 'trip' | 'trip-results' | 'route' = 'browse'
// 行程候選離開前的鏡頭只存可序列化值;路線 detail 的 fit 不應覆蓋它。
let tripResultsCamera: MapCameraState | undefined
let tripResultsCameraCity: string | undefined
// 城市/路線/路網/附近站牌/地點/行程結果是互斥的 drawer 主視圖,各自的
// fetch 都可能被使用者的下一個動作超車;用共用 coordinator 讓「慢的舊回應」
// 安靜作廢,不覆蓋 store、DOM、URL,也不彈錯誤(詳見 nav-request.ts)。
const navRequests = createNavRequestCoordinator()
function beginNavRequest(): { requestId: number; signal: AbortSignal } {
  return navRequests.begin()
}
function cancelNavRequest(): void {
  navRequests.cancel()
}
function isStaleNav(requestId: number): boolean {
  return navRequests.isStale(requestId)
}

const tripController = createTripController({
  store: trip,
  planLoader: tripPlanLoader,
  currentCityCode: () => activeCity?.code,
  nearbyRadius: () => map.getZoom() >= 15 ? 300 : 500,
  loadNearby: mapApi.nearby,
  beginRequest: beginNavRequest,
  cancelRequest: cancelNavRequest,
  isStaleRequest: isStaleNav,
  onSelectionStep: showTripSelectionStep,
  onCandidates: renderPendingTripCandidates,
  onEndpointReady: prepareTripPlan,
  onStatus: setStatus,
  onPlanStart: () => clearTripResultsCamera(),
  onPlanPhase: renderTripPlanPhase,
  onResults: presentTripResults,
  onPlanError: renderTripPlanError,
})
const tripResultsView = createTripResultsView({
  renderDrawer,
  createBackButton: drawerBack,
  createHeading: heading,
  createDegradedNotice: degradedNotice,
  createTripModeButton: tripModeButton,
  createMatchedControls: tripMatchedControls,
  routeColor,
  transferLegColors,
  onResumeDestination: () => tripController.resume('to'),
  onRetry: () => void tripController.loadPlan(),
  onSelectDirect: (index) => void tripController.selectDirect(index),
  onSelectTransfer: (index) => void tripController.selectTransfer(index),
  onOpenRoute: openTripRoute,
})
let cancelPlaceRoutes = () => {}
const journeyPreview = createJourneyPreviewController({
  currentCityCode: () => activeCity?.code,
  loadVariant: mapApi.routeVariant,
  clearPreview: () => {
    previewLayer.clearLayers()
    journeyPreviewMap.reset()
    previewStopDots.reset()
  },
  invalidateOtherPreviews: () => cancelPlaceRoutes(),
  routeColor,
  transferLegColors,
  renderLeg: journeyPreviewMap.renderLeg,
  focusCoordinates: (coordinates) => {
    const bounds = L.latLngBounds(coordinates)
    if (bounds.isValid()) camera.focusBounds(bounds, { maxZoom: 16 })
  },
  onSelectDirect: (index) => void tripController.selectDirect(index),
  onOpenRoute: openTripRoute,
})
const placeRoutesView = createPlaceRoutesView({
  renderDrawer,
  createBackButton: drawerBack,
  createHeading: heading,
  createDegradedNotice: degradedNotice,
  backLabel: placeBackLabel,
  onBack: returnToNearbyPlaces,
  onRetry: (place) => void placeRoutes.open(place),
  onOpenRoute: openChildRoute,
  createFavoriteControl: directionFavoriteControl,
  isCredentialRecovery: isTdxTokenRejectedError,
})
const nearbyPlacesView = createNearbyPlacesView({
  renderDrawer,
  createBackButton: drawerBack,
  createHeading: heading,
  createRetryButton: retryButton,
  createTripModeButton: tripModeButton,
  onOpenPlace: (place) => void openNearbyPlace(place),
})
// Skeleton 的時機交給 gate,但 origin marker 與狀態列一律立即出現:延遲窗內畫面
// 必須已經有「收到了」的證據。自動預覽不停在清單上,那條路徑沒有 skeleton,直接 abort。
const nearbyLoading = createLoadingHandoff(nearbyPlacesView.renderLoading)
const nearbyPlaces = createNearbyPlacesController({
  currentCityCode: () => activeCity?.code,
  beginRequest: beginNavRequest,
  isStaleRequest: isStaleNav,
  loadNearby: mapApi.nearby,
  onStart: ({ cityCode, origin, previewSource }) => {
    if (previewSource) nearbyLoading.abort()
    else {
      nearbyLoading.start({ cityCode, origin, backLabel: '附近站牌', onBack: renderNearbyPlaces })
      nearbyResults.setOrigin(origin)
    }
    nearbyPlacesMap.renderLoadingOrigin(origin)
    setStatus('正在找這附近的站牌…')
  },
  onPlaces: (presentation) => nearbyLoading.settle(() => {
    if (presentation.previewSource) enterNearbyView(presentation.origin[0], presentation.origin[1])
    nearbyResults.store(presentation)
    renderNearbyPlaces()
  }),
  onAutoPreview: async (place, presentation) => {
    nearbyResults.storeAndRenderMap(presentation)
    if (presentation.previewSource === 'map') {
      enterNearbyView(presentation.origin[0], presentation.origin[1])
    }
    await openAutoPreviewPlace(place)
  },
  onError: ({ cityCode, origin, previewSource, error }) => {
    if (previewSource) {
      nearbyLoading.abort()
      setStatus(nearbyPlacesFailureMessage(error), true)
      return
    }
    nearbyLoading.settle(() => setStatus(nearbyPlacesView.renderError({
      cityCode, origin, error, backLabel: '附近站牌', onBack: renderNearbyPlaces,
      onRetry: () => findNearbyPlaces(origin[0], origin[1], previewSource, 'replace'),
    }), true))
  },
})
const placeRoutesLoading = createLoadingHandoff(placeRoutesView.renderLoading)
const placeRoutes = createPlaceRoutesController({
  currentCityCode: () => activeCity?.code,
  beginRequest: beginNavRequest,
  isStaleRequest: isStaleNav,
  loadRoutes: mapApi.placeRoutes,
  loadVariant: mapApi.routeVariant,
  favoriteRouteUids: () => readBoards().flatMap((board) => board.buses)
    .map((bus) => typeof bus.routeUid === 'string' ? bus.routeUid : ''),
  routeColor,
  clearPreview: () => {
    previewLayer.clearLayers()
    journeyPreviewMap.reset()
    previewStopDots.reset()
  },
  invalidateOtherPreviews: () => journeyPreview.cancel(),
  onStart: (start) => {
    routeDetail.close()
    placeRoutesLoading.start(start)
    setStatus(`正在讀取 ${start.place.name} 的路線…`)
  },
  onRoutes: (presentation) => placeRoutesLoading.settle(() => placeRoutesView.renderRoutes(presentation)),
  renderPreview: renderPlaceRoutePreview,
  onComplete: completePlaceRoutes,
  onError: (failure) => placeRoutesLoading.settle(() => mapStatus.show(placeRoutesView.renderError(failure), true)),
})
// Gate 的計時器要跟著這一輪請求一起作廢,否則尾端 render 會落在已經換掉的畫面上。
cancelPlaceRoutes = () => { placeRoutesLoading.abort(); placeRoutes.cancel() }

function invalidatePreviewRequests(): void {
  journeyPreview.cancel()
  cancelPlaceRoutes()
}

function clearPreviewLayer(): void {
  invalidatePreviewRequests()
  previewLayer.clearLayers()
  journeyPreviewMap.reset()
  previewStopDots.reset()
}
// 全路網是可疊加的輔助圖層，不是 drawer 主視圖。它不能取消路線、站牌或
// 行程查詢；關閉圖層時則只作廢自己的載入。
const networkRequests = createNavRequestCoordinator()
// URL hydration 可能跨過載入目錄、解析站牌與還原分享行程等多個 await；
// Back/Forward 或另一個 hydration 一開始就讓整條舊鏈失效。
const locationHydrations = createNavRequestCoordinator()
function cancelLocationHydration(): void {
  locationHydrations.cancel()
}

const cityNetwork = createCityNetworkController({
  map,
  layer: networkLayer,
  renderer: networkRenderer,
  button: networkButton,
  hoverCapable,
  routeColor,
  beginRequest: () => networkRequests.begin(),
  cancelRequest: () => networkRequests.cancel(),
  isStaleRequest: (requestId) => networkRequests.isStale(requestId),
  loadNetwork: mapApi.network,
  setStatus,
  clearStatus,
})

const routeDetailSurface = createRouteDetailSurface({
  map,
  routeLayer,
  previewLayer,
  selectionLayer,
  vehicleLayer,
  renderDrawer,
  focusBounds: (bounds) => camera.focusBounds(bounds),
  focusPoint: (position, zoom) => camera.focusPoint(position, zoom),
  bindHoverTooltip,
  selectablePreviewLine,
  previewStopDots,
  drawerBack,
  heading,
  paragraph,
  retryButton,
})

const vehicleRefresh = createVehicleRefreshController<RouteMapVariant, VehiclePositionsResponse>({
  load: (cityCode, variant, signal) => mapApi.vehicles(cityCode, variant, signal),
  isActive: (session) => routeDetail.isVehicleSessionActive(session),
  onResponse: renderVehiclePositions,
  onError: renderVehicleRefreshError,
  onStop: () => routeDetailSurface.clearVehicles(),
})

const routeTimetableSummary = createTimetableSummaryController<
  RouteMapVariant,
  RouteTimetableResponse,
  HTMLButtonElement
>({
  load: (cityCode, variant, signal) => mapApi.timetable(cityCode, variant, undefined, signal),
  isTargetActive: (target) => drawer.contains(target),
  isAvailable: ({ timetable }) => timetable.mode !== 'none' && timetable.services.length > 0,
  onAvailable: ({ variant, target }, data) => {
    renderTimetableSummary(target, timetableSummaryText(data.timetable) ?? '查看時刻表')
    target.classList.remove('pending')
    target.disabled = false
    target.setAttribute('aria-label', '查看時刻表')
    target.addEventListener('click', () => void routeDetail.openTimetable())
  },
  onUnavailable: ({ target }) => target.remove(),
  // 時刻是輔助資訊；拿不到就整列收掉，不打斷路線與車輛定位。
  onError: ({ target }) => target.remove(),
})

const routeDetail = createRouteDetailController({
  surface: routeDetailSurface,
  loadVariants: mapApi.routeVariants,
  loadTimetable: mapApi.timetable,
  beginRequest: beginNavRequest,
  isStaleRequest: isStaleNav,
  isCityActive: (cityCode) => activeCity?.code === cityCode,
  prepareOpen: (request) => {
    cityNetwork.hide()
    clearPreviewLayer()
    nearbyLayer.clearLayers()
    if (!request.returnToTrip && !hasTripResults()) clearTripState()
  },
  invalidatePreview: invalidatePreviewRequests,
  clearNearby: () => nearbyLayer.clearLayers(),
  clearPreview: clearPreviewLayer,
  enterRouteMode: () => { interactionMode = 'route' },
  clearTripState,
  hasTripResults,
  returnToTripResults,
  returnToRoutePicker,
  onStopSelect: (latitude, longitude) => void findNearbyPlaces(latitude, longitude, 'route-stop'),
  writePickerLocation: (cityCode, routeName, stopUid) => {
    history.replaceState(
      history.state,
      '',
      `/map?city=${encodeURIComponent(cityCode)}&route=${encodeURIComponent(routeName)}${stopUid ? `&stopUid=${encodeURIComponent(stopUid)}` : ''}`,
    )
  },
  writeVariantLocation: (cityCode, variant, stopUid) => {
    const params = new URLSearchParams({
      city: cityCode,
      route: variant.routeName,
      routeUid: variant.routeUid,
      direction: String(variant.direction),
      variant: variant.variantKey,
    })
    if (stopUid) params.set('stopUid', stopUid)
    const currentState = historyRecord()
    history.replaceState({
      ...currentState,
      mapView: 'route',
      mapParent: readMapView({ mapView: currentState.mapParent }) ?? 'catalogue',
    }, '', `/map?${params}`)
  },
  setDocumentTitle,
  setStatus,
  clearStatus,
  startVehicleRefresh: (cityCode, variant) => vehicleRefresh.start({ cityCode, route: variant }),
  stopVehicleRefresh: () => vehicleRefresh.stop(),
  startTimetableSummary: (cityCode, variant, target) => {
    routeTimetableSummary.start({ cityCode, variant, target })
  },
  stopTimetableSummary: () => routeTimetableSummary.stop(),
})
function browserStorage(): Storage | undefined {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

function decorateMapFeatureButton(
  button: HTMLButtonElement,
  feature: MapFeature,
  icon: string,
  label: string,
): void {
  const iconNode = document.createElement('span')
  iconNode.className = 'map-feature-icon'
  iconNode.textContent = icon
  iconNode.setAttribute('aria-hidden', 'true')
  const labelNode = document.createElement('span')
  labelNode.className = 'map-feature-label'
  labelNode.textContent = label
  labelNode.setAttribute('aria-hidden', 'true')
  button.replaceChildren(iconNode, labelNode)
  button.classList.toggle('feature-unseen', !mapFeatureDiscovery.hasUsed(feature))
}

function markMapFeatureUsed(button: HTMLButtonElement, feature: MapFeature): void {
  if (mapFeatureDiscovery.hasUsed(feature)) return
  mapFeatureDiscovery.markUsed(feature)
  button.classList.remove('feature-unseen')
}

// 依路線名稱 hash 配色:同一條路線在清單、預覽、路線頁永遠同色,
// 使用者才能建立「路線=顏色」的連結;依清單位置配色會讓顏色隨排序漂移。
function routeColor(routeName: string): string {
  let hash = 2166136261
  for (const char of routeName) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
  return routePalette[(hash >>> 0) % routePalette.length]
}

// 轉乘兩段撞色時把第二段移到下一個色格,乘車段落才分得開。
function transferLegColors(first: string, second: string): [string, string] {
  const firstColor = routeColor(first)
  let secondColor = routeColor(second)
  if (secondColor === firstColor) {
    secondColor = routePalette[(routePalette.indexOf(firstColor) + 1) % routePalette.length]
  }
  return [firstColor, secondColor]
}

// 觸控裝置沒有 hover,tooltip 會在點按瞬間彈出並蓋住點擊目標,直接不綁。
function bindHoverTooltip<T extends L.Layer>(layer: T, content: string, options?: L.TooltipOptions): T {
  if (hoverCapable) bindTextTooltip(layer, content, options)
  return layer
}

let initialising = false
void initialise()

async function initialise() {
  if (initialising) return
  initialising = true
  try {
    if (!cities.length) cities = await mapApi.cities()
    seedInitialMapHistory()
    await hydrateMapLocation()
  } catch {
    renderBootstrapError()
  } finally {
    initialising = false
  }
}

function seedInitialMapHistory() {
  const mutations = planInitialMapHistory({
    state: history.state,
    params: new URLSearchParams(location.search),
    cities,
    validRegions: new Set(regions.map((region) => region.code)),
    originalUrl: `${location.pathname}${location.search}`,
  })
  for (const mutation of mutations) {
    if (mutation.mode === 'replace') history.replaceState(mutation.state, '', mutation.url)
    else history.pushState(mutation.state, '', mutation.url)
  }
}

async function hydrateMapLocation() {
  const params = new URLSearchParams(location.search)
  const canonicalHistory = canonicalMapHistoryState(history.state, params)
  if (canonicalHistory.changed) {
    history.replaceState(canonicalHistory.state, '', location.href)
  }
  const hydration = locationHydrations.begin()
  const hydrationIsStale = () => hydration.signal.aborted
    || locationHydrations.isStale(hydration.requestId)
  const regionCode = params.get('region') as RegionCode | null
  if (regionCode && regions.some((region) => region.code === regionCode)) {
    showRegion(regionCode)
    return
  }
  // `/map` 永遠代表全台總覽；恢復縣市必須由可分享、可重整的 city URL 明確表達。
  const cityCode = params.get('city')
  const routeName = params.get('route')
  if (cityCode) {
    const city = cities.find((candidate) => candidate.code === cityCode)
    if (city) {
      if (!history.state?.mapView) {
        history.replaceState({ mapView: 'catalogue' }, '', location.href)
      }
      activateCityContext(city)
      if (routeName) {
        const returnToTrip = history.state?.mapParent === 'trip-results' && restoreTripResultsState()
        await openRouteDetail(routeName, params.get('variant'), returnToTrip, stopFillAccent, undefined, params.get('stopUid'))
      } else {
        if (params.get('trip') === 'results' && restoreTripResultsState(params)) {
          returnToTripResults()
          return
        }
        if (params.get('trip') === 'results') {
          const restored = await restoreSharedTripResults(params, hydration.signal, hydrationIsStale)
          if (hydrationIsStale() || restored) return
        }
        if (params.get('trip') === 'select') {
          clearTripState()
          tripController.start()
          return
        }
        const placeId = params.get('place')
        const stopUid = params.get('stopUid')
        if (placeId || stopUid) {
          await openPlaceById(placeId, hydration.signal, hydrationIsStale, stopUid)
          return
        }

        const latitudeParam = params.get('lat')
        const longitudeParam = params.get('lon')
        const latitude = Number(latitudeParam)
        const longitude = Number(longitudeParam)
        if (latitudeParam !== null && longitudeParam !== null && Number.isFinite(latitude) && Number.isFinite(longitude)) {
          camera.focusPoint([latitude, longitude], 15)
          await findNearbyPlaces(latitude, longitude, undefined, 'replace')
          return
        }

        await chooseCity(city)
      }
      return
    }
  }
  showTaiwan()
}

function renderBootstrapError() {
  const message = '目前無法載入縣市資料，請檢查網路後再試一次。'
  setStatus('地圖初始化失敗，請稍後再試。', true)
  const retry = retryButton(() => initialise())
  renderDrawer({
    key: 'initialization-error',
    mode: 'map-list',
    header: [heading('地圖初始化失敗', message)],
    content: [paragraph(message)],
    footer: [retry],
  })
  setDocumentTitle('地圖初始化失敗')
}

networkButton.addEventListener('click', () => {
  markMapFeatureUsed(networkButton, 'network')
  if (activeCity) void cityNetwork.toggle(activeCity)
})
// 品牌鍵 = 回到全台總覽(留在地圖內);右上「首頁」才是離開地圖的出口。
document.getElementById('map-brand')?.addEventListener('click', (event) => {
  event.preventDefault()
  showTaiwan()
})
map.on('zoomend', updateStopMarkerSize)
map.on('click', (event) => {
  if (!activeCity) return
  // 全路網圖層是 non-interactive,點線/點站點都會落到這裡:先問網格索引。
  // 觸控沒有游標精準度,容差比照舊 canvas tolerance 放大。
  const pick = cityNetwork.pickAt(event.latlng, hoverCapable ? 8 : 14, hoverCapable ? 10 : 16)
  if (trip.stage !== 'idle') {
    // 規劃選點中,點到小站點就吸附站點座標;點到線只是瞄準地圖,照點的位置處理
    if (pick?.kind === 'place') void tripController.selectCoordinate(pick.place.latitude, pick.place.longitude)
    else void tripController.selectCoordinate(event.latlng.lat, event.latlng.lng)
    return
  }
  if (pick?.kind === 'place') {
    void findNearbyPlaces(pick.place.latitude, pick.place.longitude, 'map')
    return
  }
  if (pick?.kind === 'route') {
    openChildRoute(pick.route.routeName, pick.route.variantKey, routeColor(pick.route.routeName))
    return
  }
  if (map.getZoom() >= 14) void findNearbyPlaces(event.latlng.lat, event.latlng.lng, 'map')
  else {
    camera.focusPoint(event.latlng, 14, { animate: true })
    setStatus('放大後再選站牌，避免誤選太遠的位置')
  }
})

function showTaiwan() {
  cancelLocationHydration()
  cancelNavRequest()
  tripController.clearPending()
  clearTripResultsCamera()
  activeCity = undefined
  networkButton.hidden = true
  cityNetwork.hide()
  routeDetail.close()
  selectionLayer.clearLayers()
  nearbyLayer.clearLayers()
  clearPreviewLayer()
  tripController.reset()
  setStatus('選一個區域，看看公車如何穿過城市。')
  renderRegionMarkers()
  renderDrawer({
    key: 'overview',
    mode: 'compact',
    content: [
      heading('先從哪裡開始？', '公車不是清單，是城市的骨架。'),
      buttonGrid(regions.map((region) => ({
        label: region.name,
        onClick: () => openRegion(region.code),
      })), 'map-fallback-grid'),
      locateCityButton(),
    ],
  })
  camera.focusBounds(TAIWAN_OVERVIEW_BOUNDS, { maxZoom: () => overviewMaxZoom(7.5) })
  history.replaceState({ mapView: 'overview' }, '', '/map')
  setDocumentTitle()
}

// 「跳到你所在的縣市」用 Cloudflare 依連線 IP 推估的粗略位置(縣市級),
// 完全不觸發瀏覽器定位授權;精度只夠選縣市,所以不拿來找站牌。
function locateCityButton(): HTMLButtonElement {
  const button = document.createElement('button')
  button.className = 'locate-button'
  button.textContent = '跳到你所在的縣市'
  button.addEventListener('click', () => void jumpToNearestCity(button))
  return button
}

async function jumpToNearestCity(button: HTMLButtonElement) {
  const { requestId, signal } = beginNavRequest()
  button.disabled = true
  button.textContent = '正在判斷你的位置…'
  try {
    const data = await mapApi.locate(signal)
    if (isStaleNav(requestId)) return
    if (!cities.length) throw new Error('這次判斷不出位置，直接手動選吧')
    const origin: [number, number] = [data.latitude, data.longitude]
    const nearest = cities.reduce((best, city) =>
      coarseKilometers(city.center, origin) < coarseKilometers(best.center, origin) ? city : best)
    // 離最近縣市中心太遠,代表人大概不在台灣(或 IP 出口在國外),硬跳只會誤導。
    if (coarseKilometers(nearest.center, origin) > 150) throw new Error('看起來你不在台灣附近，直接手動選吧')
    openCity(nearest)
    setStatus(`猜你在${nearest.name}，猜錯按「返回縣市」重選。`)
  } catch (error) {
    if (isStaleNav(requestId)) return
    setStatus(error instanceof Error && error.message ? error.message : '定位失敗，直接手動選吧', true)
    button.disabled = false
    button.textContent = '跳到你所在的縣市'
  }
}

// 粗略公里距離(等距圓柱近似),挑最近縣市夠用。
function coarseKilometers(a: [number, number], b: [number, number]): number {
  const kmLat = (a[0] - b[0]) * 110.6
  const kmLon = (a[1] - b[1]) * 111.3 * Math.cos(((a[0] + b[0]) / 2) * Math.PI / 180)
  return Math.sqrt(kmLat * kmLat + kmLon * kmLon)
}

const CITY_ICON_SIZE: [number, number] = [60, 30]

// 幾組「市被縣包住」的縣市中心點物理距離很近(新竹市／縣、嘉義市／縣、雙北),
// 區域總覽的縮放層級下按鈕會疊在一起;用 labelOffset 只挪動視覺位置,
// 實際點擊/地理定位仍用 city.center,不影響選中的城市。
function cityIconAnchor(city: MapCity): [number, number] {
  const [dx, dy] = city.labelOffset ?? [0, 0]
  return [CITY_ICON_SIZE[0] / 2 - dx, CITY_ICON_SIZE[1] / 2 - dy]
}

function renderRegionMarkers() {
  for (const region of regions.filter((item) => item.code !== 'islands')) {
    L.marker(region.center, {
      icon: L.divIcon({
        className: 'region-marker-wrap',
        html: `<span class="region-marker">${region.name}</span>`,
        iconSize: [74, 40],
        iconAnchor: [37, 20],
      }),
      title: region.name,
    }).on('click', () => openRegion(region.code)).addTo(selectionLayer)
  }
}

function openRegion(regionCode: RegionCode) {
  cancelLocationHydration()
  const currentState = history.state && typeof history.state === 'object' ? history.state : {}
  history.pushState({ ...currentState, mapView: 'region', mapParent: 'overview' }, '', `/map?region=${regionCode}`)
  showRegion(regionCode)
}

function returnToOverview() {
  if (history.state?.mapView === 'region' && history.state?.mapParent === 'overview') {
    history.back()
    return
  }
  showTaiwan()
}

function showRegion(regionCode: RegionCode) {
  cancelNavRequest()
  tripController.clearPending()
  clearTripResultsCamera()
  networkButton.hidden = true
  cityNetwork.hide()
  const region = regions.find((candidate) => candidate.code === regionCode)!
  const currentState = history.state && typeof history.state === 'object' ? history.state : {}
  history.replaceState({
    ...currentState,
    mapView: 'region',
    mapParent: currentState.mapView === 'region' ? currentState.mapParent : 'overview',
  }, '', `/map?region=${regionCode}`)
  routeDetail.close()
  selectionLayer.clearLayers()
  nearbyLayer.clearLayers()
  clearPreviewLayer()
  clearStatus()
  const regionCities = cities.filter((city) => city.region === regionCode)
  for (const city of regionCities) {
    L.marker(city.center, {
      icon: L.divIcon({
        className: 'city-marker-wrap',
        html: `<span class="city-marker">${city.name}</span>`,
        iconSize: CITY_ICON_SIZE,
        iconAnchor: cityIconAnchor(city),
      }),
      title: city.name,
    }).on('click', () => openCity(city)).addTo(selectionLayer)
  }
  renderDrawer({
    key: `region:${region.code}`,
    mode: 'compact',
    content: [
      drawerBack('返回區域', returnToOverview),
      heading(region.name, '直接點地圖上的縣市，或從這裡選。'),
      buttonGrid(regionCities.map((city) => ({
        label: city.name,
        onClick: () => openCity(city),
      })), 'map-fallback-grid'),
    ],
  })
  fitRegionCities(region, regionCities)
}

function openCity(city: MapCity) {
  cancelLocationHydration()
  const currentState = history.state && typeof history.state === 'object' ? history.state : {}
  if (currentState.mapView !== 'region') {
    history.pushState({ ...currentState, mapView: 'region', mapParent: 'overview' }, '', `/map?region=${city.region}`)
  }
  history.pushState({
    ...history.state,
    mapView: 'catalogue',
    mapParent: 'region',
  }, '', `/map?city=${encodeURIComponent(city.code)}`)
  void chooseCity(city)
}

function returnToRegion() {
  if (history.state?.mapView === 'catalogue' && history.state?.mapParent === 'region') {
    history.back()
    return
  }
  if (activeCity) showRegion(activeCity.region)
}

function activateCityContext(city: MapCity) {
  activeCity = city
  setActiveCity(city.code)
  networkButton.hidden = false
  cityNetwork.hide()
  selectionLayer.clearLayers()
  nearbyLayer.clearLayers()
  setDocumentTitle(`${city.name}公車地圖`)
}

async function chooseCity(city: MapCity) {
  tripController.clearPending()
  clearTripResultsCamera()
  activateCityContext(city)
  category = '全部'
  routeSearchQuery = ''
  routeScrollTop = 0
  tripController.reset()
  const { requestId, signal } = beginNavRequest()
  routeDetail.close()
  clearPreviewLayer()
  setStatus(`${city.name} · 正在整理路線…`)
  renderDrawer({
    key: `catalogue:${city.code}`,
    mode: 'compact',
    size: 'standard',
    content: [drawerBack('返回區域', returnToRegion), heading(city.name, '正在載入路線…')],
  })
  camera.focusPoint(city.center, 11)

  try {
    const loadedRoutes = await mapApi.routes(city.code, signal)
    if (isStaleNav(requestId)) return
    routes = loadedRoutes
    routesCityCode = city.code
    category = '全部'
    renderRoutePicker()
    camera.focusPoint(city.center, 11)
  } catch {
    if (isStaleNav(requestId)) return
    setStatus('目前無法載入這個縣市的路線。', true)
    renderDrawer({
      key: `catalogue:${city.code}`,
      mode: 'compact',
      size: 'standard',
      content: [
        drawerBack('返回區域', returnToRegion),
        heading(city.name, '目前無法載入這個縣市的路線。'),
        retryButton(() => chooseCity(city)),
      ],
    })
    camera.focusPoint(city.center, 11)
  }
}

function renderRoutePicker() {
  if (!activeCity) return
  cancelNavRequest()
  interactionMode = 'browse'
  clearTripState()
  routeDetail.close()
  clearPreviewLayer()
  nearbyLayer.clearLayers()
  if (!routes.length || routesCityCode !== activeCity.code) {
    // 深連結直接進路線(沒經過 chooseCity)後按返回會走到這:目錄還沒載,
    // 先補抓再重畫,不然會看到一片空白的路線選單。
    renderDrawer({
      key: `catalogue:${activeCity.code}`,
      mode: 'compact',
      size: 'standard',
      content: [
        drawerBack('返回縣市', returnToRegion),
        heading(activeCity.name, '正在載入路線…'),
      ],
    })
    const cityCode = activeCity.code
    const { requestId, signal } = beginNavRequest()
    void (async () => {
      try {
        const loadedRoutes = await mapApi.routes(cityCode, signal)
        if (isStaleNav(requestId) || activeCity?.code !== cityCode || interactionMode !== 'browse') return
        routes = loadedRoutes
        routesCityCode = cityCode
        category = '全部'
        // 載回來時使用者可能已經離開選單(開了路線、換了城市),別把畫面搶回來
        if (interactionMode === 'browse' && activeCity?.code === cityCode) renderRoutePicker()
      } catch {
        // 同樣不能把失敗畫面搶回使用者已經離開的城市/選單
        if (isStaleNav(requestId) || interactionMode !== 'browse' || activeCity?.code !== cityCode) return
        setStatus('目前無法載入這個縣市的路線。', true)
        renderDrawer({
          key: `catalogue:${activeCity!.code}`,
          mode: 'compact',
          size: 'standard',
          content: [
            drawerBack('返回縣市', returnToRegion),
            heading(activeCity!.name, '目前無法載入這個縣市的路線。'),
            retryButton(() => renderRoutePicker()),
          ],
        })
      }
    })()
    return
  }
  const back = drawerBack('返回縣市', returnToRegion)
  const title = heading(activeCity.name, `${routes.length} 條路線，不用設定起終點，直接看一條公車。`)
  const search = document.createElement('input')
  search.className = 'map-search map-route-search'
  search.placeholder = '路線或站牌名稱'
  search.setAttribute('aria-label', '篩選路線，或搜尋站牌名稱')
  const categories = document.createElement('div')
  categories.className = 'map-categories'
  const stopResults = document.createElement('div')
  stopResults.className = 'place-search-results'
  const routeGrid = document.createElement('div')
  routeGrid.className = 'map-route-grid'
  const drawerSession = renderDrawer({
    key: `catalogue:${activeCity.code}`,
    mode: 'map-list',
    header: [back, title, tripModeButton(), search, categories],
    content: [stopResults, routeGrid],
  })
  const listRegion = drawerSession.scrollRegion!

  const savedCatalogue = history.state?.routeCatalogue as {
    city?: unknown
    query?: unknown
    category?: unknown
    scrollTop?: unknown
  } | undefined
  if (savedCatalogue?.city === activeCity.code) {
    if (typeof savedCatalogue.query === 'string') routeSearchQuery = savedCatalogue.query
    if (typeof savedCatalogue.category === 'string') category = savedCatalogue.category
    if (typeof savedCatalogue.scrollTop === 'number') routeScrollTop = Math.max(0, savedCatalogue.scrollTop)
  }
  search.value = routeSearchQuery

  const counts = new Map<string, number>()
  routes.forEach((route) => counts.set(route.category, (counts.get(route.category) ?? 0) + 1))
  const names = ['全部', ...['數字', '幹線', '接駁', '幸福／社區', '觀光', '小黃', '公路客運', '其他'].filter((name) => counts.has(name))]

  const render = () => {
    categories.replaceChildren(...names.map((name) => {
      const button = document.createElement('button')
      button.className = `map-chip${category === name ? ' active' : ''}`
      const label = name === '幸福／社區' ? '幸福・社區' : name
      button.textContent = name === '全部' ? `${label} ${routes.length}` : label
      button.setAttribute('aria-pressed', String(category === name))
      button.addEventListener('click', () => {
        category = name
        routeScrollTop = 0
        listRegion.scrollTop = 0
        render()
      })
      return button
    }))
    const query = search.value.trim().toLowerCase()
    const visible = routes
      .filter((route) => category === '全部' || route.category === category)
      .filter((route) => !query || route.routeName.toLowerCase().includes(query))
    routeGrid.replaceChildren(...visible.map((route) => {
      const button = document.createElement('button')
      button.className = 'map-route-button'
      button.setAttribute('aria-label', route.routeName)
      const display = splitRouteDisplayName(route.routeName)
      const name = document.createElement('strong')
      name.textContent = display.name
      button.appendChild(name)
      if (display.note) {
        const note = document.createElement('small')
        note.textContent = display.note
        button.appendChild(note)
      }
      button.addEventListener('click', () => openCatalogueRoute(route.routeName))
      return button
    }))
  }
  // 同一個輸入框兼作站牌搜尋:2 個字以上就順便查站牌,結果排在路線格之上。
  let stopSearchTimer: number | undefined
  const queueStopSearch = () => {
    window.clearTimeout(stopSearchTimer)
    const query = search.value.trim()
    if (query.length < 2) {
      stopResults.replaceChildren()
      return
    }
    stopSearchTimer = window.setTimeout(() => {
      void (async () => {
        const places = await searchPlaces(query, drawerSession.signal)
        if (drawerSession.signal.aborted) return
        if (search.value.trim() !== query) return
        stopResults.replaceChildren(...places.slice(0, 6).map((place) => createPlaceSearchResultButton(place, openSearchedPlace)))
      })()
    }, 300)
  }
  drawerSession.onDispose(() => window.clearTimeout(stopSearchTimer))
  search.addEventListener('input', () => {
    routeSearchQuery = search.value
    routeScrollTop = 0
    listRegion.scrollTop = 0
    render()
    queueStopSearch()
  })
  listRegion.addEventListener('scroll', () => { routeScrollTop = listRegion.scrollTop }, { passive: true })
  render()
  listRegion.scrollTop = routeScrollTop
  saveRouteCatalogueState('/map?city=' + encodeURIComponent(activeCity.code))
  clearStatus()
}

function saveRouteCatalogueState(url = location.href) {
  if (!activeCity) return
  const currentState = history.state && typeof history.state === 'object' ? history.state : {}
  history.replaceState({
    ...currentState,
    mapView: 'catalogue',
    routeCatalogue: {
      city: activeCity.code,
      query: routeSearchQuery,
      category,
      scrollTop: routeScrollTop,
    },
  }, '', url)
}

function openCatalogueRoute(routeName: string) {
  if (!activeCity) return
  cancelLocationHydration()
  saveRouteCatalogueState()
  history.pushState({
    ...history.state,
    mapView: 'route',
    mapParent: 'catalogue',
  }, '', `/map?city=${encodeURIComponent(activeCity.code)}&route=${encodeURIComponent(routeName)}`)
  void openRouteDetail(routeName)
}

function openChildRoute(routeName: string, preferredVariant?: string | null, color = routeColor(routeName), preferredTimetableStopUid?: string | null) {
  if (!activeCity) return
  cancelLocationHydration()
  const currentState = historyRecord()
  const parent = readMapView(currentState) ?? mapViewFromUrl()
  if (parent === 'catalogue') saveRouteCatalogueState()
  history.pushState({
    ...historyRecord(),
    mapView: 'route',
    mapParent: parent,
  }, '', `/map?city=${encodeURIComponent(activeCity.code)}&route=${encodeURIComponent(routeName)}${preferredVariant ? `&variant=${encodeURIComponent(preferredVariant)}` : ''}${preferredTimetableStopUid ? `&stopUid=${encodeURIComponent(preferredTimetableStopUid)}` : ''}`)
  void openRouteDetail(routeName, preferredVariant, false, color, parent === 'catalogue' ? undefined : () => history.back(), preferredTimetableStopUid)
}

async function searchPlaces(query: string, signal?: AbortSignal): Promise<SearchPlace[]> {
  if (!activeCity) return []
  try {
    return await mapApi.search(activeCity.code, query, signal)
  } catch {
    return []
  }
}
function tripMatchedSummary(kind: TripSelectionKind): HTMLElement | undefined {
  const selected = kind === 'from' ? trip.from : trip.to
  if (!selected) return
  const pending = trip.pending(kind)
  return createTripEndpointSummary({
    kind,
    selected,
    matchedDistanceMeters: pending?.selected.distanceMeters,
    onActivate: () => {
      if (pending) tripController.showCandidates(kind)
      else tripController.resume(kind)
    },
  })
}

function resumeTripEndpointSelection(kind: TripSelectionKind) {
  tripController.resume(kind)
}

function tripMatchedControls(compact = false): HTMLElement | undefined {
  const from = tripMatchedSummary('from')
  const to = tripMatchedSummary('to')
  if (!from && !to) return
  const controls = document.createElement('div')
  controls.className = 'trip-matched-controls'
  controls.classList.toggle('compact', compact)
  if (from) controls.appendChild(from)
  if (to) controls.appendChild(to)
  return controls
}

function renderPendingTripCandidates(kind: TripSelectionKind) {
  const pending = trip.pending(kind)
  if (!pending) return
  const list = createTripCandidateList({
    candidates: pending.candidates,
    selectedPlaceId: pending.selected.placeId,
    onSelect: (candidate) => void tripController.selectCandidate(kind, candidate),
  })
  const backAction = hasTripResults() ? returnToTripResults : () => tripController.focus(kind)
  renderDrawer({
    key: `trip-candidates:${kind}`,
    mode: 'map-list',
    header: [
      drawerBack(hasTripResults() ? '返回行程候選' : '返回選點', backAction),
      heading(
        kind === 'from' ? '選擇出發站牌' : '選擇目的地站牌',
        '點選附近站牌，或重新選位置。',
      ),
    ],
    content: [list],
    footer: [createReselectTripEndpointButton(kind, () => tripController.resume(kind))],
  })
  setStatus(`${kind === 'from' ? '出發' : '目的地'} · ${pending.candidates.length} 個附近站牌`)
}

function showTripSelectionStep(nextKind: TripSelectionKind) {
  clearTripResultsCamera()
  interactionMode = 'trip'
  clearPreviewLayer()
  nearbyLayer.clearLayers()
  drawTripEndpoints()
  renderTripSelectionStep(nextKind)
}

function renderTripSelectionStep(nextKind: TripSelectionKind) {
  const existingKind: TripSelectionKind = nextKind === 'from' ? 'to' : 'from'
  const existingSummary = tripMatchedSummary(existingKind)
  const searchLabel = nextKind === 'from' ? '搜尋出發站牌' : '搜尋目的地站牌'
  const title = nextKind === 'from' ? '點一下出發位置' : '再點一下目的地'
  const description = nextKind === 'from'
    ? '點地圖或搜尋站牌。'
    : `已選擇「${trip.from?.name ?? ''}」，再點目的地或搜尋站牌。`
  const searchBox = createPlaceSearchBox({
    placeholder: searchLabel,
    search: searchPlaces,
    onPick: (place) => void tripController.selectPlace(nextKind, place),
  })
  const drawerSession = renderDrawer({
    key: `trip-select:${nextKind}`,
    mode: 'compact',
    content: [
      drawerBack('取消路線規劃', cancelTripMode),
      heading(title, description),
      existingSummary ?? document.createDocumentFragment(),
      searchBox.element,
    ],
  })
  drawerSession.onDispose(searchBox.dispose)
  clearStatus()
}

function prepareTripPlan() {
  interactionMode = 'trip-results'
  cityNetwork.hide()
  nearbyLayer.clearLayers()
  drawTripEndpoints()
}

// 搜尋選中的站牌直接開站牌路線視圖(跟 deep link 進站牌同一條路)。
function openSearchedPlace(place: SearchPlace) {
  if (!activeCity) return
  cancelLocationHydration()
  saveRouteCatalogueState()
  history.pushState({
    ...historyRecord(),
    mapView: 'place',
    mapParent: 'catalogue',
  }, '', `/map?city=${encodeURIComponent(activeCity.code)}&place=${encodeURIComponent(place.placeId)}`)
  camera.focusPoint([place.latitude, place.longitude], 16)
  const nearbyPlace: NearbyPlace = { ...place, distanceMeters: 0 }
  nearbyResults.replace([place.latitude, place.longitude], [nearbyPlace])
  interactionMode = 'nearby'
  void placeRoutes.open(nearbyPlace)
}

function tripModeButton(): HTMLButtonElement {
  const button = document.createElement('button')
  button.className = 'trip-mode-button map-feature-button'
  // 按鈕每次 render 重建,建立當下的模式就是它的 active 狀態:
  // 描邊=可進入規劃,實心=正在規劃中。
  if (interactionMode === 'trip' || interactionMode === 'trip-results') button.classList.add('active')
  button.title = '路線規劃'
  button.setAttribute('aria-label', '路線規劃：選擇出發位置與目的地')
  decorateMapFeatureButton(button, 'trip', '↗', '規劃')
  button.addEventListener('click', () => {
    cancelLocationHydration()
    markMapFeatureUsed(button, 'trip')
    if (activeCity) {
      const currentState = history.state && typeof history.state === 'object' ? history.state : {}
      const nextState = { ...currentState, mapView: 'trip-select', mapParent: currentState.mapView }
      const url = `/map?city=${encodeURIComponent(activeCity.code)}&trip=select`
      if (currentState.mapView === 'trip-results') history.replaceState(nextState, '', url)
      else history.pushState(nextState, '', url)
    }
    // 全路網開著就留著:小站點正好當選點的瞄準參考,等終點選完才收
    routeDetail.close()
    tripController.start()
  })
  return button
}

function cancelTripMode() {
  clearTripState()
  interactionMode = 'browse'
  nearbyLayer.clearLayers()
  clearPreviewLayer()
  if (history.state?.mapView === 'trip-select' && history.state?.mapParent) {
    history.back()
    return
  }
  renderRoutePicker()
}
function clearTripState() {
  tripController.reset()
  clearTripResultsCamera()
}


function captureTripResultsCamera() {
  if (!activeCity || !hasTripResults()) return
  tripResultsCamera = captureMapCamera(map)
  tripResultsCameraCity = activeCity.code
}

function restoreTripResultsCamera(): boolean {
  if (!activeCity || !tripResultsCamera || tripResultsCameraCity !== activeCity.code || !hasTripResults()) return false
  camera.clear()
  restoreMapCamera(map, tripResultsCamera)
  return true
}

function clearTripResultsCamera() {
  tripResultsCamera = undefined
  tripResultsCameraCity = undefined
  // 清除行程也要讓尚未完成的 preview 失效,避免舊回應重新畫線或 fit。
  invalidatePreviewRequests()
}
function hasTripResults(): boolean {
  return tripController.hasResults()
}


// 從岔出去的畫面(檢視候選路線、附近站牌)回到行程候選清單。
// 行程結果只在明確出口丟棄(路線列表、取消規劃、換城市),
// 中途點站牌、開路線都保留狀態,靠這裡回得來。
function returnToTripResults() {
  if (history.state?.mapView === 'route' && history.state?.mapParent === 'trip-results') {
    history.back()
    return
  }
  cancelNavRequest()
  if (!hasTripResults()) {
    renderRoutePicker()
    return
  }
  interactionMode = 'trip-results'
  // 選中的路線畫在 routeLayer、車輛有自己的計時器,回候選清單時一併收掉
  routeDetail.close()
  nearbyLayer.clearLayers()
  void (async () => {
    let previewCompleted = false
    try {
      previewCompleted = await tripController.showResults({ fitCamera: false })
    } catch {
      // 預覽資料失敗時仍保留候選抽屜與離開前鏡頭,不讓錯誤的 fallback fit 搶走視角。
      if (hasTripResults()) {
        drawTripEndpoints()
        restoreTripResultsCamera()
      }
      return
    }
    if (!previewCompleted || !hasTripResults()) return
    drawTripEndpoints()
    restoreTripResultsCamera()
  })()
}


function returnToRoutePicker() {
  if (history.state?.mapView === 'route' && history.state?.mapParent === 'catalogue') {
    history.back()
    return
  }
  renderRoutePicker()
}

function unifiedStopMarker(
  position: L.LatLngExpression,
  prominent = false,
  fillColor = stopFillGreen,
): L.CircleMarker {
  const prominentRadius = map.getZoom() >= 16 ? 11 : 9
  return L.circleMarker(position, {
    pane: 'stopPane',
    radius: prominent ? prominentRadius : stopStyleForZoom(map.getZoom()).radius,
    color: stopHaloColor,
    weight: prominent ? 2.4 : 1.4,
    fillColor,
    fillOpacity: .96,
  })
}

function drawTripEndpoints() {
  if (trip.fromCoordinate) {
    bindTextTooltip(unifiedStopMarker(trip.fromCoordinate, true, stopFillAccent), '出發位置', { permanent: true, direction: 'top' }).addTo(nearbyLayer)
  }
  if (trip.toCoordinate) {
    bindTextTooltip(unifiedStopMarker(trip.toCoordinate, true, stopFillGreen), '目的地', { permanent: true, direction: 'top' }).addTo(nearbyLayer)
  }
}

function openTripRoute(
  routeName: string,
  preferredVariant: string | null | undefined,
  color: string,
  backAction?: () => void,
) {
  captureTripResultsCamera()
  writeTripResultsUrl()
  if (activeCity) {
    history.pushState({
      ...history.state,
      mapView: 'route',
      mapParent: 'trip-results',
    }, '', `/map?city=${encodeURIComponent(activeCity.code)}&route=${encodeURIComponent(routeName)}${preferredVariant ? `&variant=${encodeURIComponent(preferredVariant)}` : ''}`)
  }
  void openRouteDetail(routeName, preferredVariant, true, color, backAction)
}
function openRouteDetail(
  routeName: string,
  preferredVariant?: string | null,
  returnToTrip = false,
  color = stopFillAccent,
  stopBackAction?: () => void,
  preferredTimetableStopUid?: string | null,
): Promise<void> {
  if (!activeCity) return Promise.resolve()
  return routeDetail.open({
    cityCode: activeCity.code,
    routeName,
    preferredVariant,
    returnToTrip,
    color,
    stopBackAction,
    preferredTimetableStopUid,
  })
}
function stopStyleForZoom(zoom: number): L.CircleMarkerOptions {
  if (zoom >= 16) return { radius: 8, weight: 1.8 }
  if (zoom >= 13) return { radius: 5, weight: 1.4 }
  return { radius: 2, weight: 1 }
}
function updateStopMarkerSize() {
  routeDetail.resizeStopMarkers()
  cityNetwork.resizeStopMarkers()
  journeyPreviewMap.resizeStopMarkers()
  previewStopDots.resize()
}


function renderVehiclePositions(response: VehiclePositionsResponse) {
  routeDetailSurface.renderVehicles(response.vehicles)
  drawer.querySelector('.vehicle-degraded-notice')?.remove()
  if (response.warning) {
    const message = tdxWarningMessages[response.warning]
    mapStatus.show(message, true)
    const notice = degradedNotice({ message, onRetry: () => vehicleRefresh.refresh(), collapsible: true })
    notice.classList.add('vehicle-degraded-notice')
    drawer.appendChild(notice)
  }
}


function renderVehicleRefreshError(error: unknown) {
  // 車輛定位是輔助資訊，失敗時保留主路線，但不能把授權失效誤裝成「沒有車」。
  const credentialRejected = isTdxTokenRejectedError(error)
  const message = credentialRejected
    ? 'TDX 授權已失效；路線仍可使用，請到設定更新授權。'
    : '暫時無法更新車輛位置；路線與站牌仍可使用。'
  mapStatus.show(message, true)
  drawer.querySelector('.vehicle-degraded-notice')?.remove()
  const notice = degradedNotice({ message, onRetry: () => vehicleRefresh.refresh(), credentialRecovery: credentialRejected, collapsible: true })
  notice.classList.add('vehicle-degraded-notice')
  drawer.appendChild(notice)
}

function enterNearbyView(
  latitude: number,
  longitude: number,
  historyMode: 'push' | 'replace' = 'push',
) {
  if (!activeCity) return
  const currentState = historyRecord()
  const currentView = readMapView(currentState) ?? mapViewFromUrl()
  const nearbyState = {
    ...currentState,
    mapView: 'nearby',
    mapParent: currentView === 'nearby'
      ? readMapView({ mapView: currentState.mapParent }) ?? 'catalogue'
      : currentView,
  }
  const nearbyUrl = `/map?city=${encodeURIComponent(activeCity.code)}&lat=${latitude.toFixed(5)}&lon=${longitude.toFixed(5)}`
  if (historyMode === 'push' && currentView !== 'nearby') history.pushState(nearbyState, '', nearbyUrl)
  else history.replaceState(nearbyState, '', nearbyUrl)
  interactionMode = 'nearby'
  routeDetail.close()
}

async function findNearbyPlaces(
  latitude: number,
  longitude: number,
  previewSource: NearbyPreviewSource | undefined = undefined,
  historyMode: 'push' | 'replace' = 'push',
) {
  if (!activeCity) return
  if (historyMode === 'push') cancelLocationHydration()
  if (!previewSource) enterNearbyView(latitude, longitude, historyMode)
  cityNetwork.hide()
  // 只有「選點進行中」需要中止規劃;已有行程結果就保留,
  // 點站牌不再把整趟規劃清掉,附近站牌視圖會給「返回行程候選」的退路。
  if (interactionMode === 'trip') clearTripState()
  clearPreviewLayer()
  await nearbyPlaces.load({
    cityCode: activeCity.code,
    origin: [latitude, longitude],
    radiusMeters: map.getZoom() >= 15 ? 300 : 500,
    previewSource,
  })
}

function renderNearbyPlaces() {
  const result = nearbyResults.current()
  if (!activeCity || !result) return
  nearbyLoading.abort()
  nearbyPlaces.invalidate()
  cancelNavRequest()
  nearbyResults.renderMap()

  const managedNearbyParent = history.state?.mapView === 'nearby' && history.state?.mapParent
  const nearbyBack = managedNearbyParent
    ? () => history.back()
    : hasTripResults() ? returnToTripResults : renderRoutePicker
  const nearbyBackLabel = history.state?.mapParent === 'route'
    ? '返回路線'
    : hasTripResults() ? '返回行程候選' : '路線列表'
  nearbyPlacesView.renderPlaces({
    cityCode: activeCity.code,
    origin: result.origin,
    places: result.places,
    backLabel: nearbyBackLabel,
    onBack: nearbyBack,
  })
  clearStatus()
  const [latitude, longitude] = result.origin
  const currentState = history.state && typeof history.state === 'object' ? history.state : {}
  history.replaceState({ ...currentState, mapView: 'nearby' }, '', `/map?city=${activeCity.code}&lat=${latitude.toFixed(5)}&lon=${longitude.toFixed(5)}`)
  setDocumentTitle(`${activeCity.name}公車地圖`)
}

function renderTripPlanPhase(phase: TripPlanLoadPhase, context: TripPlanContext) {
  setStatus(phase === 'direct'
    ? `正在找 ${context.from.name} → ${context.to.name} 的直達車…`
    : '沒有直達車，正在找一次轉乘…')
}

async function presentTripResults({ fitCamera }: TripResultsPresentation): Promise<boolean> {
  const results = trip.results()
  if (!results) return false
  interactionMode = 'trip-results'
  writeTripResultsUrl()
  tripResultsView.render(results)
  clearStatus()
  return journeyPreview.preview(results, { fitCamera })
}

function renderTripPlanError(error: unknown, context: TripPlanContext) {
  const message = error instanceof Error && error.message ? error.message : '直達路線查詢失敗'
  setStatus(message, true)
  tripResultsView.renderError({
    context,
    message,
    credentialRecovery: isTdxTokenRejectedError(error),
  })
}

function renderPlaceRoutePreview({ route, variant, color }: PlaceRoutePreview): void {
  const normalStyle = { color, weight: 5.5, opacity: .62, lineCap: 'round' as const, lineJoin: 'round' as const }
  const { line, target } = selectablePreviewLine(variant.shape, 'routePreviewPane', previewLayer, normalStyle)
  previewStopDots.add(variant.stops, color, previewLayer)
  bindHoverTooltip(target, `${variant.routeName} · ${variant.label}`, { sticky: true })
  target.on('mouseover', () => {
    line.setStyle({ ...normalStyle, weight: 8, opacity: .9 })
    line.bringToFront()
  })
  target.on('mouseout', () => line.setStyle(normalStyle))
  target.on('click', (event) => {
    L.DomEvent.stopPropagation(event)
    openChildRoute(variant.routeName, variant.variantKey, color, route.stopUid)
  })
}

async function openPlaceById(
  placeId: string | null,
  signal?: AbortSignal,
  isStale: () => boolean = () => false,
  stopUid?: string | null,
) {
  if (!activeCity) return
  const cityCode = activeCity.code
  const cachedResult = nearbyResults.current()
  const cachedPlace = placeId
    ? cachedResult?.places.find((candidate) => candidate.placeId === placeId)
    : undefined
  let place: NearbyPlace
  if (cachedPlace) {
    place = cachedPlace
  } else {
    try {
      if (!placeId) throw new Error('缺少站牌識別碼')
      place = await mapApi.place(cityCode, placeId, signal)
    } catch (error) {
      if (!stopUid || signal?.aborted || isStale()) throw error
      place = await mapApi.stopPlace(cityCode, stopUid, signal)
    }
  }
  if (signal?.aborted || isStale() || activeCity?.code !== cityCode) return
  camera.focusPoint([place.latitude, place.longitude], 16)
  if (cachedPlace) nearbyResults.renderMap()
  else nearbyResults.replace([place.latitude, place.longitude], [place])
  interactionMode = 'nearby'
  await placeRoutes.open(place)
}
function writeTripResultsUrl() {
  if (!activeCity) return
  const results = trip.results()
  if (!results) return
  const currentState = history.state && typeof history.state === 'object' ? history.state : {}
  const snapshot = createTripResultsSnapshot(activeCity.code, results)
  history.replaceState({
    ...currentState,
    mapView: 'trip-results',
    tripResults: snapshot,
  }, '', `/map?city=${encodeURIComponent(activeCity.code)}&trip=results&from=${encodeURIComponent(results.from.place.placeId)}&to=${encodeURIComponent(results.to.place.placeId)}`)
  setDocumentTitle(`${results.from.place.name} → ${results.to.place.name}`)
}

function restoreTripResultsState(params?: URLSearchParams): boolean {
  if (!activeCity) return false
  const restored = parseTripResultsSnapshot(history.state?.tripResults, {
    city: activeCity.code,
    fromPlaceId: params?.get('from'),
    toPlaceId: params?.get('to'),
  })
  if (!restored) return false
  tripController.restore(restored)
  interactionMode = 'trip-results'
  return tripController.hasResults()
}

async function restoreSharedTripResults(
  params: URLSearchParams,
  signal?: AbortSignal,
  isStale: () => boolean = () => false,
): Promise<boolean> {
  if (!activeCity) return false
  const cityCode = activeCity.code
  const fromPlaceId = params.get('from')
  const toPlaceId = params.get('to')
  if (!fromPlaceId || !toPlaceId || fromPlaceId === toPlaceId) return false
  const [from, to] = await Promise.all([
    mapApi.place(cityCode, fromPlaceId, signal),
    mapApi.place(cityCode, toPlaceId, signal),
  ])
  if (signal?.aborted || isStale() || activeCity?.code !== cityCode) return false
  tripController.begin(
    { place: from, coordinate: [from.latitude, from.longitude] },
    { place: to, coordinate: [to.latitude, to.longitude] },
  )
  const currentState = history.state && typeof history.state === 'object' ? history.state : {}
  history.replaceState({ ...currentState, mapView: 'trip-results', mapParent: 'catalogue' }, '', location.href)
  await tripController.loadPlan()
  return true
}


async function openAutoPreviewPlace(place: NearbyPlace) {
  if (!activeCity) return
  cancelLocationHydration()
  const currentState = historyRecord()
  const parent = readMapView(currentState) ?? mapViewFromUrl()
  history.pushState({
    ...currentState,
    mapView: 'place',
    mapParent: parent,
  }, '', `/map?city=${encodeURIComponent(activeCity.code)}&place=${encodeURIComponent(place.placeId)}`)
  interactionMode = 'nearby'
  await placeRoutes.open(place)
}

async function openNearbyPlace(place: NearbyPlace) {
  if (!activeCity) return
  cancelLocationHydration()
  const currentState = history.state && typeof history.state === 'object' ? history.state : {}
  history.pushState({
    ...currentState,
    mapView: 'place',
    mapParent: 'nearby',
  }, '', `/map?city=${encodeURIComponent(activeCity.code)}&place=${encodeURIComponent(place.placeId)}`)
  camera.focusPoint([place.latitude, place.longitude], map.getZoom(), { animate: true })
  await placeRoutes.open(place)
}

function returnToNearbyPlaces() {
  if (history.state?.mapView === 'place' && history.state?.mapParent) {
    history.back()
    return
  }
  renderNearbyPlaces()
}

function placeBackLabel(): string {
  if (history.state?.mapParent === 'catalogue') return '返回路線列表'
  if (history.state?.mapParent === 'route') return '返回路線'
  return '附近站牌'
}

function directionFavoriteControl(place: NearbyPlace, route: PlaceRoute): HTMLButtonElement {
  const control = document.createElement('button')
  control.className = 'favorite-direction-button'
  const bus: FavoriteBus = {
    city: activeCity?.code,
    routeName: route.routeName,
    routeUid: route.routeUid,
    subRouteUid: route.subRouteUid,
    patternId: route.variantKey,
    stopName: route.stopName,
    stopUid: route.stopUid,
    direction: route.direction,
    directionLabel: route.label,
  }
  let selected = activeCity ? isHomeDirection(activeCity.code, place.placeId, bus) : false

  const render = () => {
    control.textContent = '⌂'
    control.title = selected ? '從首頁移除這個方向' : '將這個方向加入首頁'
    control.setAttribute('aria-label', control.title)
    control.setAttribute('aria-pressed', String(selected))
    control.classList.toggle('selected', selected)
  }

  control.addEventListener('click', () => {
    if (!activeCity) return
    // 封面只留一個地圖站點:加入時會移除其他站點的地圖收藏,
    // 這件事必須講出來,不能讓使用者之後才發現收藏「憑空消失」。
    const replaced = readBoards().find((board) =>
      board.placeId && !(board.city === activeCity!.code && board.placeId === place.placeId))
    selected = toggleHomeDirection(activeCity.code, place, { ...bus, city: activeCity.code })
    render()
    if (selected) {
      setStatus(replaced
        ? `封面改為顯示「${place.name}」，原本的「${replaced.title}」已移除`
        : `已將「${place.name}」的這個方向加入首頁`)
    } else {
      setStatus('已從首頁移除這個方向')
    }
  })
  render()
  return control
}

function completePlaceRoutes({ cityCode, place }: PlaceRoutesPresentation): void {
  drawTripEndpoints()
  const currentState = history.state && typeof history.state === 'object' ? history.state : {}
  history.replaceState({ ...currentState, mapView: 'place' }, '', `/map?city=${cityCode}&place=${encodeURIComponent(place.placeId)}`)
  setDocumentTitle(`${place.name} 到站時間`)
  clearStatus()
}

function setStatus(text: string, error = false) {
  mapStatus.set(text, error)
}

function clearStatus() {
  mapStatus.clear()
}

// 跟著畫面更新分頁標題:多分頁與瀏覽紀錄裡才認得出「哪一條路線、哪一站」。
function setDocumentTitle(prefix?: string) {
  document.title = prefix ? `${prefix}｜Mochi Bus` : '公車地圖｜Mochi Bus'
}

function fitRegionCities(region: (typeof regions)[number], regionCities: MapCity[]) {
  const bounds = L.latLngBounds([])
  regionCities.forEach((city) => bounds.extend(city.center))
  if (!bounds.isValid()) {
    camera.focusPoint(region.center, overviewMaxZoom(region.maxZoom))
    return
  }
  camera.focusBounds(bounds, { maxZoom: () => overviewMaxZoom(region.maxZoom) })
}

function requiredElement<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(`Missing #${id}`)
  return element as T
}

// SSR 內嵌靜態縣市清單,initialise() 就不用先打一次 /api/v1/map/cities 才能
// 開始還原 URL——省下的那趟往返正是深連結會先閃過總覽殼的主因之一。
function readBootstrapCities(): MapCity[] {
  try {
    const node = document.getElementById('map-bootstrap') as HTMLScriptElement | null
    const raw = node?.textContent
    if (!raw) return []
    const parsed = JSON.parse(raw) as { cities?: unknown }
    return Array.isArray(parsed.cities) ? parsed.cities as MapCity[] : []
  } catch { return [] }
}
