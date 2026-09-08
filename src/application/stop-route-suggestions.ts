import { selectBestEta } from '../domain/map/eta'
import {
  buildStopArrivalBatches,
  parseStopArrivalBatchPayload,
  STOP_ARRIVAL_MAX_RESPONSE_BYTES,
} from '../infrastructure/tdx/stop-arrivals'
import {
  getStopPlaceRoutes,
  type StopPlaceRoute,
} from '../infrastructure/transit/snapshot-place-routing-repository'
import {
  getStopPlaceByStopUid,
  type StopLookupPlace,
} from '../infrastructure/transit/snapshot-stop-lookup-repository'
import type { TransitBindings } from '../infrastructure/transit/snapshot-repository'
import {
  formatETALabel,
  isRejectedUserTdxToken,
  resolveTDXJson,
  type BusETAItem,
  type TDXEnv,
} from '../lib/tdx'
import type { TDXResolutionOptions } from '../lib/tdx/resolution-cache'

const STOP_ROUTE_ETA_CACHE_SECONDS = 15
const MAX_SUGGESTIONS = 40

export type StopRouteSuggestion = {
  city: string
  routeName: string
  routeUid: string
  subRouteUid?: string
  patternId: string
  stopName: string
  stopUid: string
  direction: 0 | 1 | 2
  directionLabel: string
  label?: string
}

export type StopRouteSuggestionResult = {
  place: {
    placeId: string
    name: string
    latitude: number
    longitude: number
  }
  buses: StopRouteSuggestion[]
}

type RealtimeResolver = (
  env: TDXEnv,
  url: URL,
  ttlSeconds: number,
  options: TDXResolutionOptions<unknown[]>,
) => Promise<unknown[]>

type StopRouteSuggestionDependencies = {
  getStopPlaceByStopUid: (
    env: TransitBindings,
    city: string,
    stopUid: string,
  ) => Promise<StopLookupPlace | null>
  getStopPlaceRoutes: (
    env: TransitBindings,
    city: string,
    placeId: string,
  ) => Promise<StopPlaceRoute[]>
  resolveRealtime: RealtimeResolver
  reportSnapshotFailure: (error: unknown) => void
  reportRealtimeFailure: (error: unknown) => void
}

const defaultDependencies: StopRouteSuggestionDependencies = {
  getStopPlaceByStopUid,
  getStopPlaceRoutes,
  resolveRealtime: async (env, url, ttlSeconds, options) => (
    await resolveTDXJson<unknown[]>(env, url, ttlSeconds, options)
  ).data,
  reportSnapshotFailure: (error) => console.error('stop_route_snapshot_fallback_failed', error),
  reportRealtimeFailure: (error) => console.error('stop_route_realtime_failed', error),
}

/**
 * Build setup "same stop" suggestions from the active snapshot whenever the
 * selected StopUID has stable place identity. Static Stop/Route lookups stay in
 * R2/D1 snapshot storage; TDX is used only for compact ETA batches.
 *
 * Returning null means the snapshot path is unavailable and the caller should
 * use the legacy TDX discovery path. Realtime failures do not discard the static
 * route list, while a rejected user token remains explicit at the API boundary.
 */
export async function getSnapshotStopRouteSuggestions(
  env: TDXEnv & TransitBindings,
  city: string,
  stopUid: string,
  dependencies: Partial<StopRouteSuggestionDependencies> = {},
): Promise<StopRouteSuggestionResult | null> {
  const deps = { ...defaultDependencies, ...dependencies }

  let place: StopLookupPlace | null
  let routes: StopPlaceRoute[]
  try {
    place = await deps.getStopPlaceByStopUid(env, city, stopUid)
    if (!place) return null
    routes = await deps.getStopPlaceRoutes(env, city, place.placeId)
    if (!routes.length) return null
  } catch (error) {
    deps.reportSnapshotFailure(error)
    return null
  }

  const etaItems: BusETAItem[] = []
  const candidates = routes.map((route) => ({
    routeUid: route.routeUid,
    routeName: route.routeName,
    stopUid: route.stopUid,
  }))

  for (const batch of buildStopArrivalBatches(city, candidates)) {
    const routeUids = [...new Set(batch.candidates.map((candidate) => candidate.routeUid))]
    try {
      const payload = await deps.resolveRealtime(env, batch.url, STOP_ROUTE_ETA_CACHE_SECONDS, {
        operation: 'place_arrivals',
        maxResponseBytes: STOP_ARRIVAL_MAX_RESPONSE_BYTES,
        validate: (value): value is unknown[] => (
          parseStopArrivalBatchPayload(value, batch.stopUids, routeUids).ok
        ),
      })
      const parsed = parseStopArrivalBatchPayload(payload, batch.stopUids, routeUids)
      if (parsed.ok) etaItems.push(...parsed.data)
    } catch (error) {
      if (isRejectedUserTdxToken(error, env.TDX_USER_ACCESS_TOKEN)) throw error
      deps.reportRealtimeFailure(error)
    }
  }

  const buses = dedupeRoutes(routes)
    .map((route): StopRouteSuggestion => {
      const realtime = selectBestEta(etaItems, {
        routeUid: route.routeUid,
        subRouteUid: route.subRouteUid,
        stopUid: route.stopUid,
        direction: route.direction,
      })
      const label = realtime
        ? formatETALabel(
            typeof realtime.EstimateTime === 'number'
              ? Math.ceil(Math.max(0, realtime.EstimateTime) / 60)
              : null,
            realtime.StopStatus ?? 0,
          )
        : undefined
      return {
        city,
        routeName: route.routeName,
        routeUid: route.routeUid,
        ...(route.subRouteUid ? { subRouteUid: route.subRouteUid } : {}),
        patternId: route.variantKey,
        stopName: route.stopName,
        stopUid: route.stopUid,
        direction: route.direction,
        directionLabel: route.label,
        ...(label ? { label } : {}),
      }
    })
    .sort((left, right) => left.routeName.localeCompare(right.routeName, 'zh-Hant', { numeric: true })
      || left.direction - right.direction
      || left.stopUid.localeCompare(right.stopUid))
    .slice(0, MAX_SUGGESTIONS)

  return {
    place: {
      placeId: place.placeId,
      name: place.name,
      latitude: place.latitude,
      longitude: place.longitude,
    },
    buses,
  }
}

function dedupeRoutes(routes: StopPlaceRoute[]): StopPlaceRoute[] {
  return [...new Map(routes.map((route) => [[
    route.variantKey,
    route.stopUid,
    route.direction,
  ].join('\u0000'), route])).values()]
}
