import { describe, expect, it, vi } from 'vitest'
import type { RouteMapVariant } from '../domain/map/map-model'
import type { TransitBindings } from '../infrastructure/transit/snapshot-pattern-stop-repository'
import { getSnapshotRouteStopGroups } from './snapshot-route-stop-groups'

const env = {} as TransitBindings

function variant(overrides: Partial<RouteMapVariant> = {}): RouteMapVariant {
  return {
    variantKey: 'P1',
    routeName: '300',
    routeUid: 'TXG300',
    subRouteUid: 'TXG300-A',
    direction: 0,
    label: 'metadata label',
    subRouteName: '300',
    shape: {
      type: 'Feature',
      properties: { routeUid: 'TXG300', direction: 0 },
      geometry: {
        type: 'LineString',
        coordinates: [[120.6, 24.1], [120.7, 24.2]],
      },
    },
    stops: {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { stopUid: 'S1', stopName: 'Alpha', sequence: 1 },
          geometry: { type: 'Point', coordinates: [120.6, 24.1] },
        },
        {
          type: 'Feature',
          properties: { stopUid: 'S2', stopName: 'Beta', sequence: 2 },
          geometry: { type: 'Point', coordinates: [120.7, 24.2] },
        },
      ],
    },
    updatedAt: null,
    ...overrides,
  }
}

describe('snapshot route stop groups', () => {
  it('keeps only the selected RouteUID and preserves the setup stop contract', async () => {
    const loadVariants = vi.fn().mockResolvedValue([
      variant(),
      variant({ variantKey: 'OTHER', routeUid: 'OTHER300', subRouteUid: 'OTHER300-A' }),
    ])

    const groups = await getSnapshotRouteStopGroups(env, 'Taichung', '300', 'TXG300', loadVariants)

    expect(loadVariants).toHaveBeenCalledWith(env, 'Taichung', '300')
    expect(groups).toEqual([{
      direction: 0,
      label: 'Alpha → Beta',
      routeUid: 'TXG300',
      subRouteUid: 'TXG300-A',
      subRouteName: '300',
      stops: [
        {
          routeUid: 'TXG300', subRouteUid: 'TXG300-A', subRouteName: '300',
          stopUid: 'S1', stopName: 'Alpha', direction: 0, sequence: 1,
          position: { latitude: 24.1, longitude: 120.6 },
        },
        {
          routeUid: 'TXG300', subRouteUid: 'TXG300-A', subRouteName: '300',
          stopUid: 'S2', stopName: 'Beta', direction: 0, sequence: 2,
          position: { latitude: 24.2, longitude: 120.7 },
        },
      ],
    }])
  })

  it('returns an empty result when snapshot loading fails so TDX can remain the fallback', async () => {
    const loadVariants = vi.fn().mockRejectedValue(new Error('R2 unavailable'))

    await expect(getSnapshotRouteStopGroups(
      env,
      'Taichung',
      '300',
      'TXG300',
      loadVariants,
    )).resolves.toEqual([])
  })

  it('returns empty when the snapshot only contains a same-name different route', async () => {
    const loadVariants = vi.fn().mockResolvedValue([
      variant({ routeUid: 'OTHER300', subRouteUid: 'OTHER300-A' }),
    ])

    await expect(getSnapshotRouteStopGroups(
      env,
      'Taichung',
      '300',
      'TXG300',
      loadVariants,
    )).resolves.toEqual([])
  })
})
