import type L from 'leaflet'
import { describe, expect, it, vi } from 'vitest'
import { mapCities } from '../../src/config/map-cities'
import {
  constrainMapPanToTaiwan,
  TAIWAN_PAN_BOUNDS,
  TAIWAN_PAN_BOUNDS_VISCOSITY,
} from './map-pan-bounds'

type MapEventName = 'dragstart' | 'moveend'

function createMapStub(options: L.MapOptions = {}) {
  const listeners = new Map<MapEventName, Set<() => void>>()
  const panInsideBounds = vi.fn()
  const map = {
    options,
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

describe('Taiwan map pan bounds', () => {
  it('releases a non-drag gesture even when the pointer ends outside the map', async () => {
    const surface = new EventTarget()
    const releaseSurface = new EventTarget()
    const { map } = createMapStub()
    const dispose = constrainMapPanToTaiwan(map, surface, releaseSurface)

    expect(map.options.maxBounds).toBeUndefined()
    expect(map.options.maxBoundsViscosity).toBeUndefined()

    surface.dispatchEvent(new Event('pointerdown'))
    expect(map.options.maxBounds).toBe(TAIWAN_PAN_BOUNDS)
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

    expect(map.options.maxBounds).toBe(TAIWAN_PAN_BOUNDS)
    emit('moveend')

    expect(map.options.maxBounds).toBeUndefined()
    expect(map.options.maxBoundsViscosity).toBeUndefined()
    expect(panInsideBounds).toHaveBeenCalledOnce()
    expect(panInsideBounds).toHaveBeenCalledWith(TAIWAN_PAN_BOUNDS, { animate: true })

    dispose()
  })

  it('releases and rebounds an active drag when the window loses focus', () => {
    const surface = new EventTarget()
    const releaseSurface = new EventTarget()
    const { map, emit, panInsideBounds } = createMapStub()
    const dispose = constrainMapPanToTaiwan(map, surface, releaseSurface)

    surface.dispatchEvent(new Event('pointerdown'))
    emit('dragstart')
    releaseSurface.dispatchEvent(new Event('blur'))

    expect(map.options.maxBounds).toBeUndefined()
    expect(map.options.maxBoundsViscosity).toBeUndefined()
    expect(panInsideBounds).toHaveBeenCalledOnce()
    expect(panInsideBounds).toHaveBeenCalledWith(TAIWAN_PAN_BOUNDS, { animate: true })

    dispose()
  })

  it('keeps every configured city, including offshore islands, inside the boundary', () => {
    const [[south, west], [north, east]] = TAIWAN_PAN_BOUNDS as [[number, number], [number, number]]

    for (const city of mapCities) {
      const [latitude, longitude] = city.center
      expect(latitude, `${city.name} latitude`).toBeGreaterThan(south)
      expect(latitude, `${city.name} latitude`).toBeLessThan(north)
      expect(longitude, `${city.name} longitude`).toBeGreaterThan(west)
      expect(longitude, `${city.name} longitude`).toBeLessThan(east)
    }
  })
})
