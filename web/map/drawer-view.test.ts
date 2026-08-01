import { describe, expect, it } from 'vitest'
import {
  createKeyboardActivationTracker,
  drawerScrollTopForTransition,
  drawerSizeForView,
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

  // 尺寸只看 size 與 mode。呼叫端想讓讀取狀態留在某個工作區就自己給 size,
  // renderer 不從 view key 的命名慣例反推。
  it('reads the size off the view, never off the view key', () => {
    expect(drawerSizeForView({
      key: 'catalogue:Tainan',
      mode: 'compact',
      size: 'standard',
      content: [],
    }, undefined)).toBe('standard')
    expect(drawerSizeForView({
      key: 'catalogue:Tainan',
      mode: 'compact',
      content: [],
    }, undefined)).toBe('content')
    expect(drawerSizeForView({
      key: 'region:south',
      mode: 'compact',
      content: [],
    }, undefined)).toBe('content')
  })

  // 點站牌是 nearby → place 的跨 workspace 導覽,骨架仍然不能改高度。
  it('holds the size on screen for a transient view, across workspaces and over its own size', () => {
    const skeleton = {
      key: 'place:Tainan:busy-stop',
      mode: 'map-list' as const,
      transient: true,
      header: [],
      content: [],
    }

    expect(drawerSizeForView(skeleton, 'nearby')).toBe('nearby')
    expect(drawerSizeForView(skeleton, 'tall')).toBe('tall')
    expect(drawerSizeForView({ ...skeleton, size: 'compact' }, 'nearby')).toBe('nearby')
  })

  // 第一次繪製時抽屜還沒有高度可以沿用,transient 也只能自己算。
  it('falls back to its own size when nothing is on screen yet', () => {
    expect(drawerSizeForView({
      key: 'nearby:Tainan:22.99700:120.21200',
      mode: 'map-list',
      size: 'nearby',
      transient: true,
      header: [],
      content: [],
    }, undefined)).toBe('nearby')
    expect(drawerSizeForView({
      key: 'place:Tainan:busy-stop',
      mode: 'map-list',
      transient: true,
      header: [],
      content: [],
    }, undefined)).toBe('standard')
  })

  // 帶著最終內容的畫面照樣決定尺寸,不受畫面上現有高度影響。
  it('lets a settled view set its own size regardless of what is on screen', () => {
    expect(drawerSizeForView({
      key: 'place:Tainan:busy-stop',
      mode: 'map-list',
      size: 'tall',
      header: [],
      content: [],
    }, 'nearby')).toBe('tall')
    expect(drawerSizeForView({
      key: 'trip-results:A:B',
      mode: 'compact',
      content: [],
    }, 'compact')).toBe('content')
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
