import type { NearbyPlace } from './map-api-client'
import { publishNearbyCameraCancel } from './nearby-map-events'
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
  let committed: NearbyResultsSnapshot | undefined
  let pendingOrigin: NearbyResultsSnapshot['origin'] | undefined

  function cloneSnapshot(snapshot: NearbyResultsSnapshot): NearbyResultsSnapshot {
    return { origin: [...snapshot.origin], places: [...snapshot.places] }
  }

  function displaySnapshot(): NearbyResultsSnapshot | undefined {
    if (committed) return committed
    if (pendingOrigin) return { origin: [...pendingOrigin], places: [] }
  }

  function renderSnapshot(snapshot: NearbyResultsSnapshot, allowRequestSettle: boolean): void {
    // Cached/back-navigation renders are not request completions. Retire any unfinished
    // transition before the map surface republishes its nearest-place settle event.
    if (!allowRequestSettle) publishNearbyCameraCancel()
    const { origin, places } = snapshot
    options.renderPlaces(origin, places)
    options.renderEndpoints()
  }

  function store(presentation: NearbyPlacesPresentation): void {
    committed = {
      origin: [...presentation.origin],
      places: [...presentation.places],
    }
    pendingOrigin = undefined
  }

  return {
    // Loading owns a pending origin, not half of the last successful snapshot. If the
    // request fails, returning to Nearby either restores the previous complete result
    // or shows an empty result at the first requested origin.
    setOrigin(nextOrigin) {
      pendingOrigin = [...nextOrigin]
    },
    store,
    storeAndRenderMap(presentation) {
      store(presentation)
      if (committed) renderSnapshot(committed, true)
    },
    replace(nextOrigin, nextPlaces) {
      committed = { origin: [...nextOrigin], places: [...nextPlaces] }
      pendingOrigin = undefined
    },
    current() {
      const snapshot = displaySnapshot()
      return snapshot ? cloneSnapshot(snapshot) : undefined
    },
    renderMap() {
      const snapshot = displaySnapshot()
      if (!snapshot) return
      if (!committed) committed = cloneSnapshot(snapshot)
      pendingOrigin = undefined
      renderSnapshot(committed, false)
    },
  }
}
