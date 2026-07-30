import type L from 'leaflet'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const panConstraint = vi.hoisted(() => {
  const releaseForProgrammaticCamera = vi.fn()
  const dispose = Object.assign(vi.fn(), { releaseForProgrammaticCamera })
  return { releaseForProgrammaticCamera, dispose, constrain: vi.fn(() => dispose) }
})

vi.mock('./map-pan-bounds', () => ({
  constrainMapPanToTaiwan: panConstraint.constrain,
}))
vi.mock('leaflet', () => ({
  default: { DomEvent: { stopPropagation: vi.fn() } },
}))
vi.mock('./leaflet-tooltip', () => ({ bindTextTooltip: <T>(layer: T): T => layer }))

import { createMapCameraController } from './camera-controller'
import type { NearbyPlace } from './map-api-client'
import { publishNearbyCameraCancel } from './nearby-map-events'
import { createNearbyPlacesMap } from './nearby-places-map'

type Rect = {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

function element(rect: Rect): HTMLElement {
  return Object.assign(new EventTarget(), {
    getBoundingClientRect: () => rect,
  }) as unknown as HTMLElement
}

function point(x: number, y: number): L.Point {
  return {
    x,
    y,
    add(other: L.PointExpression) {
      const value = Array.isArray(other) ? { x: other[0], y: other[1] } : other as L.Point
      return point(x + value.x, y + value.y)
    },
    distanceTo(other: L.PointExpression) {
      const value = Array.isArray(other) ? { x: other[0], y: other[1] } : other as L.Point
      return Math.hypot(x - value.x, y - value.y)
    },
  } as L.Point
}

function latLng(value: L.LatLngExpression): { lat: number; lng: number } {
  if (Array.isArray(value)) return { lat: value[0], lng: value[1] }
  if ('lat' in value) return { lat: value.lat, lng: value.lng }
  return { lat: 0, lng: 0 }
}

function createMapStub(order: string[]): L.Map {
  const center = { lat: 23.5, lng: 121 }
  const zoom = 12
  return {
    fitBounds: vi.fn(() => order.push('fitBounds')),
    flyTo: vi.fn(() => order.push('flyTo')),
    // Keep the center unchanged to model a real Leaflet pan that is still in flight.
    panTo: vi.fn(() => order.push('panTo')),
    stop: vi.fn(() => order.push('stop')),
    setView: vi.fn(() => order.push('setView')),
    panBy: vi.fn(() => order.push('panBy')),
    project: vi.fn((value: L.LatLngExpression) => {
      const projected = latLng(value)
      return point(projected.lng * 100, projected.lat * 100)
    }),
    unproject: vi.fn((value: L.PointExpression) => {
      const projected = Array.isArray(value) ? { x: value[0], y: value[1] } : value as L.Point
      return { lat: projected.y / 100, lng: projected.x / 100 }
    }),
    getCenter: vi.fn(() => center),
    getZoom: vi.fn(() => zoom),
    invalidateSize: vi.fn(),
  } as unknown as L.Map
}

class FakeLayerGroup {
  markers: FakeMarker[] = []
  clearLayers(): this {
    this.markers = []
    return this
  }
}

class FakeMarker {
  addTo(layer: FakeLayerGroup): this {
    layer.markers.push(this)
    return this
  }

  on(): this {
    return this
  }
}

function createNearbySurface() {
  const layer = new FakeLayerGroup()
  return createNearbyPlacesMap({
    layer: layer as unknown as L.LayerGroup,
    hoverCapable: false,
    createStopMarker: () => new FakeMarker() as unknown as L.CircleMarker,
    onOpenPlace: () => undefined,
  })
}

function place(latitude = 25.001, longitude = 121.501): NearbyPlace {
  return {
    placeId: 'PLACE',
    name: '測試站牌',
    latitude,
    longitude,
    distanceMeters: 100,
  }
}

describe('nearby camera transition lifecycle', () => {
  beforeEach(() => {
    const browserWindow = Object.assign(new EventTarget(), {
      requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
        callback(0)
        return 1
      }),
      cancelAnimationFrame: vi.fn(),
      matchMedia: vi.fn(() => ({ matches: false })),
      visualViewport: undefined,
    })
    class ResizeObserverStub {
      observe = vi.fn()
      disconnect = vi.fn()
    }
    vi.stubGlobal('window', browserWindow)
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)
    panConstraint.releaseForProgrammaticCamera.mockReset()
    panConstraint.dispose.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not reuse a failed pointer transition for a non-pointer retry', () => {
    const order: string[] = []
    const map = createMapStub(order)
    const mapElement = element({ left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800 })
    const drawerElement = element({ left: 1200, top: 0, right: 1200, bottom: 800, width: 0, height: 800 })
    panConstraint.releaseForProgrammaticCamera.mockImplementation(() => order.push('release'))
    const controller = createMapCameraController(map, mapElement, drawerElement)
    const nearby = createNearbySurface()

    mapElement.dispatchEvent(new Event('pointerdown'))
    nearby.renderLoadingOrigin([25, 121.5])
    order.length = 0

    // A drawer/URL retry publishes begin without a new map pointer. It must retire
    // the old transition even though the retry itself does not animate.
    nearby.renderLoadingOrigin([25, 121.5])
    nearby.renderPlaces([25, 121.5], [place()])

    expect(order).toEqual([])
    controller.dispose()
  })

  it('cancels the transition when the nearby result is empty', () => {
    const order: string[] = []
    const map = createMapStub(order)
    const mapElement = element({ left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800 })
    const drawerElement = element({ left: 1200, top: 0, right: 1200, bottom: 800, width: 0, height: 800 })
    const controller = createMapCameraController(map, mapElement, drawerElement)
    const nearby = createNearbySurface()

    mapElement.dispatchEvent(new Event('pointerdown'))
    nearby.renderLoadingOrigin([25, 121.5])
    order.length = 0
    nearby.renderPlaces([25, 121.5], [])
    nearby.renderPlaces([25, 121.5], [place()])

    expect(order).toEqual([])
    controller.dispose()
  })

  it('does not settle cached places after an active request fails', () => {
    const order: string[] = []
    const map = createMapStub(order)
    const mapElement = element({ left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800 })
    const drawerElement = element({ left: 1200, top: 0, right: 1200, bottom: 800, width: 0, height: 800 })
    const controller = createMapCameraController(map, mapElement, drawerElement)
    const nearby = createNearbySurface()

    mapElement.dispatchEvent(new Event('pointerdown'))
    nearby.renderLoadingOrigin([25, 121.5])
    order.length = 0

    // Active request error cancellation happens before a Back/cache render. The map
    // surface may publish a settle for its cached first place, but no transition owns it.
    publishNearbyCameraCancel()
    nearby.renderPlaces([24.5, 120.5], [place(24.501, 120.501)])

    expect(order).toEqual([])
    controller.dispose()
  })

  it('keeps an in-flight settle intact when route completion repeats its target', () => {
    const order: string[] = []
    const map = createMapStub(order)
    const mapElement = element({ left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800 })
    const drawerElement = element({ left: 1200, top: 0, right: 1200, bottom: 800, width: 0, height: 800 })
    panConstraint.releaseForProgrammaticCamera.mockImplementation(() => order.push('release'))
    const controller = createMapCameraController(map, mapElement, drawerElement)
    const nearby = createNearbySurface()
    const selected = place(26, 122.5)

    mapElement.dispatchEvent(new Event('pointerdown'))
    nearby.renderLoadingOrigin([25, 121.5])
    nearby.renderPlaces([25, 121.5], [selected])
    order.length = 0

    controller.focusPoint([selected.latitude, selected.longitude], 12)

    expect(order).toEqual([])
    controller.dispose()
  })
})
