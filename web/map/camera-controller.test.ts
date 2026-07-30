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

vi.mock('./map-pan-bounds', () => ({
  constrainMapPanToTaiwan: panConstraint.constrain,
}))

import { createMapCameraController } from './camera-controller'
import { NEARBY_ORIGIN_RENDERED_EVENT } from './nearby-map-events'

type Rect = {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

type MapHarness = {
  map: L.Map
  fire(type: string, data?: Record<string, unknown>): void
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

function createMapStub(order: string[]): MapHarness {
  const handlers = new Map<string, Set<(event: unknown) => void>>()
  let center = { lat: 23.5, lng: 121 }
  let zoom = 12
  const map = {
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
    on: vi.fn((type: string, handler: (event: unknown) => void) => {
      const listeners = handlers.get(type) ?? new Set()
      listeners.add(handler)
      handlers.set(type, listeners)
      return map
    }),
    off: vi.fn((type: string, handler: (event: unknown) => void) => {
      handlers.get(type)?.delete(handler)
      return map
    }),
  } as unknown as L.Map

  return {
    map,
    fire(type, data = {}) {
      for (const handler of handlers.get(type) ?? []) handler({ type, target: map, ...data })
    },
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
    const { map } = createMapStub(order)
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

  it('starts a drawer-aware pan when the loading origin follows a map pointer click', () => {
    const order: string[] = []
    const harness = createMapStub(order)
    const mapElement = element({ left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800 })
    const drawerElement = element({ left: 900, top: 0, right: 1200, bottom: 800, width: 300, height: 800 })
    panConstraint.releaseForProgrammaticCamera.mockImplementation(() => order.push('release'))
    const controller = createMapCameraController(harness.map, mapElement, drawerElement)

    mapElement.dispatchEvent(new Event('pointerdown'))
    harness.fire(NEARBY_ORIGIN_RENDERED_EVENT, { origin: [25, 121.5] })

    expect(order).toEqual(['release', 'stop', 'panTo'])
    const [cameraCenter, panOptions] = vi.mocked(harness.map.panTo).mock.calls[0]
    expect(cameraCenter).toEqual(expect.objectContaining({ lat: expect.any(Number), lng: expect.any(Number) }))
    expect(cameraCenter).not.toEqual({ lat: 25, lng: 121.5 })
    expect(panOptions).toEqual(expect.objectContaining({ animate: true, duration: .32 }))
    controller.dispose()
  })

  it('does not animate URL hydration origins without a recent map pointer click', () => {
    const order: string[] = []
    const harness = createMapStub(order)
    const mapElement = element({ left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800 })
    const drawerElement = element({ left: 1200, top: 0, right: 1200, bottom: 800, width: 0, height: 800 })
    const controller = createMapCameraController(harness.map, mapElement, drawerElement)

    harness.fire(NEARBY_ORIGIN_RENDERED_EVENT, { origin: [25, 121.5] })

    expect(order).toEqual([])
    controller.dispose()
  })

  it('turns the final nearby focus into a short settle and suppresses it after user intervention', () => {
    const order: string[] = []
    const harness = createMapStub(order)
    const mapElement = element({ left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800 })
    const drawerElement = element({ left: 1200, top: 0, right: 1200, bottom: 800, width: 0, height: 800 })
    panConstraint.releaseForProgrammaticCamera.mockImplementation(() => order.push('release'))
    const controller = createMapCameraController(harness.map, mapElement, drawerElement)

    mapElement.dispatchEvent(new Event('pointerdown'))
    harness.fire(NEARBY_ORIGIN_RENDERED_EVENT, { origin: [25, 121.5] })
    order.length = 0
    controller.focusPoint([25.001, 121.501], 12)
    expect(order).toEqual(['release'])

    mapElement.dispatchEvent(new Event('pointerdown'))
    harness.fire(NEARBY_ORIGIN_RENDERED_EVENT, { origin: [25.5, 121.8] })
    order.length = 0
    mapElement.dispatchEvent(new Event('pointerdown'))
    controller.focusPoint([25.51, 121.81], 12)
    expect(order).toEqual([])
    controller.dispose()
  })

  it('uses instant positioning when reduced motion is requested', () => {
    vi.unstubAllGlobals()
    installBrowserStubs(true)
    const order: string[] = []
    const harness = createMapStub(order)
    const mapElement = element({ left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800 })
    const drawerElement = element({ left: 1200, top: 0, right: 1200, bottom: 800, width: 0, height: 800 })
    const controller = createMapCameraController(harness.map, mapElement, drawerElement)

    controller.focusPoint([25, 121.5], 14, { animate: true })

    expect(order).toContain('setView')
    expect(order).not.toContain('flyTo')
    expect(order).not.toContain('panTo')
    controller.dispose()
  })
})
