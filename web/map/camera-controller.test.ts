import type L from 'leaflet'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const panConstraint = vi.hoisted(() => {
  const releaseForProgrammaticCamera = vi.fn()
  const dispose = Object.assign(vi.fn(), { releaseForProgrammaticCamera })
  return {
    releaseForProgrammaticCamera,
    dispose,
    constrain: vi.fn(() => dispose),
  }
})

const leaflet = vi.hoisted(() => ({
  stopPropagation: vi.fn(),
}))

vi.mock('./map-pan-bounds', () => ({
  constrainMapPanToTaiwan: panConstraint.constrain,
}))
vi.mock('leaflet', () => ({
  default: { DomEvent: { stopPropagation: leaflet.stopPropagation } },
}))
vi.mock('./leaflet-tooltip', () => ({ bindTextTooltip: <T>(layer: T): T => layer }))

import { createMapCameraController } from './camera-controller'
import type { NearbyPlace } from './map-api-client'
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

function installBrowserStubs(reducedMotion = false) {
  const browserWindow = Object.assign(new EventTarget(), {
    requestAnimationFrame: vi.fn(() => 1),
    cancelAnimationFrame: vi.fn(),
    matchMedia: vi.fn(() => ({ matches: reducedMotion })),
    visualViewport: undefined,
  })

  class ResizeObserverStub {
    observe = vi.fn()
    disconnect = vi.fn()
  }

  vi.stubGlobal('window', browserWindow)
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
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
  let center = { lat: 23.5, lng: 121 }
  let zoom = 12
  return {
    fitBounds: vi.fn(() => {
      order.push('fitBounds')
    }),
    flyTo: vi.fn((nextCenter: L.LatLngExpression, nextZoom: number) => {
      order.push('flyTo')
      center = latLng(nextCenter)
      zoom = nextZoom
    }),
    panTo: vi.fn((nextCenter: L.LatLngExpression) => {
      order.push('panTo')
      center = latLng(nextCenter)
    }),
    stop: vi.fn(() => {
      order.push('stop')
    }),
    setView: vi.fn((nextCenter: L.LatLngExpression, nextZoom: number) => {
      order.push('setView')
      center = latLng(nextCenter)
      zoom = nextZoom
    }),
    panBy: vi.fn(() => {
      order.push('panBy')
    }),
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
  private readonly listeners = new Map<string, (event: unknown) => void>()
  private radius = 10

  addTo(layer: FakeLayerGroup): this {
    layer.markers.push(this)
    return this
  }

  on(type: string, listener: (event: unknown) => void): this {
    this.listeners.set(type, listener)
    return this
  }

  getRadius(): number {
    return this.radius
  }

  setRadius(radius: number): this {
    this.radius = radius
    return this
  }

  setStyle(): this {
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

function place(latitude: number, longitude: number): NearbyPlace {
  return {
    placeId: 'PLACE',
    name: '測試站牌',
    latitude,
    longitude,
    distanceMeters: 100,
  }
}

describe('map camera controller pan-bound handoff', () => {
  beforeEach(() => {
    installBrowserStubs()
    panConstraint.releaseForProgrammaticCamera.mockReset()
    panConstraint.dispose.mockReset()
    panConstraint.constrain.mockClear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('releases pending pan bounds before point and bounds camera movement', () => {
    const order: string[] = []
    const map = createMapStub(order)
    const mapElement = element({ left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800 })
    const drawerElement = element({ left: 1200, top: 0, right: 1200, bottom: 800, width: 0, height: 800 })
    panConstraint.releaseForProgrammaticCamera.mockImplementation(() => {
      order.push('release')
    })

    const controller = createMapCameraController(map, mapElement, drawerElement)

    controller.focusPoint([23.5, 121], 12)
    expect(order.slice(0, 2)).toEqual(['release', 'setView'])

    order.length = 0
    controller.focusBounds([[22, 120], [25, 122]])
    expect(order.slice(0, 2)).toEqual(['release', 'fitBounds'])

    order.length = 0
    controller.clear()
    expect(order).toEqual(['release'])

    controller.dispose()
    expect(panConstraint.dispose).toHaveBeenCalledOnce()
  })

  it('connects the real Nearby Places surface to one origin camera movement', () => {
    const order: string[] = []
    const map = createMapStub(order)
    const mapElement = element({ left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800 })
    const drawerElement = element({ left: 900, top: 0, right: 1200, bottom: 800, width: 300, height: 800 })
    panConstraint.releaseForProgrammaticCamera.mockImplementation(() => order.push('release'))
    const controller = createMapCameraController(map, mapElement, drawerElement)
    const nearby = createNearbySurface()

    mapElement.dispatchEvent(new Event('pointerdown'))
    nearby.renderLoadingOrigin([25, 121.5])

    expect(order).toEqual(['release', 'stop', 'panTo'])
    const [cameraCenter, panOptions] = vi.mocked(map.panTo).mock.calls[0]
    expect(cameraCenter).toEqual(expect.objectContaining({ lat: expect.any(Number), lng: expect.any(Number) }))
    expect(cameraCenter).not.toEqual({ lat: 25, lng: 121.5 })
    expect(panOptions).toEqual(expect.objectContaining({ animate: true, duration: .32 }))

    order.length = 0
    nearby.renderPlaces([25, 121.5], [place(26, 122.5)])

    expect(order).toEqual([])
    expect(map.panTo).toHaveBeenCalledTimes(1)
    controller.dispose()
  })

  it('does not animate URL hydration origins without a recent map pointer click', () => {
    const order: string[] = []
    const map = createMapStub(order)
    const mapElement = element({ left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800 })
    const drawerElement = element({ left: 1200, top: 0, right: 1200, bottom: 800, width: 0, height: 800 })
    const controller = createMapCameraController(map, mapElement, drawerElement)

    createNearbySurface().renderLoadingOrigin([25, 121.5])

    expect(order).toEqual([])
    controller.dispose()
  })

  it('does not move again when results arrive after user intervention', () => {
    const order: string[] = []
    const map = createMapStub(order)
    const mapElement = element({ left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800 })
    const drawerElement = element({ left: 1200, top: 0, right: 1200, bottom: 800, width: 0, height: 800 })
    const controller = createMapCameraController(map, mapElement, drawerElement)
    const nearby = createNearbySurface()

    mapElement.dispatchEvent(new Event('pointerdown'))
    nearby.renderLoadingOrigin([25, 121.5])
    order.length = 0
    mapElement.dispatchEvent(new Event('pointerdown'))
    nearby.renderPlaces([25, 121.5], [place(26, 122.5)])

    expect(order).toEqual([])
    controller.dispose()
  })

  it('does not let a Nearby origin target swallow a later unrelated focus', () => {
    const order: string[] = []
    const map = createMapStub(order)
    const mapElement = element({ left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800 })
    const drawerElement = element({ left: 1200, top: 0, right: 1200, bottom: 800, width: 0, height: 800 })
    panConstraint.releaseForProgrammaticCamera.mockImplementation(() => order.push('release'))
    const controller = createMapCameraController(map, mapElement, drawerElement)

    mapElement.dispatchEvent(new Event('pointerdown'))
    createNearbySurface().renderLoadingOrigin([25, 121.5])
    order.length = 0
    controller.focusPoint([24, 120], 12)

    expect(order.slice(0, 2)).toEqual(['release', 'setView'])
    controller.dispose()
  })

  it('moves to a station only after an explicit focus request', () => {
    const order: string[] = []
    const map = createMapStub(order)
    const mapElement = element({ left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800 })
    const drawerElement = element({ left: 1200, top: 0, right: 1200, bottom: 800, width: 0, height: 800 })
    const controller = createMapCameraController(map, mapElement, drawerElement)
    const nearby = createNearbySurface()
    const selected = place(26, 122.5)

    mapElement.dispatchEvent(new Event('pointerdown'))
    nearby.renderLoadingOrigin([25, 121.5])
    nearby.renderPlaces([25, 121.5], [selected])
    order.length = 0

    controller.focusPoint([selected.latitude, selected.longitude], 12, { animate: true })

    expect(order).toEqual(['stop', 'panTo'])
    controller.dispose()
  })

  it('uses instant positioning when reduced motion is requested', () => {
    vi.unstubAllGlobals()
    installBrowserStubs(true)
    const order: string[] = []
    const map = createMapStub(order)
    const mapElement = element({ left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800 })
    const drawerElement = element({ left: 1200, top: 0, right: 1200, bottom: 800, width: 0, height: 800 })
    const controller = createMapCameraController(map, mapElement, drawerElement)

    controller.focusPoint([25, 121.5], 14, { animate: true })

    expect(order).toContain('setView')
    expect(order).not.toContain('flyTo')
    expect(order).not.toContain('panTo')
    controller.dispose()
  })
})
