import { beforeEach, describe, expect, it, vi } from 'vitest'
import type L from 'leaflet'
import type { NearbyPlace } from './map-api-client'
import { subscribeNearbyCameraTransitions } from './nearby-map-events'
import type { NearbyOrigin } from './nearby-places-view'

const mocks = vi.hoisted(() => ({
  bindTextTooltip: vi.fn(<T>(layer: T): T => layer),
  stopPropagation: vi.fn(),
}))

vi.mock('leaflet', () => ({
  default: { DomEvent: { stopPropagation: mocks.stopPropagation } },
}))
vi.mock('./leaflet-tooltip', () => ({ bindTextTooltip: mocks.bindTextTooltip }))

import { createNearbyPlacesMap } from './nearby-places-map'
import { stopFillAccent } from './theme'

class FakeLayerGroup {
  markers: FakeMarker[] = []
  clearLayers = vi.fn(() => {
    this.markers = []
    return this
  })
}

class FakeMarker {
  private readonly listeners = new Map<string, (event: unknown) => void>()

  constructor(
    readonly position: L.LatLngExpression,
    readonly prominent: boolean | undefined,
    readonly fillColor: string | undefined,
  ) {}

  addTo(layer: FakeLayerGroup): this {
    layer.markers.push(this)
    return this
  }

  on(type: string, listener: (event: unknown) => void): this {
    this.listeners.set(type, listener)
    return this
  }

  fire(type: string, event: unknown): void {
    this.listeners.get(type)?.(event)
  }
}

function place(index: number, distanceMeters: number): NearbyPlace {
  return {
    placeId: `P${index}`,
    name: `Place ${index}`,
    latitude: 25 + index / 1000,
    longitude: 121 + index / 1000,
    distanceMeters,
  }
}

function createHarness(hoverCapable = true) {
  const layer = new FakeLayerGroup()
  const markers: FakeMarker[] = []
  const createStopMarker = vi.fn((position: L.LatLngExpression, prominent?: boolean, fillColor?: string) => {
    const marker = new FakeMarker(position, prominent, fillColor)
    markers.push(marker)
    return marker as unknown as L.CircleMarker
  })
  const onOpenPlace = vi.fn()
  const mapSurface = createNearbyPlacesMap({
    layer: layer as unknown as L.LayerGroup,
    hoverCapable,
    createStopMarker,
    onOpenPlace,
  })
  return { layer, markers, createStopMarker, onOpenPlace, mapSurface }
}

const origin: NearbyOrigin = [25.01234, 121.56789]

beforeEach(() => {
  vi.clearAllMocks()
})

describe('Nearby places map', () => {
  it('renders the loading origin and explicitly begins the camera transition', () => {
    const harness = createHarness()
    const begin = vi.fn()
    const settle = vi.fn()
    const unsubscribe = subscribeNearbyCameraTransitions({ begin, settle })

    harness.mapSurface.renderLoadingOrigin(origin)

    expect(harness.layer.clearLayers).toHaveBeenCalledOnce()
    expect(harness.createStopMarker).toHaveBeenCalledWith([...origin], true, stopFillAccent)
    expect(harness.layer.markers).toEqual([harness.markers[0]])
    expect(begin).toHaveBeenCalledWith(origin)
    expect(settle).not.toHaveBeenCalled()
    expect(mocks.bindTextTooltip).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('renders markers and explicitly settles on the nearest place', () => {
    const harness = createHarness()
    const places = [place(1, 120.4), place(2, 48.7)]
    const begin = vi.fn()
    const settle = vi.fn()
    const unsubscribe = subscribeNearbyCameraTransitions({ begin, settle })

    harness.mapSurface.renderPlaces(origin, places)

    expect(harness.layer.markers).toHaveLength(3)
    expect(harness.createStopMarker).toHaveBeenNthCalledWith(1, [...origin], true, stopFillAccent)
    expect(harness.createStopMarker).toHaveBeenNthCalledWith(2, [places[0].latitude, places[0].longitude], true)
    expect(harness.createStopMarker).toHaveBeenNthCalledWith(3, [places[1].latitude, places[1].longitude], true)
    expect(mocks.bindTextTooltip).toHaveBeenNthCalledWith(1, harness.markers[0], '你點的位置')
    expect(mocks.bindTextTooltip).toHaveBeenNthCalledWith(2, harness.markers[1], 'Place 1 · 120 m')
    expect(mocks.bindTextTooltip).toHaveBeenNthCalledWith(3, harness.markers[2], 'Place 2 · 49 m')
    expect(settle).toHaveBeenCalledWith([places[0].latitude, places[0].longitude])
    unsubscribe()
  })

  it('does not settle when the nearby result is empty', () => {
    const harness = createHarness()
    const settle = vi.fn()
    const unsubscribe = subscribeNearbyCameraTransitions({ begin: vi.fn(), settle })

    harness.mapSurface.renderPlaces(origin, [])

    expect(settle).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('stops map propagation and delegates the selected place', () => {
    const harness = createHarness()
    const selected = place(1, 120)
    const event = { type: 'click' }
    harness.mapSurface.renderPlaces(origin, [selected])

    harness.markers[1].fire('click', event)

    expect(mocks.stopPropagation).toHaveBeenCalledWith(event)
    expect(harness.onOpenPlace).toHaveBeenCalledWith(selected)
  })

  it('omits hover tooltips when the device cannot hover', () => {
    const harness = createHarness(false)

    harness.mapSurface.renderPlaces(origin, [place(1, 120)])

    expect(mocks.bindTextTooltip).not.toHaveBeenCalled()
    expect(harness.layer.markers).toHaveLength(2)
  })
})
