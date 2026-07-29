import type L from 'leaflet'
import { describe, expect, it, vi } from 'vitest'
import { constrainMapPanToTaiwan } from './map-pan-bounds'

type MapEventName = 'dragstart' | 'moveend' | 'zoomstart' | 'zoomend'

type StubPoint = L.Point & {
  add(point: L.PointExpression): StubPoint
  divideBy(divisor: number): StubPoint
  subtract(point: L.PointExpression): StubPoint
}

function point(x: number, y: number): StubPoint {
  const read = (value: L.PointExpression): [number, number] => {
    if (Array.isArray(value)) return [value[0], value[1]]
    return [value.x, value.y]
  }

  return {
    x,
    y,
    add(value) {
      const [otherX, otherY] = read(value)
      return point(x + otherX, y + otherY)
    },
    divideBy(divisor) {
      return point(x / divisor, y / divisor)
    },
    subtract(value) {
      const [otherX, otherY] = read(value)
      return point(x - otherX, y - otherY)
    },
  } as StubPoint
}

function createMapStub(options: L.MapOptions = {}) {
  const listeners = new Map<MapEventName, Set<() => void>>()
  const panInsideBounds = vi.fn()
  const map = {
    options,
    getSize() {
      return point(400, 300)
    },
    getZoom() {
      return 7
    },
    project(latlng: L.LatLngExpression, zoom = 7) {
      const [latitude, longitude] = latlng as [number, number]
      const scale = 2 ** zoom
      return point(longitude * scale, -latitude * scale)
    },
    unproject(projected: L.PointExpression, zoom = 7) {
      const [x, y] = Array.isArray(projected)
        ? projected
        : [projected.x, projected.y]
      const scale = 2 ** zoom
      return { lat: -y / scale, lng: x / scale } as L.LatLng
    },
    on(type: MapEventName, listener: () => void) {
      const group = listeners.get(type) ?? new Set<() => void>()
      group.add(listener)
      listeners.set(type, group)
      return map
    },
    off(type: MapEventName, listener: () => void) {
      listeners.get(type)?.delete(listener)
      return map
    },
    panInsideBounds,
  }

  return {
    map,
    panInsideBounds,
    emit(type: MapEventName) {
      listeners.get(type)?.forEach((listener) => listener())
    },
  }
}

function keyboardEvent(): Event {
  const event = new Event('keydown')
  Object.defineProperties(event, {
    key: { value: 'ArrowLeft' },
    keyCode: { value: 37 },
    altKey: { value: false },
    ctrlKey: { value: false },
    metaKey: { value: false },
    shiftKey: { value: false },
  })
  return event
}

describe('Taiwan pan bounds programmatic camera handoff', () => {
  it('cancels a pending final rebound before programmatic camera movement', async () => {
    const surface = new EventTarget()
    const { map, emit, panInsideBounds } = createMapStub()
    const dispose = constrainMapPanToTaiwan(map, surface, surface)

    surface.dispatchEvent(new Event('pointerdown'))
    emit('dragstart')
    surface.dispatchEvent(new Event('pointerup'))
    await Promise.resolve()
    emit('moveend')

    expect(panInsideBounds).toHaveBeenCalledOnce()

    dispose.releaseForProgrammaticCamera()
    emit('zoomstart')
    emit('zoomend')
    emit('moveend')

    expect(panInsideBounds).toHaveBeenCalledOnce()
    expect(map.options.maxBounds).toBeUndefined()
    expect(map.options.maxBoundsViscosity).toBeUndefined()

    dispose()
  })

  it('cancels a pending keyboard settle before programmatic camera movement', async () => {
    const surface = new EventTarget()
    const { map, emit, panInsideBounds } = createMapStub()
    const dispose = constrainMapPanToTaiwan(map, surface, surface)

    surface.dispatchEvent(keyboardEvent())
    await Promise.resolve()

    dispose.releaseForProgrammaticCamera()
    emit('moveend')

    expect(panInsideBounds).not.toHaveBeenCalled()

    dispose()
  })
})
