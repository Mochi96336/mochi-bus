import L from 'leaflet'
import { bindTextTooltip } from './leaflet-tooltip'
import type { NearbyPlace } from './map-api-client'
import { publishNearbyCameraFocus } from './nearby-map-events'
import type { NearbyOrigin } from './nearby-places-view'
import { stopFillAccent } from './theme'

const NEAREST_RADIUS_SCALE = 1.12
const NEAREST_STROKE_WEIGHT = 3.2

type NearbyPlacesMapOptions = {
  layer: L.LayerGroup
  hoverCapable: boolean
  createStopMarker: (
    position: L.LatLngExpression,
    prominent?: boolean,
    fillColor?: string,
  ) => L.CircleMarker
  onOpenPlace: (place: NearbyPlace) => void | Promise<void>
}

export type NearbyPlacesMap = {
  renderLoadingOrigin(origin: NearbyOrigin): void
  renderPlaces(origin: NearbyOrigin, places: readonly NearbyPlace[]): void
}

// Leaflet-only Nearby Places surface. Request lifecycle, Drawer presentation, History,
// status, Trip state, camera behavior and place navigation remain in the app shell.
export function createNearbyPlacesMap(options: NearbyPlacesMapOptions): NearbyPlacesMap {
  function bindHoverTooltip<T extends L.Layer>(layer: T, text: string): T {
    if (options.hoverCapable) bindTextTooltip(layer, text)
    return layer
  }

  function createOriginMarker(origin: NearbyOrigin): L.CircleMarker {
    return options.createStopMarker([...origin], true, stopFillAccent)
  }

  function emphasizeNearest(marker: L.CircleMarker): L.CircleMarker {
    marker.setRadius(marker.getRadius() * NEAREST_RADIUS_SCALE)
    marker.setStyle({ weight: NEAREST_STROKE_WEIGHT })
    return marker
  }

  return {
    renderLoadingOrigin(origin) {
      options.layer.clearLayers()
      createOriginMarker(origin).addTo(options.layer)
      publishNearbyCameraFocus(origin)
    },

    renderPlaces(origin, places) {
      options.layer.clearLayers()
      const originMarker = createOriginMarker(origin).addTo(options.layer)
      bindHoverTooltip(originMarker, '你點的位置')

      for (const [index, place] of places.entries()) {
        const nearest = index === 0
        const marker = options.createStopMarker([place.latitude, place.longitude], true)
        if (nearest) emphasizeNearest(marker)

        bindHoverTooltip(
          marker,
          `${nearest ? '最近 · ' : ''}${place.name} · ${Math.round(place.distanceMeters)} m`,
        )
          .on('click', (event) => {
            L.DomEvent.stopPropagation(event)
            void options.onOpenPlace(place)
          })
          .addTo(options.layer)
      }
    },
  }
}
