import type L from 'leaflet'
import { describe, expect, it, vi } from 'vitest'
import { mapCities } from '../../src/config/map-cities'
import {
  constrainMapPanToTaiwan,
  TAIWAN_PAN_BOUNDS,
  TAIWAN_PAN_BOUNDS_VISCOSITY,
} from './map-pan-bounds'

describe('Taiwan map pan bounds', () => {
  it('applies a soft Leaflet boundary to the map', () => {
    const options = {} as L.MapOptions
    const setMaxBounds = vi.fn()

    constrainMapPanToTaiwan({ options, setMaxBounds })

    expect(options.maxBoundsViscosity).toBe(.9)
    expect(options.maxBoundsViscosity).toBe(TAIWAN_PAN_BOUNDS_VISCOSITY)
    expect(setMaxBounds).toHaveBeenCalledOnce()
    expect(setMaxBounds).toHaveBeenCalledWith(TAIWAN_PAN_BOUNDS)
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
