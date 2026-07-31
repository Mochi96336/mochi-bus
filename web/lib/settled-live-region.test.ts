import { describe, expect, it, vi } from 'vitest'
import { createSettledLiveRegion, type SettledLiveRegion } from './settled-live-region'

type Clock = {
  schedule: (callback: () => void, delayMs: number) => number
  cancelSchedule: (timer: number) => void
  advanceTo: (time: number) => void
  pending: () => number
}

function fakeClock(): Clock {
  const timers = new Map<number, { dueAt: number; callback: () => void }>()
  let current = 0
  let nextId = 0
  return {
    schedule(callback, delayMs) {
      const id = nextId += 1
      timers.set(id, { dueAt: current + delayMs, callback })
      return id
    },
    cancelSchedule(timer) {
      timers.delete(timer)
    },
    advanceTo(time) {
      for (const [id, entry] of [...timers].sort((a, b) => a[1].dueAt - b[1].dueAt)) {
        if (entry.dueAt > time) continue
        timers.delete(id)
        current = Math.max(current, entry.dueAt)
        entry.callback()
      }
      current = Math.max(current, time)
    },
    pending: () => timers.size,
  }
}

type Harness = {
  node: { textContent: string }
  clock: Clock
  region: SettledLiveRegion
}

function mount(settleMs?: number): Harness {
  const node = { textContent: '' }
  const clock = fakeClock()
  const region = createSettledLiveRegion({
    node: node as unknown as HTMLElement,
    settleMs,
    schedule: clock.schedule as unknown as NonNullable<Parameters<typeof createSettledLiveRegion>[0]['schedule']>,
    cancelSchedule: clock.cancelSchedule as unknown as NonNullable<Parameters<typeof createSettledLiveRegion>[0]['cancelSchedule']>,
  })
  return { node, clock, region }
}

describe('settled live region', () => {
  it('waits for the state to settle before announcing', () => {
    const { node, clock, region } = mount()

    region.announce('正在讀取路線…')
    clock.advanceTo(599)
    expect(node.textContent).toBe('')
    clock.advanceTo(600)
    expect(node.textContent).toBe('正在讀取路線…')
  })

  // 連續導覽:選縣市、載目錄、點站牌、讀路線。逐句朗讀只會一直打斷使用者。
  it('announces only the last state of a rapid sequence', () => {
    const { node, clock, region } = mount()

    region.announce('臺南')
    clock.advanceTo(200)
    region.announce('正在找這附近的站牌…')
    clock.advanceTo(400)
    region.announce('12 個附近站牌')
    // 中間那兩句都沒有撐過 600ms 的穩定窗,只有最後一句被唸出來。
    clock.advanceTo(999)
    expect(node.textContent).toBe('')
    clock.advanceTo(1_000)

    expect(node.textContent).toBe('12 個附近站牌')
    expect(clock.pending()).toBe(0)
  })

  it('announces an error immediately instead of waiting out the settle window', () => {
    const { node, clock, region } = mount()

    region.announce('正在讀取路線…')
    region.announceNow('目前無法載入這個縣市的路線。')
    expect(node.textContent).toBe('目前無法載入這個縣市的路線。')

    // 被取代的那句不能在稍後補唸。
    clock.advanceTo(1_000)
    expect(node.textContent).toBe('目前無法載入這個縣市的路線。')
  })

  it('does not rewrite an unchanged message', () => {
    const { node, clock, region } = mount()

    region.announceNow('臺南')
    let writes = 0
    Object.defineProperty(node, 'textContent', {
      configurable: true,
      get: () => '臺南',
      set: () => { writes += 1 },
    })

    region.announceNow('臺南')
    region.announce('臺南')
    clock.advanceTo(1_000)
    expect(writes).toBe(0)
  })

  it('drops a pending announcement when cleared', () => {
    const { node, clock, region } = mount()

    region.announce('正在讀取路線…')
    region.clear()
    clock.advanceTo(1_000)

    expect(node.textContent).toBe('')
    expect(clock.pending()).toBe(0)
  })

  it('drops a pending announcement on dispose', () => {
    const { node, clock, region } = mount()

    region.announce('正在讀取路線…')
    region.dispose()
    clock.advanceTo(1_000)

    expect(node.textContent).toBe('')
  })

  it('honours a custom settle window', () => {
    const { node, clock, region } = mount(250)

    region.announce('臺南')
    clock.advanceTo(249)
    expect(node.textContent).toBe('')
    clock.advanceTo(250)
    expect(node.textContent).toBe('臺南')
  })
})
