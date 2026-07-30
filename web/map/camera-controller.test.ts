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

function element(rect: Rect): HTMLElement {
  return Object.assign(new EventTarget(), {
    getBoundingClientRect: () => rect,
  }) as unknown as HTMLElement
}

function installBrowserStubs() {
  const browserWindow = Object.assign(new EventTarget(), {
    requestAnimationFrame: vi.fn(() => 1),
    cancelAnimationFrame: vi.fn(),
    visualViewport: undefined,
  })

  class ResizeObserverStub {
    observe = vi.fn()
    disconnect = vi.fn()
  }

  vi.stubGlobal('window', browserWindow)
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
}

function createMapStub(order: string[]): L.Map {
  return {
    fitBounds: vi.fn(() => {
      order.push('fitBounds')
    }),
    flyTo: vi.fn(() => {
      order.push('flyTo')
    }),
    setView: vi.fn(() => {
      order.push('setView')
    }),
    panBy: vi.fn(() => {
      order.push('panBy')
    }),
    project: vi.fn(() => ({
      add: () => ({ x: 0, y: 0 }),
    })),
    unproject: vi.fn(() => ({ lat: 23.5, lng: 121 })),
    invalidateSize: vi.fn(),
  } as unknown as L.Map
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
})
