import type L from 'leaflet'
import type { NearbyOrigin } from './nearby-places-view'

export const NEARBY_ORIGIN_RENDERED_EVENT = 'mochi:nearby-origin-rendered'

export type NearbyOriginRenderedEvent = L.LeafletEvent & {
  origin: NearbyOrigin
}
