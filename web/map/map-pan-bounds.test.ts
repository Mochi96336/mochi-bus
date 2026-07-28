import type L from 'leaflet'
import { describe, expect, it, vi } from 'vitest'
import { mapCities } from '../../src/config/map-cities'
import {
  constrainMapPanToTaiwan,
  taiwanPanBoundsForViewport,
  TAIWAN_PAN_BOUNDS_VISCOSITY,
  TAIWAN_PAN_CENTER_BOUNDS,
} from './map-pan-bounds'

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

function createMapStub(options: L.MapOptions = {}, size: [number, number] = [400, 300]) {
  const listeners = new Map<MapEventName, Set<() => void>>()
  const panInsideBounds = vi.fn()
  let zoom = 7
  const map = {
    options,
    getSize() {
      return point(size[0], size[1])
    },
    getZoom() {
      return zoom
    },
    project(latlng: L.LatLngExpression, projectZoom = zoom) {
      const [latitude, longitude] = latlng as [number, number]
      const scale = 2 ** projectZoom
      return point(longitude * scale, -latitude * scale)
    },
    unproject(projected: L.PointExpression, projectZoom = zoom) {
      const [x, y] = Array.isArray(projected)
        ? projected
        : [projected.x, projected.y]
      const scale = 2 ** projectZoom
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
    setZoom(nextZoom: number) {
      zoom = nextZoom
    },
  }
}

function dispatchPointer(target: EventTarget, type: 'pointerdown' | 'pointerup' | 'pointercancel', id: number) {
  const event = new Event(type)
  Object.defineProperty(event, 'pointerId', { value: id })
  target.dispatchEvent(event)
}

describe('Taiwan map pan bounds', () => {
  it('expands the allowed center range by half of the viewport', () => {
    const { map, setZoom } = createMapStub({}, [4, 6])
    setZoom(0)

    expect(taiwanPanBoundsForViewport(map)).toEqual([
      [18.2, 115.7],
      [29.8, 124.4],
    ])
  })

  it('releases a non-drag gesture even when the pointer ends outside the map', async () => {
    const surface = new EventTarget()
    const releaseSurface = new EventTarget()
    const { map } = createMapStub()
    const dispose = constrainMapPanToTaiwan(map, surface, releaseSurface)

    expect(map.options.maxBounds).toBeUndefined()
    expect(map.options.maxBoundsViscosity).toBeUndefined()

    surface.dispatchEvent(new Event('pointerdown'))
    expect(map.options.maxBounds).toEqual(taiwanPanBoundsForViewport(map))
    expect(map.options.maxBoundsViscosity).toBe(TAIWAN_PAN_BOUNDS_VISCOSITY)

    releaseSurface.dispatchEvent(new Event('pointerup'))
    await Promise.resolve()
    expect(map.options.maxBounds).toBeUndefined()
    expect(map.options.maxBoundsViscosity).toBeUndefined()

    dispose()
  })

  it('keeps the boundary through drag inertia, then rebounds and releases the camera', async () => {
    const surface = new EventTarget()
    const releaseSurface = new EventTarget()
    const { map, emit, panInsideBounds } = createMapStub()
    const dispose = constrainMapPanToTaiwan(map, surface, releaseSurface)

    surface.dispatchEvent(new Event('pointerdown'))
    emit('dragstart')
    releaseSurface.dispatchEvent(new Event('pointerup'))
    await Promise.resolve()

    expect(map.options.maxBounds).toEqual(taiwanPanBoundsForViewport(map))
    emit('moveend')

    expect(map.options.maxBounds).toBeUndefined()
    expect(map.options.maxBoundsViscosity).toBeUndefined()
    expect(panInsideBounds).toHaveBeenCalledOnce()
    expect(panInsideBounds).toHaveBeenCalledWith(taiwanPanBoundsForViewport(map), { animate: true })

    dispose()
  })

  it('recomputes the rebound boundary at the final zoom', async () => {
    const surface = new EventTarget()
    const releaseSurface = new EventTarget()
    const { map, emit, panInsideBounds, setZoom } = createMapStub()
    const dispose = constrainMapPanToTaiwan(map, surface, releaseSurface)

    surface.dispatchEvent(new Event('pointerdown'))
    const initialBounds = map.options.maxBounds
    emit('dragstart')
    emit('zoomstart')
    setZoom(9)
    releaseSurface.dispatchEvent(new Event('pointerup'))
    await Promise.resolve()
    emit('zoomend')

    expect(panInsideBounds).toHaveBeenCalledWith(taiwanPanBoundsForViewport(map), { animate: true })
    expect(panInsideBounds.mock.calls[0]?.[0]).not.toEqual(initialBounds)

    dispose()
  })

  it('keeps the constraint when a second drag interrupts the previous inertia', async () => {
    const surface = new EventTarget()
    const releaseSurface = new EventTarget()
    const { map, emit, panInsideBounds } = createMapStub()
    const dispose = constrainMapPanToTaiwan(map, surface, releaseSurface)

    surface.dispatchEvent(new Event('pointerdown'))
    emit('dragstart')
    releaseSurface.dispatchEvent(new Event('pointerup'))
    await Promise.resolve()

    surface.dispatchEvent(new Event('pointerdown'))
    emit('moveend')

    expect(map.options.maxBounds).toEqual(taiwanPanBoundsForViewport(map))
    expect(map.options.maxBoundsViscosity).toBe(TAIWAN_PAN_BOUNDS_VISCOSITY)
    expect(panInsideBounds).not.toHaveBeenCalled()

    emit('dragstart')
    releaseSurface.dispatchEvent(new Event('pointerup'))
    await Promise.resolve()

    expect(map.options.maxBounds).toEqual(taiwanPanBoundsForViewport(map))
    emit('moveend')

    expect(map.options.maxBounds).toBeUndefined()
    expect(map.options.maxBoundsViscosity).toBeUndefined()
    expect(panInsideBounds).toHaveBeenCalledOnce()

    dispose()
  })

  it('rebounds when a click interrupts the previous inertia without starting another drag', async () => {
    const surface = new EventTarget()
    const releaseSurface = new EventTarget()
    const { map, emit, panInsideBounds } = createMapStub()
    const dispose = constrainMapPanToTaiwan(map, surface, releaseSurface)

    surface.dispatchEvent(new Event('pointerdown'))
    emit('dragstart')
    releaseSurface.dispatchEvent(new Event('pointerup'))
    await Promise.resolve()

    surface.dispatchEvent(new Event('pointerdown'))
    emit('moveend')
    releaseSurface.dispatchEvent(new Event('pointerup'))
    await Promise.resolve()

    expect(map.options.maxBounds).toBeUndefined()
    expect(map.options.maxBoundsViscosity).toBeUndefined()
    expect(panInsideBounds).toHaveBeenCalledOnce()
    expect(panInsideBounds).toHaveBeenCalledWith(taiwanPanBoundsForViewport(map), { animate: true })

    dispose()
  })

  it('releases after a drag becomes a stationary two-pointer gesture', async () => {
    const surface = new EventTarget()
    const releaseSurface = new EventTarget()
    const { map, emit, panInsideBounds } = createMapStub()
    const dispose = constrainMapPanToTaiwan(map, surface, releaseSurface)

    dispatchPointer(surface, 'pointerdown', 1)
    emit('dragstart')
    dispatchPointer(surface, 'pointerdown', 2)
    emit('moveend')
    dispatchPointer(releaseSurface, 'pointerup', 2)
    dispatchPointer(releaseSurface, 'pointerup', 1)
    await Promise.resolve()

    expect(map.options.maxBounds).toBeUndefined()
    expect(map.options.maxBoundsViscosity).toBeUndefined()
    expect(panInsideBounds).toHaveBeenCalledOnce()
    expect(panInsideBounds).toHaveBeenCalledWith(taiwanPanBoundsForViewport(map), { animate: true })

    dispose()
  })

  it('waits for pinch zoom to finish before rebounding a handed-off drag', async () => {
    const surface = new EventTarget()
    const releaseSurface = new EventTarget()
    const { map, emit, panInsideBounds } = createMapStub()
    const dispose = constrainMapPanToTaiwan(map, surface, releaseSurface)

    dispatchPointer(surface, 'pointerdown', 1)
    emit('dragstart')
    dispatchPointer(surface, 'pointerdown', 2)
    emit('moveend')
    emit('zoomstart')
    dispatchPointer(releaseSurface, 'pointerup', 2)
    dispatchPointer(releaseSurface, 'pointerup', 1)
    await Promise.resolve()

    expect(map.options.maxBounds).toEqual(taiwanPanBoundsForViewport(map))
    expect(map.options.maxBoundsViscosity).toBe(TAIWAN_PAN_BOUNDS_VISCOSITY)
    expect(panInsideBounds).not.toHaveBeenCalled()

    emit('zoomend')

    expect(map.options.maxBounds).toBeUndefined()
    expect(map.options.maxBoundsViscosity).toBeUndefined()
    expect(panInsideBounds).toHaveBeenCalledOnce()
    expect(panInsideBounds).toHaveBeenCalledWith(taiwanPanBoundsForViewport(map), { animate: true })

    dispose()
  })

  it('rebounds after a pure pinch zoom', async () => {
    const surface = new EventTarget()
    const releaseSurface = new EventTarget()
    const { map, emit, panInsideBounds, setZoom } = createMapStub()
    const dispose = constrainMapPanToTaiwan(map, surface, releaseSurface)

    dispatchPointer(surface, 'pointerdown', 1)
    dispatchPointer(surface, 'pointerdown', 2)
    emit('zoomstart')
    setZoom(9)
    dispatchPointer(releaseSurface, 'pointerup', 2)
    dispatchPointer(releaseSurface, 'pointerup', 1)
    await Promise.resolve()

    expect(map.options.maxBounds).toEqual(taiwanPanBoundsForViewport(map))
    emit('zoomend')

    expect(map.options.maxBounds).toBeUndefined()
    expect(map.options.maxBoundsViscosity).toBeUndefined()
    expect(panInsideBounds).toHaveBeenCalledOnce()
    expect(panInsideBounds).toHaveBeenCalledWith(taiwanPanBoundsForViewport(map), { animate: true })

    dispose()
  })

  it.each(['pointercancel', 'blur'])('releases and rebounds an active drag after %s', async (eventType: string) => {
    const surface = new EventTarget()
    const releaseSurface = new EventTarget()
    const { map, emit, panInsideBounds } = createMapStub()
    const dispose = constrainMapPanToTaiwan(map, surface, releaseSurface)

    surface.dispatchEvent(new Event('pointerdown'))
    emit('dragstart')
    releaseSurface.dispatchEvent(new Event(eventType))
    await Promise.resolve()

    expect(map.options.maxBounds).toBeUndefined()
    expect(map.options.maxBoundsViscosity).toBeUndefined()
    expect(panInsideBounds).toHaveBeenCalledOnce()
    expect(panInsideBounds).toHaveBeenCalledWith(taiwanPanBoundsForViewport(map), { animate: true })

    dispose()
  })

  it('keeps every configured city, including offshore islands, inside the center range', () => {
    const [[south, west], [north, east]] = TAIWAN_PAN_CENTER_BOUNDS

    for (const city of mapCities) {
      const [latitude, longitude] = city.center
      expect(latitude, `${city.name} latitude`).toBeGreaterThan(south)
      expect(latitude, `${city.name} latitude`).toBeLessThan(north)
      expect(longitude, `${city.name} longitude`).toBeGreaterThan(west)
      expect(longitude, `${city.name} longitude`).toBeLessThan(east)
    }
  })
})
