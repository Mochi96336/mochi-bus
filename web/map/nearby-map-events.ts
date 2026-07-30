import type { NearbyOrigin } from './nearby-places-view'

export type NearbyCameraFocusListener = (origin: NearbyOrigin) => void

const listeners = new Set<NearbyCameraFocusListener>()

export function publishNearbyCameraFocus(origin: NearbyOrigin): void {
  const snapshot: NearbyOrigin = [...origin]
  for (const listener of listeners) listener(snapshot)
}

export function subscribeNearbyCameraFocus(listener: NearbyCameraFocusListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
