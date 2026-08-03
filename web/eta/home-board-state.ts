import type { FavoriteBoard } from '../boards/store'

export type HomeBoardState =
  | { mode: 'saved'; board: FavoriteBoard }
  | { mode: 'demo'; board: FavoriteBoard }
  | { mode: 'empty'; board: null }

export function resolveHomeBoardState(
  savedBoard: FavoriteBoard | null,
  demoBoard: FavoriteBoard | null,
): HomeBoardState {
  if (savedBoard) return { mode: 'saved', board: savedBoard }
  if (demoBoard) return { mode: 'demo', board: demoBoard }
  return { mode: 'empty', board: null }
}
