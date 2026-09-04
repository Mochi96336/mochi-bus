import { describe, expect, it, vi } from 'vitest'
import type { FavoriteBoard } from '../boards/store'
import { recoverLegacyBoardPlace, type StopPlaceIdentity } from './legacy-place-recovery'

function board(overrides: Partial<FavoriteBoard> = {}): FavoriteBoard {
  return {
    version: 2,
    id: 'legacy',
    title: '台北車站',
    city: 'Taipei',
    buses: [
      { city: 'Taipei', routeName: '307', routeUid: 'TPE1', stopUid: 'STOP1', direction: 0 },
      { city: 'Taipei', routeName: '299', routeUid: 'TPE2', stopUid: 'STOP2', direction: 1 },
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

const place: StopPlaceIdentity = {
  placeId: 'PLACE1',
  name: '台北車站',
  latitude: 25.0478,
  longitude: 121.517,
}

describe('legacy ETA board place recovery', () => {
  it('upgrades a legacy multi-route board when every StopUID maps to one place', async () => {
    const resolve = vi.fn().mockResolvedValue(place)

    const recovered = await recoverLegacyBoardPlace(board(), resolve)

    expect(resolve).toHaveBeenCalledTimes(2)
    expect(resolve).toHaveBeenNthCalledWith(1, 'Taipei', 'STOP1')
    expect(resolve).toHaveBeenNthCalledWith(2, 'Taipei', 'STOP2')
    expect(recovered).toMatchObject({
      city: 'Taipei',
      placeId: 'PLACE1',
      latitude: place.latitude,
      longitude: place.longitude,
    })
  })

  it('does not collapse a malformed board whose StopUIDs map to different places', async () => {
    const original = board()
    const resolve = vi.fn()
      .mockResolvedValueOnce(place)
      .mockResolvedValueOnce({ ...place, placeId: 'PLACE2' })

    await expect(recoverLegacyBoardPlace(original, resolve)).resolves.toBe(original)
  })

  it('keeps the legacy fallback when any bus lacks a StopUID', async () => {
    const original = board({ buses: [
      { city: 'Taipei', routeName: '307', routeUid: 'TPE1', direction: 0 },
    ] })
    const resolve = vi.fn()

    await expect(recoverLegacyBoardPlace(original, resolve)).resolves.toBe(original)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('does not re-resolve boards that already have stable place identity', async () => {
    const original = board({ placeId: 'PLACE1' })
    const resolve = vi.fn()

    await expect(recoverLegacyBoardPlace(original, resolve)).resolves.toBe(original)
    expect(resolve).not.toHaveBeenCalled()
  })
})
