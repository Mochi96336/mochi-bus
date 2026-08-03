import { describe, expect, it } from 'vitest'
import type { FavoriteBoard } from '../boards/store'
import { resolveHomeBoardState } from './home-board-state'

function board(id: string): FavoriteBoard {
  const now = '2026-08-02T00:00:00.000Z'
  return {
    version: 2,
    id,
    title: id,
    buses: [{ city: 'Chiayi', routeName: '中山幹線', direction: 0 }],
    createdAt: now,
    updatedAt: now,
  }
}

describe('home board state', () => {
  it('prefers a saved board over the configured demo', () => {
    const saved = board('saved')
    expect(resolveHomeBoardState(saved, board('demo'))).toEqual({ mode: 'saved', board: saved })
  })

  it('uses the demo only when there is no saved board', () => {
    const demo = board('demo')
    expect(resolveHomeBoardState(null, demo)).toEqual({ mode: 'demo', board: demo })
  })

  it('represents no saved board and no demo explicitly', () => {
    expect(resolveHomeBoardState(null, null)).toEqual({ mode: 'empty', board: null })
  })
})
