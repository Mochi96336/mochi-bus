import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  drawerKeyMatchesMapView,
  initialMapViewIsSettled,
  mapGateTargetChanged,
  tileBatchIsReady,
} from './initial-view-gate'

const initialViewGateCss = readFileSync(
  new URL('./initial-view-gate.css', import.meta.url),
  'utf8',
)

describe('initial map view gate', () => {
  it('does not reveal a place deep link while the overview or catalogue is visible', () => {
    expect(initialMapViewIsSettled({
      expected: 'place',
      historyState: { mapView: 'place' },
      drawerKey: 'overview',
      statusText: '選一個區域',
    })).toBe(false)
    expect(initialMapViewIsSettled({
      expected: 'place',
      historyState: { mapView: 'place' },
      drawerKey: 'catalogue:Taipei',
      statusText: '台北市 · 正在整理路線…',
    })).toBe(false)
  })

  it('reveals only the matching settled surface', () => {
    expect(drawerKeyMatchesMapView('place', 'place:Taipei:TPE:123')).toBe(true)
    expect(initialMapViewIsSettled({
      expected: 'place',
      historyState: { mapView: 'place' },
      drawerKey: 'place:Taipei:TPE:123',
      statusText: '',
    })).toBe(true)
  })

  it('releases the old gate when navigation changes the target URL', () => {
    expect(mapGateTargetChanged(
      'place',
      new URLSearchParams('city=NewTaipei&place=NWT%3Ajing-an'),
    )).toBe(false)
    expect(mapGateTargetChanged(
      'place',
      new URLSearchParams('city=NewTaipei'),
    )).toBe(true)
    expect(mapGateTargetChanged(
      'place',
      new URLSearchParams(),
    )).toBe(true)
  })

  it('keeps the gate closed until the active tile batch has finished', () => {
    expect(tileBatchIsReady({ loaded: 0, pending: 0 })).toBe(false)
    expect(tileBatchIsReady({ loaded: 4, pending: 2 })).toBe(false)
    expect(tileBatchIsReady({ loaded: 6, pending: 0 })).toBe(true)
  })

  it('covers the complete Leaflet scene, including custom route and marker panes', () => {
    expect(initialViewGateCss).toContain(
      'html[data-mochi-map-booting="true"] .leaflet-map-pane',
    )
  })
})
