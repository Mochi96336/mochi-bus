import { describe, expect, it } from 'vitest'
import {
  createKeyboardActivationTracker,
  drawerMinHeightForTransition,
  drawerScrollTopForTransition,
  drawerSizeForView,
  drawerSizeWorkspaceKey,
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

  it('keeps another stop in the same timetable in one size workspace while resetting its scroll', () => {
    const sizeKey = 'timetable:ChiayiCounty:CHI-7211:0'
    const firstStop = {
      key: `${sizeKey}:C1`,
      sizeKey,
      mode: 'timetable' as const,
      header: [],
      content: [],
    }
    const secondStop = { ...firstStop, key: `${sizeKey}:C2` }

    expect(drawerSizeWorkspaceKey(firstStop)).toBe(sizeKey)
    expect(drawerSizeWorkspaceKey(secondStop)).toBe(sizeKey)
    expect(drawerScrollTopForTransition(firstStop.key, secondStop.key, 240)).toBe(0)
    expect(drawerSizeWorkspaceKey({ ...secondStop, sizeKey: undefined })).toBe(secondStop.key)
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

  it('keeps a size-less loading view at the size already on screen', () => {
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

  it('lets an explicit final size replace the size the skeleton inherited', () => {
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

describe('keyboard activation tracker', () => {
  type Listener = (event: { detail?: number }) => void

  function fakeTarget() {
    const listeners = new Map<string, Listener[]>()
    return {
      addEventListener(type: string, listener: Listener) {
        listeners.set(type, [...(listeners.get(type) ?? []), listener])
      },
      removeEventListener(type: string, listener: Listener) {
        listeners.set(type, (listeners.get(type) ?? []).filter((entry) => entry !== listener))
      },
      emit(type: string, event: { detail?: number } = {}) {
        for (const listener of [...(listeners.get(type) ?? [])]) listener(event)
      },
      count: () => [...listeners.values()].reduce((total, entries) => total + entries.length, 0),
    }
  }

  function mount() {
    const target = fakeTarget()
    return {
      target,
      tracker: createKeyboardActivationTracker(
        target as unknown as Pick<EventTarget, 'addEventListener' | 'removeEventListener'>,
      ),
    }
  }

  // Enter/Space 觸發的 click 在多數瀏覽器仍是 PointerEvent,只有 detail 分得出來。
  it('reads detail 0 as keyboard and a click count as pointer', () => {
    const { target, tracker } = mount()

    target.emit('click', { detail: 0 })
    expect(tracker.consume()).toBe(true)

    target.emit('click', { detail: 1 })
    expect(tracker.consume()).toBe(false)
  })

  it('only authorises one focus transfer per activation', () => {
    const { target, tracker } = mount()

    target.emit('click', { detail: 0 })
    expect(tracker.consume()).toBe(true)
    // 一次鍵盤操作之後的 popstate 或 URL hydration 不該再被當成鍵盤導覽。
    expect(tracker.consume()).toBe(false)
  })

  it('lets a pointer press clear a stale keyboard flag', () => {
    const { target, tracker } = mount()

    target.emit('click', { detail: 0 })
    target.emit('pointerdown')
    expect(tracker.consume()).toBe(false)
  })

  it('reports no activation before anything happens', () => {
    expect(mount().tracker.consume()).toBe(false)
  })

  it('removes both listeners on dispose', () => {
    const { target, tracker } = mount()

    expect(target.count()).toBe(2)
    tracker.dispose()
    expect(target.count()).toBe(0)
  })
})
