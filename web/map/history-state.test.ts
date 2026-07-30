import { describe, expect, it } from 'vitest'
import { NEARBY_AUTO_PREVIEW_ORIGIN_KEY } from './nearby-auto-preview-history'
import {
  canonicalMapHistoryState,
  mapViewFromUrl,
  planInitialMapHistory,
  planMapHistoryBack,
  planMapHistoryPush,
  readMapView,
} from './history-state'

const cities = [
  { code: 'Taipei', region: 'north' },
  { code: 'Kaohsiung', region: 'south' },
]
const validRegions = new Set(['north', 'south'])

describe('map history state', () => {
  it('derives the visible map view from shareable URL state', () => {
    expect(mapViewFromUrl(new URLSearchParams())).toBe('overview')
    expect(mapViewFromUrl(new URLSearchParams('region=north'))).toBe('region')
    expect(mapViewFromUrl(new URLSearchParams('city=Taipei'))).toBe('catalogue')
    expect(mapViewFromUrl(new URLSearchParams('city=Taipei&route=307'))).toBe('route')
    expect(mapViewFromUrl(new URLSearchParams('city=Taipei&stopUid=TPE1'))).toBe('place')
    expect(mapViewFromUrl(new URLSearchParams('city=Taipei&lat=25&lon=121'))).toBe('nearby')
    expect(mapViewFromUrl(new URLSearchParams('city=Taipei&trip=select'))).toBe('trip-select')
    expect(mapViewFromUrl(new URLSearchParams('city=Taipei&trip=results'))).toBe('trip-results')
  })

  it('accepts only known views from browser history', () => {
    expect(readMapView({ mapView: 'route' })).toBe('route')
    expect(readMapView({ mapView: 'unknown' })).toBeUndefined()
    expect(readMapView([])).toBeUndefined()
  })

  it('canonicalizes history while preserving unrelated view state', () => {
    const canonical = canonicalMapHistoryState(
      { mapView: 'catalogue', mapParent: 'region', routeScrollTop: 240 },
      new URLSearchParams('city=Taipei&route=307'),
    )
    expect(canonical).toEqual({
      view: 'route',
      state: { mapView: 'route', mapParent: 'catalogue', routeScrollTop: 240 },
      changed: true,
    })
  })

  it('removes a stale parent from the overview state', () => {
    const canonical = canonicalMapHistoryState(
      { mapView: 'route', mapParent: 'catalogue', marker: 'keep' },
      new URLSearchParams(),
    )
    expect(canonical.state).toEqual({ mapView: 'overview', marker: 'keep' })
  })

  it('does not rewrite an already canonical state', () => {
    expect(canonicalMapHistoryState(
      { mapView: 'place', mapParent: 'catalogue' },
      new URLSearchParams('city=Taipei&place=p1'),
    ).changed).toBe(false)
  })

  it('keeps the first detail as a browser entry and compresses later detail exploration', () => {
    const catalogue = { mapView: 'catalogue', mapParent: 'region', routeCatalogue: { scrollTop: 240 } }
    const route = planMapHistoryPush(catalogue, '/map?city=Taipei', {
      ...catalogue,
      mapView: 'route',
      mapParent: 'catalogue',
    })
    expect(route).toEqual({
      mode: 'push',
      state: {
        mapView: 'route',
        mapParent: 'catalogue',
        routeCatalogue: { scrollTop: 240 },
      },
    })

    const nearby = planMapHistoryPush(route.state, '/map?city=Taipei&route=307', {
      ...route.state as Record<string, unknown>,
      mapView: 'nearby',
      mapParent: 'route',
    })
    expect(nearby.mode).toBe('replace')
    expect(nearby.state).toMatchObject({
      mapView: 'nearby',
      mapParent: 'route',
      mapDetailTrail: [{
        view: 'route',
        url: '/map?city=Taipei&route=307',
        state: { mapView: 'route', mapParent: 'catalogue' },
      }],
    })

    const place = planMapHistoryPush(nearby.state, '/map?city=Taipei&lat=25&lon=121', {
      ...nearby.state as Record<string, unknown>,
      mapView: 'place',
      mapParent: 'nearby',
    })
    expect(place.mode).toBe('replace')
    expect((place.state as { mapDetailTrail: unknown[] }).mapDetailTrail).toHaveLength(2)
  })

  it('adds a hidden nearby step when map auto-preview opens a place from the catalogue', () => {
    const catalogue = {
      mapView: 'catalogue',
      mapParent: 'region',
      routeCatalogue: { scrollTop: 240 },
      [NEARBY_AUTO_PREVIEW_ORIGIN_KEY]: [25.033, 121.565],
    }
    const place = planMapHistoryPush(catalogue, '/map?city=Taipei', {
      ...catalogue,
      mapView: 'place',
      mapParent: 'catalogue',
    })

    expect(place).toEqual({
      mode: 'push',
      state: {
        mapView: 'place',
        mapParent: 'nearby',
        routeCatalogue: { scrollTop: 240 },
        mapDetailTrail: [{
          view: 'nearby',
          url: '/map?city=Taipei&lat=25.03300&lon=121.56500',
          state: {
            mapView: 'nearby',
            mapParent: 'catalogue',
            routeCatalogue: { scrollTop: 240 },
          },
        }],
      },
    })
    expect(planMapHistoryBack(place.state)).toEqual({
      url: '/map?city=Taipei&lat=25.03300&lon=121.56500',
      state: {
        mapView: 'nearby',
        mapParent: 'catalogue',
        routeCatalogue: { scrollTop: 240 },
      },
    })
  })

  it('keeps route-stop auto-preview returning directly to the route', () => {
    const route = {
      mapView: 'route',
      mapParent: 'catalogue',
      [NEARBY_AUTO_PREVIEW_ORIGIN_KEY]: [25.033, 121.565],
    }
    const place = planMapHistoryPush(route, '/map?city=Taipei&route=307', {
      ...route,
      mapView: 'place',
      mapParent: 'route',
    })

    expect(place).toEqual({
      mode: 'replace',
      state: {
        mapView: 'place',
        mapParent: 'route',
        mapDetailTrail: [{
          view: 'route',
          url: '/map?city=Taipei&route=307',
          state: { mapView: 'route', mapParent: 'catalogue' },
        }],
      },
    })
  })

  it('replaces the previous hidden nearby step when selecting another map point', () => {
    const current = {
      mapView: 'place',
      mapParent: 'nearby',
      mapDetailTrail: [{
        view: 'nearby',
        url: '/map?city=Taipei&lat=25.00000&lon=121.50000',
        state: { mapView: 'nearby', mapParent: 'catalogue' },
      }],
      [NEARBY_AUTO_PREVIEW_ORIGIN_KEY]: [25.033, 121.565],
    }
    const next = planMapHistoryPush(current, '/map?city=Taipei&place=P1', {
      ...current,
      mapView: 'place',
      mapParent: 'place',
    })

    expect(next.mode).toBe('replace')
    expect(next.state).toEqual({
      mapView: 'place',
      mapParent: 'nearby',
      mapDetailTrail: [{
        view: 'nearby',
        url: '/map?city=Taipei&lat=25.03300&lon=121.56500',
        state: { mapView: 'nearby', mapParent: 'catalogue' },
      }],
    })
  })

  it('does not grow the detail trail when replacing the same kind of detail', () => {
    const current = {
      mapView: 'nearby',
      mapParent: 'route',
      mapDetailTrail: [{
        view: 'route',
        url: '/map?city=Taipei&route=307',
        state: { mapView: 'route', mapParent: 'catalogue' },
      }],
    }
    const next = planMapHistoryPush(current, '/map?city=Taipei&lat=25&lon=121', {
      ...current,
      mapView: 'nearby',
      point: 'next',
    })
    expect(next.mode).toBe('replace')
    expect((next.state as { mapDetailTrail: unknown[] }).mapDetailTrail).toHaveLength(1)
  })

  it('pops the app detail trail without consuming browser history', () => {
    const place = {
      mapView: 'place',
      mapParent: 'nearby',
      mapDetailTrail: [
        {
          view: 'route',
          url: '/map?city=Taipei&route=307',
          state: { mapView: 'route', mapParent: 'catalogue' },
        },
        {
          view: 'nearby',
          url: '/map?city=Taipei&lat=25&lon=121',
          state: { mapView: 'nearby', mapParent: 'route' },
        },
      ],
    }
    const nearby = planMapHistoryBack(place)
    expect(nearby).toEqual({
      url: '/map?city=Taipei&lat=25&lon=121',
      state: {
        mapView: 'nearby',
        mapParent: 'route',
        mapDetailTrail: [{
          view: 'route',
          url: '/map?city=Taipei&route=307',
          state: { mapView: 'route', mapParent: 'catalogue' },
        }],
      },
    })
    expect(planMapHistoryBack(nearby!.state)).toEqual({
      url: '/map?city=Taipei&route=307',
      state: { mapView: 'route', mapParent: 'catalogue' },
    })
  })

  it('plans the complete browser history chain for a route deep link', () => {
    expect(planInitialMapHistory({
      state: null,
      params: new URLSearchParams('city=Taipei&route=307'),
      cities,
      validRegions,
      originalUrl: '/map?city=Taipei&route=307',
    })).toEqual([
      { mode: 'replace', state: { mapView: 'overview' }, url: '/map' },
      { mode: 'push', state: { mapView: 'region', mapParent: 'overview' }, url: '/map?region=north' },
      { mode: 'push', state: { mapView: 'catalogue', mapParent: 'region' }, url: '/map?city=Taipei' },
      { mode: 'push', state: { mapView: 'route', mapParent: 'catalogue' }, url: '/map?city=Taipei&route=307' },
    ])
  })

  it('keeps region deep links shallow and ignores unknown cities', () => {
    expect(planInitialMapHistory({
      state: null,
      params: new URLSearchParams('region=south'),
      cities,
      validRegions,
      originalUrl: '/map?region=south',
    })).toHaveLength(2)
    expect(planInitialMapHistory({
      state: null,
      params: new URLSearchParams('city=Unknown&route=1'),
      cities,
      validRegions,
      originalUrl: '/map?city=Unknown&route=1',
    })).toEqual([
      { mode: 'replace', state: { mapView: 'overview' }, url: '/map' },
    ])
  })

  it('leaves an existing map history chain untouched', () => {
    expect(planInitialMapHistory({
      state: { mapView: 'nearby', mapParent: 'catalogue' },
      params: new URLSearchParams('city=Taipei&lat=25&lon=121'),
      cities,
      validRegions,
      originalUrl: '/map?city=Taipei&lat=25&lon=121',
    })).toEqual([])
  })
})
