import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createAsyncAction, type AsyncAction } from './async-action-state'

// 專案沒有 jsdom(見 vitest.config.ts):web 層測試一律手刻最小 DOM 替身。
class FakeElement {
  disabled = false
  textContent = ''
  isConnected = true
  private readonly attributes = new Map<string, string>()

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name)
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }
}

type Clock = {
  schedule: (callback: () => void, delayMs: number) => number
  cancelSchedule: (timer: number) => void
  advance: () => void
  pending: () => number
}

function fakeClock(): Clock {
  const timers = new Map<number, () => void>()
  let nextId = 0
  return {
    schedule(callback) {
      const id = nextId += 1
      timers.set(id, callback)
      return id
    },
    cancelSchedule(timer) {
      timers.delete(timer)
    },
    advance() {
      for (const [id, callback] of [...timers]) {
        timers.delete(id)
        callback()
      }
    },
    pending: () => timers.size,
  }
}

const fullLabels = { idle: '重新整理', pending: '更新中', success: '已更新', error: '更新失敗' }

type Harness = {
  button: FakeElement
  busyTarget: FakeElement
  announce: ReturnType<typeof vi.fn>
  clock: Clock
  action: AsyncAction
}

function mount(overrides: Partial<Parameters<typeof createAsyncAction>[0]> = {}): Harness {
  const button = new FakeElement()
  const busyTarget = new FakeElement()
  const announce = vi.fn()
  const clock = fakeClock()
  const action = createAsyncAction({
    button: button as unknown as HTMLButtonElement,
    labels: fullLabels,
    announce,
    schedule: clock.schedule as unknown as AsyncActionSchedule,
    cancelSchedule: clock.cancelSchedule as unknown as AsyncActionCancel,
    ...overrides,
  })
  return { button, busyTarget, announce, clock, action }
}

type AsyncActionSchedule = NonNullable<Parameters<typeof createAsyncAction>[0]['schedule']>
type AsyncActionCancel = NonNullable<Parameters<typeof createAsyncAction>[0]['cancelSchedule']>

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('async action lifecycle', () => {
  it('walks idle to pending to success and back', async () => {
    const { action, button, clock, announce } = mount()

    const run = action.run(async () => 'ok')
    expect(action.phase()).toBe('pending')
    expect(button.disabled).toBe(true)
    expect(button.textContent).toBe('更新中')

    await expect(run).resolves.toEqual({ status: 'fulfilled', value: 'ok' })
    expect(action.phase()).toBe('success')
    expect(button.disabled).toBe(false)
    expect(button.textContent).toBe('已更新')
    expect(announce).toHaveBeenCalledWith('已更新')

    clock.advance()
    expect(action.phase()).toBe('idle')
    expect(button.textContent).toBe('重新整理')
    expect(announce).toHaveBeenLastCalledWith('')
  })

  it('reports a skipped run instead of stacking a second task while pending', async () => {
    const { action } = mount()
    const gate = deferred<string>()
    const second = vi.fn(async () => 'second')

    const first = action.run(() => gate.promise)
    await expect(action.run(second)).resolves.toEqual({ status: 'skipped' })
    expect(second).not.toHaveBeenCalled()

    gate.resolve('first')
    await first
  })

  it('cancels the settle countdown when a new run starts during it', async () => {
    const { action, clock, button } = mount()

    await action.run(async () => 'ok')
    expect(clock.pending()).toBe(1)

    const gate = deferred<string>()
    const next = action.run(() => gate.promise)
    expect(clock.pending()).toBe(0)
    expect(action.phase()).toBe('pending')
    expect(button.textContent).toBe('更新中')

    gate.resolve('ok')
    await next
  })
})

describe('async action error handling', () => {
  it('hands the rejection reason back untouched instead of swallowing it', async () => {
    const { action, button, announce } = mount()
    const failure = new Error('TDX 拒絕了這組憑證')

    const result = await action.run(async () => { throw failure })

    expect(result).toEqual({ status: 'rejected', reason: failure })
    expect(result.status === 'rejected' && result.reason).toBe(failure)
    expect(action.phase()).toBe('error')
    expect(button.textContent).toBe('更新失敗')
    expect(announce).toHaveBeenCalledWith('更新失敗')
  })

  it('recovers from a synchronous throw so the button cannot stay stuck', async () => {
    const { action, button, clock } = mount()

    const result = await action.run(() => { throw new Error('reconcile bug') })

    expect(result.status).toBe('rejected')
    expect(button.disabled).toBe(false)
    clock.advance()
    expect(action.phase()).toBe('idle')
    // 卡死迴歸:上一輪炸掉之後,下一輪仍然必須跑得起來。
    await expect(action.run(async () => 'ok')).resolves.toEqual({ status: 'fulfilled', value: 'ok' })
  })

  it('keeps a non-Error rejection reason intact', async () => {
    const { action } = mount()

    await expect(action.run(async () => { throw 'plain string' })).resolves
      .toEqual({ status: 'rejected', reason: 'plain string' })
  })
})

describe('async action quiet runs', () => {
  it('suppresses success feedback and settles straight back to idle', async () => {
    const { action, button, announce, clock } = mount()

    await action.run(async () => 'ok', { quiet: true })

    expect(action.phase()).toBe('idle')
    expect(button.textContent).toBe('重新整理')
    expect(announce).not.toHaveBeenCalledWith('已更新')
    expect(clock.pending()).toBe(0)
  })

  it('still shows the pending label, because the button really is disabled', async () => {
    const { action, button } = mount()

    const gate = deferred<string>()
    const run = action.run(() => gate.promise, { quiet: true })
    expect(button.textContent).toBe('更新中')
    expect(button.disabled).toBe(true)

    gate.resolve('ok')
    await run
  })

  it('still surfaces failures so an automatic refresh cannot fail silently', async () => {
    const { action, button, announce } = mount()

    await action.run(async () => { throw new Error('boom') }, { quiet: true })

    expect(action.phase()).toBe('error')
    expect(button.textContent).toBe('更新失敗')
    expect(announce).toHaveBeenCalledWith('更新失敗')
  })
})

describe('async action aria-busy', () => {
  it('adds no aria-busy anywhere when no busy target is given', async () => {
    const { action, button } = mount()

    const gate = deferred<string>()
    const run = action.run(() => gate.promise)
    expect(button.getAttribute('aria-busy')).toBeNull()

    gate.resolve('ok')
    await run
  })

  it('marks the content region busy for the length of the run', async () => {
    const busyTarget = new FakeElement()
    const { action } = mount({ busyTarget: busyTarget as unknown as HTMLElement })

    const gate = deferred<string>()
    const run = action.run(() => gate.promise)
    expect(busyTarget.getAttribute('aria-busy')).toBe('true')

    gate.resolve('ok')
    await run
    expect(busyTarget.getAttribute('aria-busy')).toBeNull()
  })
})

describe('async action pending-only mode', () => {
  const retryLabels = { idle: '再試一次', pending: '重試中…' }

  it('returns to idle without scheduling a settle countdown', async () => {
    const { action, button, clock } = mount({ labels: retryLabels })

    await action.run(async () => 'ok')

    expect(action.phase()).toBe('idle')
    expect(button.textContent).toBe('再試一次')
    expect(clock.pending()).toBe(0)
  })

  it('also skips the countdown on failure', async () => {
    const { action, clock } = mount({ labels: retryLabels })

    await action.run(async () => { throw new Error('boom') })

    expect(action.phase()).toBe('idle')
    expect(clock.pending()).toBe(0)
  })
})

describe('async action teardown', () => {
  let harness: Harness

  beforeEach(() => {
    harness = mount()
  })

  it('skips DOM writes once the button leaves the document', async () => {
    const { action, button } = harness

    const gate = deferred<string>()
    const run = action.run(() => gate.promise)
    button.isConnected = false
    button.textContent = 'detached'

    gate.resolve('ok')
    await run
    expect(button.textContent).toBe('detached')
  })

  it('refuses new runs and cancels the countdown after dispose', async () => {
    const { action, clock } = harness
    const task = vi.fn(async () => 'ok')

    await action.run(async () => 'ok')
    expect(clock.pending()).toBe(1)

    action.dispose()
    expect(clock.pending()).toBe(0)
    await expect(action.run(task)).resolves.toEqual({ status: 'skipped' })
    expect(task).not.toHaveBeenCalled()
  })

  it('does not touch the button when an in-flight task settles after dispose', async () => {
    const { action, button } = harness

    const gate = deferred<string>()
    const run = action.run(() => gate.promise)
    action.dispose()
    button.textContent = 'disposed'

    gate.resolve('ok')
    await run
    expect(button.textContent).toBe('disposed')
  })
})
