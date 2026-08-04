import { describe, expect, it } from 'vitest'
import {
  drawerKeyMatchesMapView,
  initialMapViewIsSettled,
  tileBatchIsReady,
} from './initial-view-gate'

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

  it('keeps the gate closed until the active tile batch has finished', () => {
    expect(tileBatchIsReady({ loaded: 0, pending: 0 })).toBe(false)
    expect(tileBatchIsReady({ loaded: 4, pending: 2 })).toBe(false)
    expect(tileBatchIsReady({ loaded: 6, pending: 0 })).toBe(true)
  })
})
