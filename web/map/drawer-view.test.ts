import { describe, expect, it } from 'vitest'
import {
  drawerMinHeightForTransition,
  drawerScrollTopForTransition,
  drawerSizeForView,
  drawerSizeMemoryKey,
  shouldAnimateDrawerTransition,
  shouldPreserveDrawerHeight,
} from './drawer-view'

describe('drawer view transitions', () => {
  it('does not animate initial paint or a refresh of the same navigation view', () => {
    expect(shouldAnimateDrawerTransition(undefined, 'place:CHI:stop-1')).toBe(false)
    expect(shouldAnimateDrawerTransition('place:CHI:stop-1', 'place:CHI:stop-1')).toBe(false)
  })

  it('animates navigation to another view or identity', () => {
    expect(shouldAnimateDrawerTransition('catalogue:CHI', 'route:CHI:7211')).toBe(true)
    expect(shouldAnimateDrawerTransition('place:CHI:stop-1', 'place:CHI:stop-2')).toBe(true)
  })

  it('keeps scroll position when refreshing the same view and resets it on navigation', () => {
    expect(drawerScrollTopForTransition('trip-results:A:B', 'trip-results:A:B', 240)).toBe(240)
    expect(drawerScrollTopForTransition('trip-results:A:B', 'trip-results:A:C', 240)).toBe(0)
    expect(drawerScrollTopForTransition(undefined, 'trip-results:A:B', 240)).toBe(0)
    expect(drawerScrollTopForTransition('trip-results:A:B', 'trip-results:A:B', -20)).toBe(0)
  })

  it('shares timetable size memory across stop content identities', () => {
    const firstStop = {
      key: 'timetable:ChiayiCounty:CHI-7211:0:C1',
      mode: 'timetable' as const,
      header: [],
      content: [],
    }
    const secondStop = {
      key: 'timetable:ChiayiCounty:CHI-7211:0:C2',
      mode: 'timetable' as const,
      header: [],
      content: [],
    }

    expect(drawerSizeMemoryKey(firstStop)).toBe('timetable:ChiayiCounty:CHI-7211:0')
    expect(drawerSizeMemoryKey(secondStop)).toBe('timetable:ChiayiCounty:CHI-7211:0')
    expect(drawerScrollTopForTransition(firstStop.key, secondStop.key, 240)).toBe(0)
    expect(drawerSizeMemoryKey({ ...secondStop, sizeKey: 'custom:timetable' })).toBe('custom:timetable')
  })

  it('keeps catalogue loading and failure in the standard workspace', () => {
    expect(drawerSizeForView({
      key: 'catalogue:Tainan',
      mode: 'compact',
      content: [],
    }, undefined)).toBe('standard')
    expect(drawerSizeForView({
      key: 'catalogue:Tainan',
      mode: 'compact',
      size: 'compact',
      content: [],
    }, undefined)).toBe('compact')
    expect(drawerSizeForView({
      key: 'region:south',
      mode: 'compact',
      content: [],
    }, undefined)).toBe('content')
  })

  it('restores the remembered workspace before falling back from a content mode', () => {
    expect(drawerSizeForView({
      key: 'place:Tainan:busy-stop',
      mode: 'map-list',
      header: [],
      content: [],
    }, 'tall')).toBe('tall')
    expect(drawerSizeForView({
      key: 'timetable:Tainan:R1:',
      mode: 'timetable',
      header: [],
      content: [],
    }, 'compact')).toBe('compact')
    expect(drawerSizeForView({
      key: 'timetable:Tainan:R2:',
      mode: 'timetable',
      header: [],
      content: [],
    }, undefined)).toBe('standard')
  })

  it('lets an explicit final size replace a remembered loading size', () => {
    expect(drawerSizeForView({
      key: 'place:Tainan:busy-stop',
      mode: 'map-list',
      size: 'standard',
      header: [],
      content: [],
    }, 'tall')).toBe('standard')
  })

  it('uses the previous measured height only for an explicitly preserved transition', () => {
    expect(drawerMinHeightForTransition(true, 319.2)).toBe('320px')
    expect(drawerMinHeightForTransition(true, 319.2, 280)).toBe('280px')
    expect(drawerMinHeightForTransition(true, 319.2, 0)).toBe('')
    expect(drawerMinHeightForTransition(false, 319.2)).toBe('')
    expect(drawerMinHeightForTransition(undefined, 319.2)).toBe('')
    expect(drawerMinHeightForTransition(true, 0)).toBe('')
    expect(drawerMinHeightForTransition(true, Number.NaN)).toBe('')
  })

  it('preserves height only in the independently enabled responsive layout', () => {
    expect(shouldPreserveDrawerHeight(true, undefined, true, false)).toBe(true)
    expect(shouldPreserveDrawerHeight(true, undefined, false, true)).toBe(false)
    expect(shouldPreserveDrawerHeight(true, false, false, true)).toBe(false)
    expect(shouldPreserveDrawerHeight(false, true, false, true)).toBe(true)
    expect(shouldPreserveDrawerHeight(false, true, true, false)).toBe(false)
    expect(shouldPreserveDrawerHeight(true, true, false, true)).toBe(true)
    expect(shouldPreserveDrawerHeight(undefined, undefined, false, true)).toBe(false)
  })
})
