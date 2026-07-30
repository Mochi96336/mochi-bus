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

type Rect = {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

type MutableElement = HTMLElement & {
  setRect(rect: Rect): void
}

function element(initialRect: Rect): MutableElement {
  let rect = initialRect
  return Object.assign(new EventTarget(), {
    getBoundingClientRect: () => rect,
    setRect(nextRect: Rect) {
      rect = nextRect
    },
  }) as unknown as MutableElement
}

function installBrowserStubs() {
  let nextFrame = 1
  const frames = new Map<number, FrameRequestCallback>()
  const observers: Array<{ callback: ResizeObserverCallback; instance: ResizeObserver }> = []
  const browserWindow = Object.assign(new EventTarget(), {
    requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
      const id = nextFrame++
      frames.set(id, callback)
      return id
    }),
    cancelAnimationFrame: vi.fn((id: number) => {
      frames.delete(id)
    }),
    visualViewport: undefined,
  })

  class ResizeObserverStub implements ResizeObserver {
    readonly observe = vi.fn()
    readonly unobserve = vi.fn()
    readonly disconnect = vi.fn()

    constructor(callback: ResizeObserverCallback) {
      observers.push({ callback, instance: this })
    }
  }

  vi.stubGlobal('window', browserWindow)
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)

  return {
    observer() {
      const observer = observers[0]
      if (!observer) throw new Error('ResizeObserver was not created')
      return observer
    },
    runFrames() {
      const pending = [...frames.entries()]
      frames.clear()
      pending.forEach(([, callback]) => callback(0))
    },
  }
}

function createMapStub(
  order: string[],
  initialCamera = { center: { lat: 23.5, lng: 121 }, zoom: 12 },
): L.Map {
  let center = { ...initialCamera.center }
  let zoom = initialCamera.zoom
  return {
    fitBounds: vi.fn(() => {
      order.push('fitBounds')
    }),
    flyTo: vi.fn((nextCenter: L.LatLngExpression, nextZoom?: number) => {
      order.push('flyTo')
      const value = Array.isArray(nextCenter)
        ? { lat: Number(nextCenter[0]), lng: Number(nextCenter[1]) }
        : nextCenter as L.LatLng
      center = { lat: value.lat, lng: value.lng }
      if (nextZoom !== undefined) zoom = nextZoom
    }),
    setView: vi.fn((nextCenter: L.LatLngExpression, nextZoom?: number) => {
      order.push('setView')
      const value = Array.isArray(nextCenter)
        ? { lat: Number(nextCenter[0]), lng: Number(nextCenter[1]) }
        : nextCenter as L.LatLng
      center = { lat: value.lat, lng: value.lng }
      if (nextZoom !== undefined) zoom = nextZoom
    }),
    panBy: vi.fn(() => {
      order.push('panBy')
    }),
    stop: vi.fn(() => {
      order.push('stop')
    }),
    getCenter: vi.fn(() => ({ ...center } as L.LatLng)),
    getZoom: vi.fn(() => zoom),
    project: vi.fn(() => ({
      add: () => ({ x: 0, y: 0 }),
    })),
    unproject: vi.fn(() => ({ lat: 23.5, lng: 121 })),
    invalidateSize: vi.fn(),
  } as unknown as L.Map
}

describe('map camera controller pan-bound handoff', () => {
  beforeEach(() => {
    panConstraint.releaseForProgrammaticCamera.mockReset()
    panConstraint.dispose.mockReset()
    panConstraint.constrain.mockClear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('releases pending pan bounds before point and bounds camera movement', () => {
    installBrowserStubs()
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

  it('uses the predicted final drawer rect and ignores intermediate drawer resize frames', () => {
    const browser = installBrowserStubs()
    const order: string[] = []
    const map = createMapStub(order)
    const mapElement = element({ left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800 })
    const currentDrawerRect = { left: 780, top: 404, right: 1180, bottom: 782, width: 400, height: 378 }
    const finalDrawerRect = { left: 780, top: 482, right: 1180, bottom: 782, width: 400, height: 300 }
    const drawerElement = element(currentDrawerRect)
    const measureDrawerRectForSize = vi.fn(() => finalDrawerRect)
    const controller = createMapCameraController(map, mapElement, drawerElement, {
      measureDrawerRectForSize,
    })

    controller.prepareDrawerSizeTransition({
      from: 'standard',
      to: 'compact',
      durationMs: 160,
      camera: 'predict',
      fromView: 'catalogue:Tainan',
      toView: 'route:Tainan:R1',
      fromCamera: 'predict',
      toCamera: 'predict',
    })
    controller.focusBounds([[22, 120], [25, 122]])

    expect(measureDrawerRectForSize).toHaveBeenCalledWith(drawerElement, 'compact')
    expect(map.stop).toHaveBeenCalledOnce()
    expect(map.fitBounds).toHaveBeenCalledTimes(1)
    expect(map.fitBounds).toHaveBeenLastCalledWith(
      [[22, 120], [25, 122]],
      expect.objectContaining({ animate: true, duration: .16 }),
    )

    const observed = browser.observer()
    observed.callback([
      { target: drawerElement } as unknown as ResizeObserverEntry,
    ], observed.instance)
    browser.runFrames()
    expect(map.fitBounds).toHaveBeenCalledTimes(1)

    drawerElement.setRect(finalDrawerRect)
    drawerElement.dispatchEvent(Object.assign(new Event('transitionend'), { propertyName: 'height' }))
    browser.runFrames()

    expect(map.fitBounds).toHaveBeenCalledTimes(2)
    expect(map.fitBounds).toHaveBeenLastCalledWith(
      [[22, 120], [25, 122]],
      expect.objectContaining({ animate: false }),
    )

    controller.dispose()
  })

  it('captures a preserved workspace on departure and restores it on return', () => {
    installBrowserStubs()
    const order: string[] = []
    const savedCamera = { center: { lat: 25.0478, lng: 121.5319 }, zoom: 16 }
    const map = createMapStub(order, savedCamera)
    const mapElement = element({ left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800 })
    const drawerElement = element({ left: 780, top: 386, right: 1180, bottom: 782, width: 400, height: 396 })
    const controller = createMapCameraController(map, mapElement, drawerElement, {
      measureDrawerRectForSize: (_drawer, size) => size === 'compact'
        ? { left: 780, top: 482, right: 1180, bottom: 782, width: 400, height: 300 }
        : { left: 780, top: 386, right: 1180, bottom: 782, width: 400, height: 396 },
    })

    controller.prepareDrawerSizeTransition({
      from: 'standard',
      to: 'compact',
      durationMs: 160,
      camera: 'preserve',
      fromView: 'trip-results:A:B',
      toView: 'route:Taipei:B',
      fromCamera: 'preserve',
      toCamera: 'predict',
    })
    map.setView([23.1, 120.2], 11)
    drawerElement.setRect({ left: 780, top: 482, right: 1180, bottom: 782, width: 400, height: 300 })
    drawerElement.dispatchEvent(Object.assign(new Event('transitionend'), { propertyName: 'height' }))

    controller.prepareDrawerSizeTransition({
      from: 'compact',
      to: 'standard',
      durationMs: 160,
      camera: 'preserve',
      fromView: 'route:Taipei:B',
      toView: 'trip-results:A:B',
      fromCamera: 'predict',
      toCamera: 'preserve',
    })

    expect(map.setView).toHaveBeenLastCalledWith(
      [savedCamera.center.lat, savedCamera.center.lng],
      savedCamera.zoom,
      { animate: false },
    )
    expect(map.getCenter()).toEqual(savedCamera.center)
    expect(map.getZoom()).toBe(savedCamera.zoom)
    controller.dispose()
  })

  it('drops an old target while a preserved camera workspace resizes without a snapshot', () => {
    const browser = installBrowserStubs()
    const order: string[] = []
    const map = createMapStub(order)
    const mapElement = element({ left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800 })
    const drawerElement = element({ left: 780, top: 482, right: 1180, bottom: 782, width: 400, height: 300 })
    const controller = createMapCameraController(map, mapElement, drawerElement, {
      measureDrawerRectForSize: () => ({ left: 780, top: 386, right: 1180, bottom: 782, width: 400, height: 396 }),
    })

    controller.focusBounds([[22, 120], [25, 122]])
    controller.prepareDrawerSizeTransition({
      from: 'compact',
      to: 'standard',
      durationMs: 160,
      camera: 'preserve',
      fromView: 'route:Tainan:R1',
      toView: 'trip-results:A:B',
      fromCamera: 'predict',
      toCamera: 'preserve',
    })

    const observed = browser.observer()
    observed.callback([
      { target: drawerElement } as unknown as ResizeObserverEntry,
    ], observed.instance)
    browser.runFrames()
    expect(map.stop).toHaveBeenCalledOnce()
    expect(map.fitBounds).toHaveBeenCalledTimes(1)

    drawerElement.dispatchEvent(Object.assign(new Event('transitionend'), { propertyName: 'height' }))
    browser.runFrames()
    expect(map.fitBounds).toHaveBeenCalledTimes(1)

    controller.dispose()
  })

  it('cancels the predicted camera target when the user manipulates the map', () => {
    const browser = installBrowserStubs()
    const order: string[] = []
    const map = createMapStub(order)
    const mapElement = element({ left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800 })
    const drawerElement = element({ left: 780, top: 404, right: 1180, bottom: 782, width: 400, height: 378 })
    const controller = createMapCameraController(map, mapElement, drawerElement, {
      measureDrawerRectForSize: () => ({ left: 780, top: 482, right: 1180, bottom: 782, width: 400, height: 300 }),
    })

    controller.focusBounds([[22, 120], [25, 122]])
    controller.prepareDrawerSizeTransition({
      from: 'standard',
      to: 'compact',
      durationMs: 160,
      camera: 'predict',
      fromView: 'catalogue:Tainan',
      toView: 'route:Tainan:R1',
      fromCamera: 'predict',
      toCamera: 'predict',
    })
    mapElement.dispatchEvent(new Event('pointerdown'))
    browser.runFrames()

    expect(map.stop).toHaveBeenCalledOnce()
    expect(map.fitBounds).toHaveBeenCalledTimes(1)
    controller.dispose()
  })
})
