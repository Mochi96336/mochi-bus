import type { NearbyPlace } from './map-api-client'
import type { NearbyPlacesPresentation } from './nearby-places-controller'
import type { NearbyOrigin } from './nearby-places-view'

type NearbyResultsStateOptions = {
  renderPlaces: (origin: NearbyOrigin, places: readonly NearbyPlace[]) => void
  renderEndpoints: () => void
}

export type NearbyResultsSnapshot = {
  origin: [latitude: number, longitude: number]
  places: NearbyPlace[]
}

export type NearbyResultsState = {
  setOrigin(origin: NearbyOrigin): void
  store(presentation: NearbyPlacesPresentation): void
  storeAndRenderMap(presentation: NearbyPlacesPresentation): void
  replace(origin: NearbyOrigin, places: NearbyPlace[]): void
  current(): NearbyResultsSnapshot | undefined
  renderMap(): void
}

export function createNearbyResultsState(options: NearbyResultsStateOptions): NearbyResultsState {
  let origin: NearbyResultsSnapshot['origin'] | undefined
  let places: NearbyPlace[] = []

  function renderMap(): void {
    if (!origin) return
    options.renderPlaces(origin, places)
    options.renderEndpoints()
  }

  function store(presentation: NearbyPlacesPresentation): void {
    origin = [...presentation.origin]
    places = presentation.places
  }

  return {
    setOrigin(nextOrigin) {
      origin = [...nextOrigin]
    },
    store,
    storeAndRenderMap(presentation) {
      store(presentation)
      renderMap()
    },
    replace(nextOrigin, nextPlaces) {
      origin = [...nextOrigin]
      places = nextPlaces
    },
    current() {
      return origin ? { origin, places } : undefined
    },
    renderMap,
  }
}
