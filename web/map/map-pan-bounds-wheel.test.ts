import type L from 'leaflet'
import { describe, expect, it, vi } from 'vitest'
import { constrainMapPanToTaiwan, taiwanPanBoundsForViewport } from './map-pan-bounds'

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
  let zoom = 7
  const map = {
    options,
    getSize() {
      return point(400, 300)
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

async function beginInertialDrag(
  surface: EventTarget,
  releaseSurface: EventTarget,
  emit: (type: MapEventName) => void,
) {
  surface.dispatchEvent(new Event('pointerdown'))
  emit('dragstart')
  releaseSurface.dispatchEvent(new Event('pointerup'))
  await Promise.resolve()
}

describe('Taiwan pan bounds wheel handoff', () => {
  it('waits for wheel zoom before rebounding drag inertia', async () => {
    const surface = new EventTarget()
    const releaseSurface = new EventTarget()
    const { map, emit, panInsideBounds, setZoom } = createMapStub()
    const dispose = constrainMapPanToTaiwan(map, surface, releaseSurface)

    await beginInertialDrag(surface, releaseSurface, emit)
    expect(map.options.maxBounds).toBeDefined()

    surface.dispatchEvent(new Event('wheel'))

    expect(map.options.maxBounds).toBeUndefined()
    expect(map.options.maxBoundsViscosity).toBeUndefined()

    emit('moveend')
    expect(panInsideBounds).not.toHaveBeenCalled()

    emit('zoomstart')
    setZoom(9)
    emit('zoomend')

    expect(panInsideBounds).toHaveBeenCalledOnce()
    expect(panInsideBounds).toHaveBeenCalledWith(taiwanPanBoundsForViewport(map), { animate: true })

    dispose()
  })

  it('rebounds when a wheel handoff produces no zoom', async () => {
    vi.useFakeTimers()
    const surface = new EventTarget()
    const releaseSurface = new EventTarget()
    const { map, emit, panInsideBounds } = createMapStub({ wheelDebounceTime: 1 })
    const dispose = constrainMapPanToTaiwan(map, surface, releaseSurface)

    try {
      await beginInertialDrag(surface, releaseSurface, emit)
      surface.dispatchEvent(new Event('wheel'))
      emit('moveend')

      expect(panInsideBounds).not.toHaveBeenCalled()

      await vi.runAllTimersAsync()

      expect(panInsideBounds).toHaveBeenCalledOnce()
      expect(panInsideBounds).toHaveBeenCalledWith(taiwanPanBoundsForViewport(map), { animate: true })
    } finally {
      dispose()
      vi.useRealTimers()
    }
  })
})
