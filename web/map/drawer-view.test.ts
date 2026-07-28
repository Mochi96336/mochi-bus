import { describe, expect, it } from 'vitest'
import {
  drawerMinHeightForTransition,
  drawerScrollTopForTransition,
  shouldAnimateDrawerTransition,
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

  it('uses the previous measured height only for an explicitly preserved transition', () => {
    expect(drawerMinHeightForTransition(true, 319.2)).toBe('320px')
    expect(drawerMinHeightForTransition(false, 319.2)).toBe('')
    expect(drawerMinHeightForTransition(undefined, 319.2)).toBe('')
    expect(drawerMinHeightForTransition(true, 0)).toBe('')
    expect(drawerMinHeightForTransition(true, Number.NaN)).toBe('')
  })
})
