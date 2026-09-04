import type { FavoriteBoard } from '../boards/store'

export type StopPlaceIdentity = {
  placeId: string
  name: string
  latitude: number
  longitude: number
}

export type StopPlaceResolver = (
  city: string,
  stopUid: string,
) => Promise<StopPlaceIdentity | null>

// Old boards predate placeId. Recover it from snapshot-only StopUID lookups so the
// homepage can switch from one /eta call per bus to the existing batched place-arrivals path.
// Every bus must resolve to the same physical place; otherwise preserve the legacy fallback.
export async function recoverLegacyBoardPlace(
  board: FavoriteBoard,
  resolveStopPlace: StopPlaceResolver,
): Promise<FavoriteBoard> {
  if (board.placeId || !board.buses.length) return board
  const city = board.city ?? board.buses[0]?.city
  if (!city || board.buses.some((bus) => bus.city && bus.city !== city)) return board
  if (board.buses.some((bus) => !bus.stopUid)) return board

  const stopUids = [...new Set(board.buses.map((bus) => bus.stopUid as string))]
  const places = await Promise.all(stopUids.map((stopUid) => resolveStopPlace(city, stopUid)))
  const first = places[0]
  if (!first || places.some((place) => !place || place.placeId !== first.placeId)) return board

  return {
    ...board,
    city,
    placeId: first.placeId,
    latitude: first.latitude,
    longitude: first.longitude,
  }
}
