import L from 'leaflet'
import { bindTextTooltip } from './leaflet-tooltip'
import type { NearbyPlace } from './map-api-client'
import { NEARBY_ORIGIN_RENDERED_EVENT } from './nearby-map-events'
import type { NearbyOrigin } from './nearby-places-view'
import { stopFillAccent } from './theme'

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

  return {
    renderLoadingOrigin(origin) {
      options.layer.clearLayers()
      const marker = createOriginMarker(origin).addTo(options.layer)
      // Propagates through Leaflet's event parents to the map camera controller. The
      // controller only animates when this follows a real pointer interaction, so URL
      // hydration and retry renders keep their deterministic instant camera behavior.
      marker.fire(NEARBY_ORIGIN_RENDERED_EVENT, { origin: [...origin] }, true)
    },

    renderPlaces(origin, places) {
      options.layer.clearLayers()
      const originMarker = createOriginMarker(origin).addTo(options.layer)
      bindHoverTooltip(originMarker, '你點的位置')

      for (const place of places) {
        bindHoverTooltip(
          options.createStopMarker([place.latitude, place.longitude], true),
          `${place.name} · ${Math.round(place.distanceMeters)} m`,
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
