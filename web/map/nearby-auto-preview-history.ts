export const NEARBY_AUTO_PREVIEW_ORIGIN_KEY = 'mapNearbyAutoPreviewOrigin'

export type NearbyAutoPreviewOrigin = readonly [latitude: number, longitude: number]

export function markNearbyAutoPreviewOrigin(origin: NearbyAutoPreviewOrigin): void {
  if (typeof history === 'undefined' || typeof location === 'undefined') return
  const current = history.state && typeof history.state === 'object' && !Array.isArray(history.state)
    ? history.state as Record<string, unknown>
    : {}
  history.replaceState({
    ...current,
    [NEARBY_AUTO_PREVIEW_ORIGIN_KEY]: [...origin],
  }, '', location.href)
}

export function readNearbyAutoPreviewOrigin(state: unknown): [number, number] | undefined {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return
  const value = (state as Record<string, unknown>)[NEARBY_AUTO_PREVIEW_ORIGIN_KEY]
  if (!Array.isArray(value) || value.length !== 2) return
  const [latitude, longitude] = value
  if (typeof latitude !== 'number' || !Number.isFinite(latitude)) return
  if (typeof longitude !== 'number' || !Number.isFinite(longitude)) return
  return [latitude, longitude]
}

export function withoutNearbyAutoPreviewOrigin(state: Record<string, unknown>): Record<string, unknown> {
  const next = { ...state }
  delete next[NEARBY_AUTO_PREVIEW_ORIGIN_KEY]
  return next
}
