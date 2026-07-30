import type { NearbyOrigin } from './nearby-places-view'

export type NearbyCameraTransitionListener = {
  begin(origin: NearbyOrigin): void
  settle(position: NearbyOrigin): void
}

const listeners = new Set<NearbyCameraTransitionListener>()

export function publishNearbyCameraBegin(origin: NearbyOrigin): void {
  const snapshot: NearbyOrigin = [...origin]
  for (const listener of listeners) listener.begin(snapshot)
}

export function publishNearbyCameraSettle(position: NearbyOrigin): void {
  const snapshot: NearbyOrigin = [...position]
  for (const listener of listeners) listener.settle(snapshot)
}

export function subscribeNearbyCameraTransitions(
  listener: NearbyCameraTransitionListener,
): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
