import { describe, expect, it, vi } from 'vitest'
import { createLoadingGate, type LoadingGate } from './loading-gate'

type Clock = {
  schedule: (callback: () => void, delayMs: number) => number
  cancelSchedule: (timer: number) => void
  now: () => number
  /** 推進到指定時刻,沿路觸發所有到期的計時器。 */
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
    now: () => current,
    advanceTo(time) {
      // 逐一到期觸發,讓回呼內新排的計時器也能在同一次推進中被看見。
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, entry]) => entry.dueAt <= time)
          .sort((a, b) => a[1].dueAt - b[1].dueAt)[0]
        if (!due) break
        const [id, entry] = due
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
  gate: LoadingGate
  clock: Clock
  showLoading: ReturnType<typeof vi.fn<() => void>>
  render: ReturnType<typeof vi.fn<() => void>>
}

function mount(overrides: { delayMs?: number; minVisibleMs?: number } = {}): Harness {
  const clock = fakeClock()
  const showLoading = vi.fn<() => void>()
  const gate = createLoadingGate({
    showLoading,
    now: clock.now,
    schedule: clock.schedule as unknown as NonNullable<Parameters<typeof createLoadingGate>[0]['schedule']>,
    cancelSchedule: clock.cancelSchedule as unknown as NonNullable<Parameters<typeof createLoadingGate>[0]['cancelSchedule']>,
    ...overrides,
  })
  return { gate, clock, showLoading, render: vi.fn<() => void>() }
}

describe('loading gate timing', () => {
  it('never shows a skeleton for a request that finishes inside the delay window', () => {
    const { gate, clock, showLoading, render } = mount()

    gate.start()
    clock.advanceTo(100)
    gate.settle(render)

    expect(showLoading).not.toHaveBeenCalled()
    expect(render).toHaveBeenCalledOnce()
    expect(clock.pending()).toBe(0)
  })

  it('shows the skeleton once the delay elapses and holds it for the minimum', () => {
    const { gate, clock, showLoading, render } = mount()

    gate.start()
    clock.advanceTo(120)
    expect(showLoading).toHaveBeenCalledOnce()

    clock.advanceTo(200)
    gate.settle(render)
    // 只顯示了 80ms,還欠 220ms 才滿足最短顯示時間。
    expect(render).not.toHaveBeenCalled()

    clock.advanceTo(419)
    expect(render).not.toHaveBeenCalled()
    clock.advanceTo(420)
    expect(render).toHaveBeenCalledOnce()
  })

  it('renders immediately once the skeleton has already met the minimum', () => {
    const { gate, clock, showLoading, render } = mount()

    gate.start()
    clock.advanceTo(500)
    expect(showLoading).toHaveBeenCalledOnce()

    gate.settle(render)
    expect(render).toHaveBeenCalledOnce()
    expect(clock.pending()).toBe(0)
  })

  it('honours custom thresholds', () => {
    const { gate, clock, showLoading, render } = mount({ delayMs: 50, minVisibleMs: 100 })

    gate.start()
    clock.advanceTo(49)
    expect(showLoading).not.toHaveBeenCalled()
    clock.advanceTo(50)
    expect(showLoading).toHaveBeenCalledOnce()

    gate.settle(render)
    clock.advanceTo(149)
    expect(render).not.toHaveBeenCalled()
    clock.advanceTo(150)
    expect(render).toHaveBeenCalledOnce()
  })
})

describe('loading gate cancellation', () => {
  it('drops the pending skeleton when aborted inside the delay window', () => {
    const { gate, clock, showLoading } = mount()

    gate.start()
    gate.abort()
    clock.advanceTo(1_000)

    expect(showLoading).not.toHaveBeenCalled()
    expect(clock.pending()).toBe(0)
  })

  // 這是 §5.3「舊計時器不得在新畫面觸發」的具體落點:min-visible 的尾端 render
  // 已經排進計時器,view 卻已經換掉了。
  it('drops an already scheduled tail render when aborted', () => {
    const { gate, clock, render } = mount()

    gate.start()
    clock.advanceTo(120)
    clock.advanceTo(200)
    gate.settle(render)
    gate.abort()
    clock.advanceTo(1_000)

    expect(render).not.toHaveBeenCalled()
  })

  it('clears every timer from the previous round when restarted', () => {
    const { gate, clock, showLoading, render } = mount()

    gate.start()
    clock.advanceTo(120)
    clock.advanceTo(200)
    gate.settle(render)
    expect(clock.pending()).toBe(1)

    gate.start()
    expect(clock.pending()).toBe(1)
    clock.advanceTo(1_000)

    // 舊的尾端 render 不能落在新一輪的畫面上,而新一輪自己的 skeleton 照常出現。
    expect(render).not.toHaveBeenCalled()
    expect(showLoading).toHaveBeenCalledTimes(2)
  })

  it('treats a restart during the delay window as a fresh delay', () => {
    const { gate, clock, showLoading } = mount()

    gate.start()
    clock.advanceTo(100)
    gate.start()
    clock.advanceTo(200)
    expect(showLoading).not.toHaveBeenCalled()
    clock.advanceTo(220)
    expect(showLoading).toHaveBeenCalledOnce()
  })

  it('renders straight away when settling without an open gate', () => {
    const { gate, showLoading, render } = mount()

    gate.settle(render)

    expect(render).toHaveBeenCalledOnce()
    expect(showLoading).not.toHaveBeenCalled()
  })

  it('renders straight away when settling after an abort', () => {
    const { gate, clock, render } = mount()

    gate.start()
    clock.advanceTo(120)
    gate.abort()
    gate.settle(render)

    expect(render).toHaveBeenCalledOnce()
  })
})
