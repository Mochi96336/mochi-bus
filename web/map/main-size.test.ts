/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest'
import mainSource from './main.ts?raw'
import journeyPreviewSource from './journey-preview-controller.ts?raw'
import journeyPreviewMapSource from './journey-preview-map.ts?raw'
import previewMapPrimitivesSource from './preview-map-primitives.ts?raw'
import placeRoutesSource from './place-routes-controller.ts?raw'
import placeRoutesViewSource from './place-routes-view.ts?raw'
import nearbyPlacesSource from './nearby-places-controller.ts?raw'
import nearbyPlacesMapSource from './nearby-places-map.ts?raw'
import nearbyResultsStateSource from './nearby-results-state.ts?raw'
import nearbyPlacesViewSource from './nearby-places-view.ts?raw'
import routeDetailSurfaceSource from './route-detail-surface.ts?raw'

const MAP_MAIN_LINE_LIMIT = 1792

const TRIP_TRANSITION_CALLS = [
  'trip.start(',
  'trip.reset(',
  'trip.clearPending(',
  'trip.focus(',
  'trip.reselect(',
  'trip.selectEndpoint(',
  'trip.setPending(',
  'trip.setWarning(',
  'trip.completeDirect(',
  'trip.completeTransfer(',
  'trip.completeEmpty(',
  'trip.selectDirect(',
  'trip.selectTransfer(',
  'trip.begin(',
  'trip.restore(',
]

function functionSection(source: string, name: string, nextName: string): string {
  const start = source.indexOf(`function ${name}(`)
  const end = source.indexOf(`function ${nextName}(`, start)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('map main architecture boundary', () => {
  it('does not grow without extracting another responsibility', () => {
    const lineCount = mainSource.split(/\r?\n/).length
    expect(lineCount).toBeLessThanOrEqual(MAP_MAIN_LINE_LIMIT)
  })

  it('delegates Trip preview orchestration to the Journey preview controller', () => {
    expect(mainSource).toContain('createJourneyPreviewController')
    expect(mainSource).not.toContain('function previewDirectRoutes(')
    expect(mainSource).not.toContain('function previewTransferPlans(')
    expect(mainSource).not.toContain('selectDirectPreviewEntries')
    for (const dependency of ['leaflet', 'history.', 'document.', 'window.', 'mapApi.', 'camera.']) {
      expect(journeyPreviewSource).not.toContain(dependency)
    }
  })

  it('delegates Leaflet Trip preview drawing to the Journey preview map surface', () => {
    expect(mainSource).toContain('createJourneyPreviewMap')
    expect(mainSource).not.toContain('function renderJourneyPreviewLeg(')
    expect(mainSource).not.toContain('getJourneySegmentCoordinates')
    for (const dependency of ['mapApi.', 'history.', 'camera.', 'trip.', 'document.', 'window.', 'loadVariant']) {
      expect(journeyPreviewMapSource).not.toContain(dependency)
    }
  })

  it('shares low-level preview lines and stop dots through preview map primitives', () => {
    expect(mainSource).toContain('createSelectablePreviewLineRenderer')
    expect(mainSource).toContain('createPreviewStopDotManager')
    expect(mainSource).not.toContain('function bindSelectableLine(')
    expect(mainSource).not.toContain('function addPreviewStopDots(')
    expect(mainSource).not.toContain('new Set<L.CircleMarker>()')
    expect(journeyPreviewMapSource).not.toContain('function bindSelectableLine(')
    expect(journeyPreviewMapSource).not.toContain('function addStopDots(')
    expect(journeyPreviewMapSource).not.toContain('previewDotStyleForZoom')
    expect(routeDetailSurfaceSource).toContain('SelectablePreviewLineRenderer')
    expect(routeDetailSurfaceSource).toContain('PreviewStopDotManager')
    for (const source of [mainSource, journeyPreviewMapSource, routeDetailSurfaceSource]) {
      expect(source).not.toContain('weight: 26')
      expect(source).not.toContain("'preview-stop-dot'")
    }
    expect(previewMapPrimitivesSource).toContain('weight: touchHitWeight')
    expect(previewMapPrimitivesSource).toContain("'preview-stop-dot'")
    for (const dependency of [
      'mapApi.',
      'history.',
      'camera.',
      'trip.',
      'document.',
      'window.',
      'loadVariant',
      'journey-preview',
      'route-detail',
      './main',
    ]) {
      expect(previewMapPrimitivesSource).not.toContain(dependency)
    }
  })

  it('delegates Place route loading, ranking, and preview completion to the Place routes controller', () => {
    expect(mainSource).toContain('createPlaceRoutesController')
    expect(mainSource).not.toContain('async function previewPlaceRoutes(')
    expect(mainSource).not.toContain('function placeRouteRank(')
    expect(mainSource).not.toContain('beginOtherPreviewRequest')
    expect(mainSource).not.toContain('previewRequest')
    expect(mainSource).not.toContain('await mapApi.placeRoutes(')
    expect(placeRoutesSource).toContain('options.onRoutes(presentation)')
    expect(placeRoutesSource).toContain('options.onComplete(presentation)')
    expect(placeRoutesSource.indexOf('options.onComplete(presentation)'))
      .toBeLessThan(placeRoutesSource.indexOf('const previewTasks'))
    expect(placeRoutesSource).toContain('options.renderPreview(preview)')
    for (const dependency of [
      'leaflet',
      'history.',
      'document.',
      'window.',
      'camera.',
      'trip.',
      'drawer',
      'readBoards',
      'mapApi.',
      'journey-preview',
      'route-detail',
      './main',
      'AbortController',
      'setStatus(',
      'renderDrawer(',
      'isTdxTokenRejectedError',
      'tdxWarningMessages',
      'toggleFavoriteDirection',
    ]) {
      expect(placeRoutesSource).not.toContain(dependency)
    }
  })

  it('keeps place selection and route completion camera ownership separate', () => {
    const autoPreview = functionSection(mainSource, 'openAutoPreviewPlace', 'openNearbyPlace')
    const manualSelection = functionSection(mainSource, 'openNearbyPlace', 'returnToNearbyPlaces')
    const completion = functionSection(mainSource, 'completePlaceRoutes', 'setStatus')

    expect(autoPreview).not.toContain('camera.focusPoint(')
    expect(manualSelection).toContain('camera.focusPoint(')
    expect(manualSelection.indexOf('camera.focusPoint(')).toBeLessThan(manualSelection.indexOf('placeRoutes.open(place)'))
    expect(completion).not.toContain('camera.')
  })

  it('delegates Place route Drawer presentation to the Place routes view', () => {
    expect(mainSource).toContain('createPlaceRoutesView')
    expect(mainSource).toContain('placeRoutesView.renderLoading(start)')
    expect(mainSource).toContain('onRoutes: placeRoutesView.renderRoutes')
    expect(mainSource).toContain('placeRoutesView.renderError(failure)')
    expect(mainSource).not.toContain('function renderPlaceRoutesLoading(')
    expect(mainSource).not.toContain('function renderPlaceRoutes(')
    expect(mainSource).not.toContain('function renderPlaceRoutesError(')
    expect(mainSource).not.toContain('function etaPresentationNode(')
    for (const marker of [
      "className = 'place-route-list'",
      "className = 'place-route-row'",
      "className = 'place-route-button'",
      "className = 'place-route-main'",
      "className = 'eta-freshness'",
    ]) {
      expect(mainSource).not.toContain(marker)
    }
    expect(placeRoutesViewSource).toContain('createPlaceRoutesView')
    expect(placeRoutesViewSource).toContain("className = 'place-route-list'")
    expect(placeRoutesViewSource).toContain('options.createFavoriteControl(place, route)')
    expect(placeRoutesViewSource).toContain('options.onOpenRoute(')
    expect(placeRoutesViewSource).toContain('options.onRetry(place)')
    expect(placeRoutesViewSource).toContain('etaPresentation(route.etaLabel')
    expect(placeRoutesViewSource).toContain('tdxWarningMessages[warning]')
    for (const dependency of [
      'leaflet',
      'history.',
      'camera.',
      'trip.',
      'mapApi.',
      'routeDetail',
      'readBoards',
      'toggleFavoriteDirection',
      'isFavoriteDirection',
      'placeRoutes.open',
      'setStatus(',
      'clearStatus(',
      'createPlaceRoutesController',
      'boards/store',
      './main',
    ]) {
      expect(placeRoutesViewSource).not.toContain(dependency)
    }
  })

  it('delegates Nearby Places loading and request lifecycle to the Nearby places controller', () => {
    expect(mainSource).toContain('createNearbyPlacesController')
    expect(mainSource).toContain('await nearbyPlaces.load({')
    expect(mainSource).toContain("onRetry: () => void findNearbyPlaces(origin[0], origin[1], previewSource, 'replace')")
    expect(mainSource).toContain("findNearbyPlaces(latitude, longitude, 'route-stop')")
    expect(mainSource).toContain("findNearbyPlaces(event.latlng.lat, event.latlng.lng, 'map')")
    expect(mainSource).toContain('nearbyPlaces.invalidate()')
    expect(mainSource).not.toContain('nearbyPlaces.retry()')
    expect(nearbyPlacesSource).not.toContain('lastRequest')
    expect(nearbyPlacesSource).not.toContain('retry():')
    expect(mainSource).not.toContain('await mapApi.nearby(')
    expect(mainSource).not.toContain('places.slice(0, 12)')
    expect(nearbyPlacesSource).toContain('loaded.slice(0, placeLimit)')
    expect(nearbyPlacesSource).toContain('options.onAutoPreview(')
    expect(nearbyPlacesSource).toContain('options.onError({ ...request, error })')
    expect(nearbyPlacesSource).toContain('options.currentCityCode() === cityCode')
    expect(nearbyPlacesSource).toContain('!options.isStaleRequest(requestId)')
    for (const dependency of [
      'leaflet', 'history.', 'document.', 'window.', 'mapApi.', 'camera.', 'trip.',
      'routeDetail', 'cityNetwork', 'nearbyLayer', 'setStatus(', 'clearStatus(',
      'setDocumentTitle', 'historyRecord', 'readMapView', 'mapViewFromUrl',
      'openNearbyPlace', 'findNearbyPlaces', 'renderNearbyPlaces', './main',
    ]) expect(nearbyPlacesSource).not.toContain(dependency)
  })

  it('delegates Nearby Places Leaflet drawing to the Nearby places map surface', () => {
    expect(mainSource).toContain('createNearbyPlacesMap')
    expect(mainSource).toContain('nearbyPlacesMap.renderLoadingOrigin(origin)')
    expect(mainSource).toContain('createNearbyResultsState')
    expect(nearbyResultsStateSource).toContain('options.renderPlaces(origin, places)')
    expect(nearbyResultsStateSource).toContain('options.renderEndpoints()')
    expect(mainSource).not.toContain("bindHoverTooltip(origin, '你點的位置')")
    expect(mainSource).not.toContain('Math.round(place.distanceMeters)')
    expect(nearbyPlacesMapSource).toContain("bindHoverTooltip(originMarker, '你點的位置')")
    expect(nearbyPlacesMapSource).toContain('Math.round(place.distanceMeters)')
    expect(nearbyPlacesMapSource).toContain('L.DomEvent.stopPropagation(event)')
    expect(nearbyPlacesMapSource).toContain('options.onOpenPlace(place)')
    expect(mainSource).toContain('drawTripEndpoints()')
    for (const dependency of [
      'history.', 'document.', 'window.', 'mapApi.', 'camera.', 'trip.', 'routeDetail',
      'cityNetwork', 'beginNavRequest', 'isStaleNav', 'setStatus(', 'clearStatus(',
      'setDocumentTitle', 'historyRecord', 'readMapView', 'mapViewFromUrl',
      'findNearbyPlaces', 'renderNearbyPlaces', './main',
    ]) expect(nearbyPlacesMapSource).not.toContain(dependency)
  })

  it('delegates Nearby Places Drawer presentation to the Nearby places view', () => {
    expect(mainSource).toContain('createNearbyPlacesView')
    expect(mainSource).toContain('nearbyPlacesView.renderLoading({')
    expect(mainSource).toContain('nearbyPlacesView.renderPlaces({')
    expect(mainSource).toContain('nearbyPlacesView.renderError({')
    expect(mainSource).toContain('onOpenPlace: (place) => void openNearbyPlace(place)')
    const renderPlacesIndex = mainSource.indexOf('nearbyPlacesView.renderPlaces({')
    expect(mainSource.indexOf('clearStatus()', renderPlacesIndex)).toBeGreaterThan(renderPlacesIndex)
    expect(mainSource.indexOf('history.replaceState', renderPlacesIndex)).toBeGreaterThan(renderPlacesIndex)
    expect(mainSource.indexOf('setDocumentTitle', renderPlacesIndex)).toBeGreaterThan(renderPlacesIndex)
    for (const marker of [
      "className = 'nearby-list'",
      "className = 'nearby-place-button'",
      '正在搜尋附近站牌',
      '500 公尺內沒有收錄到站牌',
      '附近站牌讀取失敗',
    ]) expect(mainSource).not.toContain(marker)
    expect(nearbyPlacesViewSource).toContain('createNearbyPlacesView')
    expect(nearbyPlacesViewSource).toContain("className = 'nearby-list'")
    expect(nearbyPlacesViewSource).toContain('options.onOpenPlace(place)')
    expect(nearbyPlacesViewSource).toContain('options.createRetryButton(onRetry)')
    expect(nearbyPlacesViewSource).toContain('options.createTripModeButton()')
    expect(nearbyPlacesViewSource).toContain('drawerKey(cityCode, origin)')
    expect(nearbyPlacesViewSource).toContain('options.createBackButton(backLabel, onBack)')
    for (const dependency of [
      'leaflet', 'history.', 'window.', 'mapApi.', 'camera.', 'trip.', 'routeDetail',
      'cityNetwork', 'nearbyLayer', 'beginNavRequest', 'isStaleNav', 'setStatus(',
      'clearStatus(', 'setDocumentTitle', 'historyRecord', 'readMapView', 'mapViewFromUrl',
      'openNearbyPlace', 'findNearbyPlaces', 'renderNearbyPlaces', './main',
    ]) expect(nearbyPlacesViewSource).not.toContain(dependency)
  })

  it('delegates Trip result Drawer construction to the Trip results view', () => {
    expect(mainSource).toContain('createTripResultsView')
    expect(mainSource).not.toContain("className = 'direct-route-list'")
    expect(mainSource).not.toContain("className = 'transfer-plan-list'")
    expect(mainSource).not.toContain('function renderDirectRoutes(')
    expect(mainSource).not.toContain('function renderTransferPlans(')
  })

  it('delegates Trip state transitions to the Trip controller', () => {
    expect(mainSource).toContain('createTripController')
    for (const call of TRIP_TRANSITION_CALLS) expect(mainSource).not.toContain(call)
  })
})
