import { describe, expect, it, vi } from 'vitest'
import type { NearbyPlacesPresentation } from './nearby-places-controller'
import { createNearbyResultsState } from './nearby-results-state'

const presentation: NearbyPlacesPresentation = {
  cityCode: 'Tainan',
  origin: [22.997, 120.212],
  radiusMeters: 500,
  autoPreview: true,
  places: [
    { placeId: 'P1', name: '臺南火車站', latitude: 22.997, longitude: 120.212, distanceMeters: 76 },
    { placeId: 'P2', name: '成功大學', latitude: 22.999, longitude: 120.216, distanceMeters: 180 },
  ],
}

describe('Nearby results state', () => {
  it('stores results separately from rendering and can synchronize the map on demand', () => {
    const renderPlaces = vi.fn()
    const renderEndpoints = vi.fn()
    const state = createNearbyResultsState({ renderPlaces, renderEndpoints })

    state.store(presentation)
    expect(state.current()).toEqual({ origin: [22.997, 120.212], places: presentation.places })
    expect(renderPlaces).not.toHaveBeenCalled()

    state.renderMap()
    expect(renderPlaces).toHaveBeenCalledWith([22.997, 120.212], presentation.places)
    expect(renderEndpoints).toHaveBeenCalledOnce()
  })

  it('stores and renders auto-preview results in one explicit operation', () => {
    const renderPlaces = vi.fn()
    const state = createNearbyResultsState({ renderPlaces, renderEndpoints: vi.fn() })

    state.storeAndRenderMap(presentation)

    expect(renderPlaces).toHaveBeenCalledWith([22.997, 120.212], presentation.places)
  })
})
