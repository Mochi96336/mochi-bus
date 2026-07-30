import L, { type GeoJSON as LeafletGeoJSON } from 'leaflet'
import type { DrawerView, DrawerViewSession } from './drawer-view'
import { routeVariantsDrawerSize, timetableDrawerSize } from './drawer-content-size'
import type {
  RouteMapVariant,
  RouteTimetable,
  TimetableStop,
  VehiclePosition,
} from './map-api-client'
import { tooltipText } from './leaflet-tooltip'
import { createTimetablePanel } from './timetable-view'
import type { PreviewStopDotManager, SelectablePreviewLineRenderer } from './preview-map-primitives'
import {
  initialRouteStopMarkerMetrics,
  normalizedVehicleAzimuth,
  routeStopMarkerMetrics,
  routeVariantPreviewStyle,
  vehicleInfoText,
} from './route-detail-presentation'
import {
  routeCasingColor,
  routePalette,
  stopFillAccent,
  stopFillGreen,
  stopHaloColor,
} from './theme'
import './vehicle-info.css'

type BindHoverTooltip = <T extends L.Layer>(
  layer: T,
  content: string,
  options?: L.TooltipOptions,
) => T

type RouteDetailSurfaceOptions = {
  map: L.Map
  routeLayer: L.LayerGroup
  previewLayer: L.LayerGroup
  selectionLayer: L.LayerGroup
  vehicleLayer: L.LayerGroup
  renderDrawer: (view: DrawerView) => DrawerViewSession
  focusBounds: (bounds: L.LatLngBounds) => void
  focusPoint: (position: L.LatLngExpression, zoom: number) => void
  bindHoverTooltip: BindHoverTooltip
  selectablePreviewLine: SelectablePreviewLineRenderer
  previewStopDots: PreviewStopDotManager
  drawerBack: (label: string, onClick: () => void) => HTMLButtonElement
  heading: (title: string, description: string) => HTMLElement
  paragraph: (text: string) => HTMLElement
  retryButton: (onClick: () => void) => HTMLButtonElement
}

type VariantPickerOptions = {
  cityCode: string
  routeName: string
  variants: RouteMapVariant[]
  backLabel: string
  onBack: () => void
  onSelect: (variant: RouteMapVariant) => void
}

type RouteViewOptions = {
  cityCode: string
  variant: RouteMapVariant
  color: string
  backLabel: string
  onBack: () => void
  onStopSelect: (latitude: number, longitude: number) => void
}

type TimetableViewOptions = {
  cityCode: string
  variant: RouteMapVariant
  timetable: RouteTimetable
  onBack: () => void
  onSelectStop: (stopUid: string) => void
}

type RouteLoadingViewOptions = {
  cityCode: string
  routeName: string
  backLabel: string
  onBack: () => void
}

type RouteErrorViewOptions = RouteLoadingViewOptions & {
  message: string
  onRetry: () => void
}

export type RouteDetailSurface = {
  showRouteLoading(options: RouteLoadingViewOptions): void
  showRouteError(options: RouteErrorViewOptions): void
  showVariantPicker(options: VariantPickerOptions): void
  showRoute(options: RouteViewOptions): HTMLButtonElement
  showTimetableLoading(cityCode: string, variant: RouteMapVariant, stopUid: string | undefined, onBack: () => void): void
  showTimetableError(cityCode: string, variant: RouteMapVariant, stopUid: string | undefined, message: string, onBack: () => void, onRetry: () => void): void
  showTimetable(options: TimetableViewOptions): { available: boolean }
  renderVehicles(vehicles: VehiclePosition[]): void
  clearRoute(): void
  clearSelection(): void
  clearVehicles(): void
  resizeStopMarkers(): void
}

export function createRouteDetailSurface(options: RouteDetailSurfaceOptions): RouteDetailSurface {
  let stopMarkers: L.CircleMarker[] = []
  let selectedVehiclePlate: string | null = null
  let clearingVehicleMarkers = false
  const vehicleHoverCapable = window.matchMedia('(hover: hover)').matches
  const vehiclePopup = L.popup({
    className: 'vehicle-popup',
    closeButton: false,
    offset: [0, -8],
  })
  vehiclePopup.on('remove', () => {
    if (!clearingVehicleMarkers) selectedVehiclePlate = null
  })

  function createStopMarker(
    position: L.LatLngExpression,
    prominent = false,
    fillColor = stopFillGreen,
  ): L.CircleMarker {
    const metrics = initialRouteStopMarkerMetrics(options.map.getZoom(), prominent)
    return L.circleMarker(position, {
      pane: 'stopPane',
      radius: metrics.radius,
      color: stopHaloColor,
      weight: metrics.weight,
      fillColor,
      fillOpacity: .96,
    })
  }

  function clearRoute(): void {
    options.routeLayer.clearLayers()
    stopMarkers = []
  }

  function clearSelection(): void {
    options.selectionLayer.clearLayers()
  }

  function clearVehicleLayer(preservePopupSelection: boolean): void {
    const selectedPlate = preservePopupSelection ? selectedVehiclePlate : null
    clearingVehicleMarkers = true
    try {
      vehiclePopup.remove()
      options.vehicleLayer.clearLayers()
    } finally {
      clearingVehicleMarkers = false
      selectedVehiclePlate = selectedPlate
    }
  }

  function clearVehicles(): void {
    clearVehicleLayer(false)
  }

  function showRouteLoading(view: RouteLoadingViewOptions): void {
    options.renderDrawer({
      key: `route:${view.cityCode}:${view.routeName}`,
      mode: 'compact',
      size: 'compact',
      content: [
        options.drawerBack(view.backLabel, view.onBack),
        options.heading(view.routeName, '正在拼起路線與站牌…'),
      ],
    })
  }

  function showRouteError(view: RouteErrorViewOptions): void {
    options.renderDrawer({
      key: `route:${view.cityCode}:${view.routeName}`,
      mode: 'compact',
      size: 'compact',
      content: [
        options.drawerBack(view.backLabel, view.onBack),
        options.heading(view.routeName, view.message),
        options.retryButton(view.onRetry),
      ],
    })
  }

  function showVariantPicker(view: VariantPickerOptions): void {
    options.previewStopDots.reset()
    options.previewLayer.clearLayers()
    clearRoute()
    const bounds = L.latLngBounds([])
    const previewsByKey = new Map<string, { line: LeafletGeoJSON; style: L.PathOptions }>()

    view.variants.map((variant, index) => ({ variant, index })).reverse().forEach(({ variant, index }) => {
      const color = routePalette[index % routePalette.length]
      const style = routeVariantPreviewStyle(color, index)
      const { line, target } = options.selectablePreviewLine(variant.shape, 'routePreviewPane', options.previewLayer, style)
      options.previewStopDots.add(variant.stops, color, options.previewLayer)
      options.bindHoverTooltip(target, `${variant.label} · ${variant.subRouteName}`, { sticky: true })
      target.on('mouseover', () => {
        line.setStyle({ ...style, weight: 8, opacity: .9 })
        line.bringToFront()
      })
      target.on('mouseout', () => {
        line.setStyle(style)
        if (index !== 0) previewsByKey.get(view.variants[0].variantKey)?.line.bringToFront()
      })
      target.on('click', (event) => {
        L.DomEvent.stopPropagation(event)
        view.onSelect(variant)
      })
      previewsByKey.set(variant.variantKey, { line, style })
      bounds.extend(line.getBounds())
    })

    const list = document.createElement('div')
    list.className = 'variant-list'
    list.replaceChildren(...view.variants.map((variant, index) => {
      const button = document.createElement('button')
      button.className = 'variant-button'
      button.style.setProperty('--route-color', routePalette[index % routePalette.length])
      const strong = document.createElement('strong')
      strong.textContent = variant.label
      button.appendChild(strong)
      if (variant.subRouteName && variant.subRouteName !== variant.routeName) {
        const small = document.createElement('span')
        small.textContent = variant.subRouteName
        button.appendChild(small)
      }
      button.addEventListener('click', () => view.onSelect(variant))
      button.addEventListener('mouseenter', () => {
        const preview = previewsByKey.get(variant.variantKey)
        preview?.line.setStyle({ ...preview.style, weight: 8, opacity: .9 })
        preview?.line.bringToFront()
      })
      button.addEventListener('mouseleave', () => {
        const preview = previewsByKey.get(variant.variantKey)
        preview?.line.setStyle(preview.style)
        if (variant.variantKey !== view.variants[0].variantKey) {
          previewsByKey.get(view.variants[0].variantKey)?.line.bringToFront()
        }
      })
      return button
    }))

    options.renderDrawer({
      key: `route-variants:${view.cityCode}:${view.routeName}`,
      mode: 'map-list',
      size: routeVariantsDrawerSize(view.variants.length),
      header: [
        options.drawerBack(view.backLabel, view.onBack),
        options.heading(view.routeName, '同一路線可能穿過不同街廓，點線或點列表選一條。'),
      ],
      content: [list],
    })
    if (bounds.isValid()) options.focusBounds(bounds)
  }

  function showRoute(view: RouteViewOptions): HTMLButtonElement {
    clearRoute()
    clearSelection()
    const casing = L.geoJSON(view.variant.shape, {
      pane: 'routePane',
      style: { color: routeCasingColor, weight: 11, opacity: .95, lineCap: 'round', lineJoin: 'round' },
    }).addTo(options.routeLayer)
    L.geoJSON(view.variant.shape, {
      pane: 'routePane',
      style: { color: view.color, weight: 5, opacity: 1, lineCap: 'round', lineJoin: 'round' },
    }).addTo(options.routeLayer)
    L.geoJSON(view.variant.stops, {
      pointToLayer: (feature, latlng) => {
        const marker = options.bindHoverTooltip(
          createStopMarker(latlng),
          `${feature.properties.sequence}. ${feature.properties.stopName}`,
          { direction: 'top', offset: [0, -5] },
        ).on('click', (event) => {
          L.DomEvent.stopPropagation(event)
          view.onStopSelect(latlng.lat, latlng.lng)
        })
        stopMarkers.push(marker)
        return marker
      },
    }).addTo(options.routeLayer)

    const timetableSummary = document.createElement('button')
    timetableSummary.type = 'button'
    timetableSummary.className = 'route-service-summary pending'
    timetableSummary.textContent = '正在讀取時刻…'
    timetableSummary.disabled = true
    options.renderDrawer({
      key: `route:${view.cityCode}:${view.variant.routeName}`,
      mode: 'compact',
      size: 'compact',
      content: [
        options.drawerBack(view.backLabel, view.onBack),
        options.heading(view.variant.routeName, `${view.variant.label} · ${view.variant.stops.features.length} 站`),
        ...(view.variant.subRouteName && view.variant.subRouteName !== view.variant.routeName
          ? [options.paragraph(view.variant.subRouteName)]
          : []),
        timetableSummary,
      ],
    })
    const bounds = casing.getBounds()
    if (bounds.isValid()) options.focusBounds(bounds)
    return timetableSummary
  }

  function showTimetableLoading(
    cityCode: string,
    variant: RouteMapVariant,
    stopUid: string | undefined,
    onBack: () => void,
  ): void {
    options.renderDrawer({
      key: `timetable:${cityCode}:${variant.variantKey}:${stopUid ?? ''}`,
      mode: 'timetable',
      size: 'standard',
      header: [
        options.drawerBack(`返回 ${variant.routeName}`, onBack),
        options.heading(variant.routeName, `時刻 · ${variant.label}`),
      ],
      content: [options.paragraph('正在整理表定班次…')],
    })
  }

  function showTimetableError(
    cityCode: string,
    variant: RouteMapVariant,
    stopUid: string | undefined,
    message: string,
    onBack: () => void,
    onRetry: () => void,
  ): void {
    options.renderDrawer({
      key: `timetable:${cityCode}:${variant.variantKey}:${stopUid ?? ''}`,
      mode: 'timetable',
      size: 'compact',
      header: [
        options.drawerBack(`返回 ${variant.routeName}`, onBack),
        options.heading(variant.routeName, message),
      ],
      content: [options.retryButton(onRetry)],
    })
  }

  function focusTimetableStop(variant: RouteMapVariant, stop: Omit<TimetableStop, 'hasTimes'>): void {
    clearSelection()
    const feature = variant.stops.features.find((candidate) => candidate.properties.stopUid === stop.stopUid)
    if (!feature) return
    const [longitude, latitude] = feature.geometry.coordinates
    options.focusPoint([latitude, longitude], 15)
    const marker = createStopMarker([latitude, longitude], true, stopFillAccent).addTo(options.selectionLayer)
    marker.getElement()?.classList.add('timetable-stop-focus')
    marker.getElement()?.setAttribute('data-stop-uid', stop.stopUid)
  }

  function showTimetable(view: TimetableViewOptions): { available: boolean } {
    const available = view.timetable.mode !== 'none' && view.timetable.services.length > 0
    if (!available) {
      const panel = document.createElement('div')
      panel.className = 'timetable-panel'
      panel.appendChild(options.paragraph('這個方向目前沒有公開的表定班次資料。'))
      options.renderDrawer({
        key: `timetable:${view.cityCode}:${view.variant.variantKey}:${view.timetable.selectedStop?.stopUid ?? ''}`,
        mode: 'timetable',
        size: 'compact',
        header: [
          options.drawerBack(`返回 ${view.variant.routeName}`, view.onBack),
          options.heading(view.variant.routeName, `時刻 · ${view.variant.label}`),
        ],
        content: [panel],
      })
      return { available: false }
    }

    const panel = createTimetablePanel(view.timetable, view.onSelectStop)
    options.renderDrawer({
      key: `timetable:${view.cityCode}:${view.variant.variantKey}:${view.timetable.selectedStop?.stopUid ?? ''}`,
      mode: 'timetable',
      size: timetableDrawerSize(view.timetable),
      header: [
        options.drawerBack(`返回 ${view.variant.routeName}`, view.onBack),
        options.heading(view.variant.routeName, `時刻 · ${view.variant.label}`),
      ],
      content: [panel],
    })
    if (view.timetable.mode === 'stop' && view.timetable.selectedStop) {
      queueMicrotask(() => focusTimetableStop(view.variant, view.timetable.selectedStop!))
    } else {
      clearSelection()
    }
    return { available: true }
  }

  function openVehiclePopup(marker: L.Marker, plate: string | null, content: string): void {
    vehiclePopup
      .setLatLng(marker.getLatLng())
      .setContent(tooltipText(content))
      .openOn(options.map)
    selectedVehiclePlate = plate
  }

  function bindVehicleInformation(marker: L.Marker, vehicle: VehiclePosition, content: string): L.Marker {
    marker.on('add', () => marker.getElement()?.setAttribute('aria-label', content))
    if (vehicleHoverCapable) return options.bindHoverTooltip(marker, content)

    const plate = vehicle.plate?.trim() || null
    marker.on('click', (event) => {
      L.DomEvent.stop((event as L.LeafletMouseEvent).originalEvent)
      openVehiclePopup(marker, plate, content)
    })
    return marker
  }

  function renderVehicles(vehicles: VehiclePosition[]): void {
    const restorePlate = selectedVehiclePlate
    clearVehicleLayer(true)
    let restoreVehicle: { marker: L.Marker; content: string } | null = null

    vehicles.forEach((vehicle) => {
      const azimuth = normalizedVehicleAzimuth(vehicle.azimuth)
      const content = vehicleInfoText(vehicle.plate, vehicle.gpsTime)
      const marker = L.marker([vehicle.latitude, vehicle.longitude], {
        pane: 'vehiclePane',
        bubblingMouseEvents: false,
        icon: L.divIcon({
          className: 'vehicle-marker-wrap',
          html: `<span class="vehicle-marker" style="transform:rotate(${azimuth}deg)"></span>`,
          iconSize: [26, 32],
          iconAnchor: [13, 16],
        }),
      })
      bindVehicleInformation(marker, vehicle, content).addTo(options.vehicleLayer)
      if (restorePlate && vehicle.plate?.trim() === restorePlate) restoreVehicle = { marker, content }
    })

    if (!vehicleHoverCapable && restorePlate) {
      if (!restoreVehicle) {
        selectedVehiclePlate = null
      } else {
        queueMicrotask(() => {
          if (options.map.hasLayer(restoreVehicle!.marker)) {
            openVehiclePopup(restoreVehicle!.marker, restorePlate, restoreVehicle!.content)
          }
        })
      }
    }
  }

  function resizeStopMarkers(): void {
    const metrics = routeStopMarkerMetrics(options.map.getZoom())
    stopMarkers.forEach((marker) => marker.setStyle(metrics))
  }

  return {
    showRouteLoading,
    showRouteError,
    showVariantPicker,
    showRoute,
    showTimetableLoading,
    showTimetableError,
    showTimetable,
    renderVehicles,
    clearRoute,
    clearSelection,
    clearVehicles,
    resizeStopMarkers,
  }
}
