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
  return { map, panInsideBounds }
}

function keyboardEvent(
  key: string,
  keyCode: number,
  modifiers: Partial<Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>> = {},
): Event {
  const event = new Event('keydown')
  Object.defineProperties(event, {
    key: { value: key },
    keyCode: { value: keyCode },
    altKey: { value: modifiers.altKey ?? false },
    ctrlKey: { value: modifiers.ctrlKey ?? false },
    metaKey: { value: modifiers.metaKey ?? false },
    shiftKey: { value: modifiers.shiftKey ?? false },
  })
  return event
}

describe('Taiwan pan bounds keyboard navigation', () => {
  it.each([
    ['ArrowLeft', 37],
    ['ArrowUp', 38],
    ['ArrowRight', 39],
    ['ArrowDown', 40],
  ] as const)('arms bounds while Leaflet handles %s, then restores camera freedom', async (key, keyCode) => {
    const surface = new EventTarget()
    const { map } = createMapStub()
    const dispose = constrainMapPanToTaiwan(map, surface, surface)
    let observedBounds: L.LatLngBoundsExpression | undefined

    surface.addEventListener('keydown', () => {
      observedBounds = map.options.maxBounds
    })
    surface.dispatchEvent(keyboardEvent(key, keyCode, { shiftKey: true }))

    expect(observedBounds).toBeDefined()
    expect(map.options.maxBounds).toBeDefined()
    await Promise.resolve()
    expect(map.options.maxBounds).toBeUndefined()
    expect(map.options.maxBoundsViscosity).toBeUndefined()

    dispose()
  })

  it.each([
    keyboardEvent('a', 65),
    keyboardEvent('ArrowLeft', 37, { altKey: true }),
    keyboardEvent('ArrowLeft', 37, { ctrlKey: true }),
    keyboardEvent('ArrowLeft', 37, { metaKey: true }),
  ])('ignores keys that Leaflet keyboard panning also ignores', async (event) => {
    const surface = new EventTarget()
    const { map } = createMapStub()
    const dispose = constrainMapPanToTaiwan(map, surface, surface)

    surface.dispatchEvent(event)
    expect(map.options.maxBounds).toBeUndefined()
    await Promise.resolve()
    expect(map.options.maxBounds).toBeUndefined()

    dispose()
  })

  it('restores pre-existing map bounds after a keyboard pan', async () => {
    const previousBounds = taiwanPanBoundsForViewport(createMapStub().map)
    const options: L.MapOptions = {
      maxBounds: previousBounds,
      maxBoundsViscosity: .4,
    }
    const surface = new EventTarget()
    const { map } = createMapStub(options)
    const dispose = constrainMapPanToTaiwan(map, surface, surface)

    surface.dispatchEvent(keyboardEvent('ArrowRight', 39))
    expect(map.options.maxBounds).not.toBe(previousBounds)
    await Promise.resolve()
    expect(map.options.maxBounds).toBe(previousBounds)
    expect(map.options.maxBoundsViscosity).toBe(.4)

    dispose()
  })
})
