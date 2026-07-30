import { describe, expect, it, vi } from 'vitest'
import type { NearbyPlacesPresentation } from './nearby-places-controller'
import { subscribeNearbyCameraTransitions } from './nearby-map-events'
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

  it('stores and renders auto-preview results in one explicit operation without cancelling their settle', () => {
    const renderPlaces = vi.fn()
    const cancel = vi.fn()
    const unsubscribe = subscribeNearbyCameraTransitions({ begin: vi.fn(), settle: vi.fn(), cancel })
    const state = createNearbyResultsState({ renderPlaces, renderEndpoints: vi.fn() })

    try {
      state.storeAndRenderMap(presentation)

      expect(renderPlaces).toHaveBeenCalledWith([22.997, 120.212], presentation.places)
      expect(cancel).not.toHaveBeenCalled()
    } finally {
      unsubscribe()
    }
  })

  it('keeps a pending origin separate from the last complete result', () => {
    const renderPlaces = vi.fn()
    const state = createNearbyResultsState({ renderPlaces, renderEndpoints: vi.fn() })
    state.store(presentation)

    state.setOrigin([23.123, 120.456])

    expect(state.current()).toEqual({ origin: [22.997, 120.212], places: presentation.places })
    state.renderMap()
    expect(renderPlaces).toHaveBeenCalledWith([22.997, 120.212], presentation.places)
  })

  it('uses an empty coherent fallback for the first pending origin', () => {
    const renderPlaces = vi.fn()
    const state = createNearbyResultsState({ renderPlaces, renderEndpoints: vi.fn() })

    state.setOrigin([23.123, 120.456])

    expect(state.current()).toEqual({ origin: [23.123, 120.456], places: [] })
    state.renderMap()
    expect(renderPlaces).toHaveBeenCalledWith([23.123, 120.456], [])
    expect(state.current()).toEqual({ origin: [23.123, 120.456], places: [] })
  })

  it('cancels an unfinished request transition before rendering cached places', () => {
    const order: string[] = []
    const unsubscribe = subscribeNearbyCameraTransitions({
      begin: vi.fn(),
      settle: vi.fn(),
      cancel: () => order.push('cancel'),
    })
    const state = createNearbyResultsState({
      renderPlaces: () => order.push('render'),
      renderEndpoints: () => order.push('endpoints'),
    })
    state.store(presentation)

    try {
      state.renderMap()
      expect(order).toEqual(['cancel', 'render', 'endpoints'])
    } finally {
      unsubscribe()
    }
  })
})
