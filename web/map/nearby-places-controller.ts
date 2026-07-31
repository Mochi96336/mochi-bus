import type { NearbyPlace } from './map-api-client'

const DEFAULT_PLACE_LIMIT = 12

export type NearbyPreviewSource = 'map' | 'route-stop'

export type NearbyPlacesRequest = {
  cityCode: string
  origin: readonly [latitude: number, longitude: number]
  radiusMeters: number
  previewSource?: NearbyPreviewSource
}

export type NearbyPlacesPresentation = NearbyPlacesRequest & {
  places: NearbyPlace[]
}

export type NearbyPlacesFailure = NearbyPlacesRequest & {
  error: unknown
}

type NearbyPlacesControllerOptions = {
  currentCityCode: () => string | undefined
  beginRequest: () => { requestId: number; signal: AbortSignal }
  isStaleRequest: (requestId: number) => boolean
  loadNearby: (
    cityCode: string,
    latitude: number,
    longitude: number,
    radiusMeters: number,
    signal?: AbortSignal,
  ) => Promise<NearbyPlace[]>
  onStart: (request: NearbyPlacesRequest) => void
  onPlaces: (presentation: NearbyPlacesPresentation) => void
  onAutoPreview: (place: NearbyPlace, presentation: NearbyPlacesPresentation) => void | Promise<void>
  onError: (failure: NearbyPlacesFailure) => void
  placeLimit?: number
}

export type NearbyPlacesController = {
  load(request: NearbyPlacesRequest): Promise<boolean>
  invalidate(): void
}

export function createNearbyPlacesController(
  options: NearbyPlacesControllerOptions,
): NearbyPlacesController {
  const placeLimit = options.placeLimit ?? DEFAULT_PLACE_LIMIT
  if (!Number.isInteger(placeLimit) || placeLimit <= 0) {
    throw new Error('Nearby place limit must be a positive integer')
  }

  let generation = 0

  function isCurrent(requestGeneration: number, cityCode: string, requestId: number): boolean {
    return generation === requestGeneration
      && options.currentCityCode() === cityCode
      && !options.isStaleRequest(requestId)
  }

  async function load(request: NearbyPlacesRequest): Promise<boolean> {
    if (options.currentCityCode() !== request.cityCode) return false

    generation += 1
    const requestGeneration = generation
    options.onStart(request)
    const { requestId, signal } = options.beginRequest()

    try {
      const [latitude, longitude] = request.origin
      const loaded = await options.loadNearby(
        request.cityCode,
        latitude,
        longitude,
        request.radiusMeters,
        signal,
      )
      if (!isCurrent(requestGeneration, request.cityCode, requestId)) return false

      const presentation: NearbyPlacesPresentation = {
        ...request,
        places: loaded.slice(0, placeLimit),
      }
      const firstPlace = presentation.places[0]
      if (request.previewSource && firstPlace) {
        // The result list would exist for only one frame before the first place opens. Rendering it
        // expands the drawer and immediately collapses it into the next loading view, so bypass that
        // transient presentation and continue directly from nearby loading to place loading.
        await options.onAutoPreview(firstPlace, presentation)
      } else {
        options.onPlaces(presentation)
      }
      return true
    } catch (error) {
      if (!isCurrent(requestGeneration, request.cityCode, requestId)) return false
      options.onError({ ...request, error })
      return false
    }
  }

  return {
    load,
    // Shared navigation owns request abortion; this only suppresses this controller's callbacks.
    invalidate() {
      generation += 1
    },
  }
}
