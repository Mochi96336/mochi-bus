import { describe, expect, it, vi } from 'vitest'
import { createVehicleRefreshController } from './vehicle-refresh-controller'

function createIntervalClock() {
  let nextId = 1
  const callbacks = new Map<number, () => void>()

  return {
    setInterval(callback: () => void) {
      const id = nextId++
      callbacks.set(id, callback)
      return id
    },
    clearInterval(handle: unknown) {
      callbacks.delete(handle as number)
    },
    async tick() {
      for (const callback of [...callbacks.values()]) callback()
      await flush()
    },
    size: () => callbacks.size,
  }
}

function createVisibility(initial = true) {
  let visible = initial
  const callbacks = new Set<() => void>()

  return {
    isVisible: () => visible,
    subscribe(callback: () => void) {
      callbacks.add(callback)
      return () => callbacks.delete(callback)
    },
    change(nextVisible: boolean) {
      visible = nextVisible
      for (const callback of [...callbacks]) callback()
    },
    size: () => callbacks.size,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
}

describe('createVehicleRefreshController', () => {
  it('refreshes immediately and on the configured interval', async () => {
    const clock = createIntervalClock()
    const load = vi.fn(async () => 'positions')
    const onResponse = vi.fn()
    const onStop = vi.fn()
    const controller = createVehicleRefreshController({
      load,
      isActive: () => true,
      onResponse,
      onError: vi.fn(),
      onStop,
      intervalMs: 20_000,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
    })

    controller.start({ cityCode: 'Taipei', route: '307' })
    await flush()
    expect(load).toHaveBeenCalledTimes(1)
    expect(load).toHaveBeenLastCalledWith('Taipei', '307', expect.any(AbortSignal))
    expect(onResponse).toHaveBeenCalledWith('positions')
    expect(onStop).toHaveBeenCalledTimes(1)

    await clock.tick()
    expect(load).toHaveBeenCalledTimes(2)
    expect(clock.size()).toBe(1)
  })

  it('stops polling while hidden, aborts in-flight work and refreshes on foreground return', async () => {
    const clock = createIntervalClock()
    const visibility = createVisibility()
    const first = deferred<string>()
    const signals: AbortSignal[] = []
    const load = vi.fn((_city: string, _route: string, signal: AbortSignal) => {
      signals.push(signal)
      return signals.length === 1 ? first.promise : Promise.resolve('foreground')
    })
    const onResponse = vi.fn()
    const controller = createVehicleRefreshController({
      load,
      isActive: () => true,
      onResponse,
      onError: vi.fn(),
      onStop: vi.fn(),
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
      isVisible: visibility.isVisible,
      subscribeVisibility: visibility.subscribe,
    })

    controller.start({ cityCode: 'Taipei', route: '307' })
    expect(load).toHaveBeenCalledTimes(1)
    expect(clock.size()).toBe(1)
    expect(visibility.size()).toBe(1)

    visibility.change(false)
    expect(signals[0]?.aborted).toBe(true)
    expect(clock.size()).toBe(0)
    await clock.tick()
    expect(load).toHaveBeenCalledTimes(1)

    first.resolve('hidden late response')
    await flush()
    expect(onResponse).not.toHaveBeenCalled()

    visibility.change(true)
    await flush()
    expect(load).toHaveBeenCalledTimes(2)
    expect(onResponse).toHaveBeenCalledWith('foreground')
    expect(clock.size()).toBe(1)

    controller.stop()
    expect(clock.size()).toBe(0)
    expect(visibility.size()).toBe(0)
  })

  it('does not start polling until an initially hidden page becomes visible', async () => {
    const clock = createIntervalClock()
    const visibility = createVisibility(false)
    const load = vi.fn(async () => 'positions')
    const controller = createVehicleRefreshController({
      load,
      isActive: () => true,
      onResponse: vi.fn(),
      onError: vi.fn(),
      onStop: vi.fn(),
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
      isVisible: visibility.isVisible,
      subscribeVisibility: visibility.subscribe,
    })

    controller.start({ cityCode: 'Taipei', route: '307' })
    await flush()
    expect(load).not.toHaveBeenCalled()
    expect(clock.size()).toBe(0)

    visibility.change(true)
    await flush()
    expect(load).toHaveBeenCalledTimes(1)
    expect(clock.size()).toBe(1)
  })

  it('aborts an in-flight request when the next interval starts and ignores its stale response', async () => {
    const clock = createIntervalClock()
    const first = deferred<string>()
    const second = deferred<string>()
    const signals: AbortSignal[] = []
    const load = vi.fn((_city: string, _route: string, signal: AbortSignal) => {
      signals.push(signal)
      return signals.length === 1 ? first.promise : second.promise
    })
    const onResponse = vi.fn()
    const controller = createVehicleRefreshController({
      load,
      isActive: () => true,
      onResponse,
      onError: vi.fn(),
      onStop: vi.fn(),
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
    })

    controller.start({ cityCode: 'Taipei', route: '307' })
    await clock.tick()
    expect(signals[0]?.aborted).toBe(true)

    second.resolve('new')
    await flush()
    expect(onResponse).toHaveBeenCalledTimes(1)
    expect(onResponse).toHaveBeenCalledWith('new')

    first.resolve('old')
    await flush()
    expect(onResponse).toHaveBeenCalledTimes(1)
  })

  it('replaces the active route session, timer and request as one operation', async () => {
    const clock = createIntervalClock()
    const first = deferred<string>()
    const second = deferred<string>()
    const signals: AbortSignal[] = []
    const onResponse = vi.fn()
    const onStop = vi.fn()
    const controller = createVehicleRefreshController({
      load: vi.fn((_city: string, route: string, signal: AbortSignal) => {
        signals.push(signal)
        return route === '307' ? first.promise : second.promise
      }),
      isActive: () => true,
      onResponse,
      onError: vi.fn(),
      onStop,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
    })

    controller.start({ cityCode: 'Taipei', route: '307' })
    controller.start({ cityCode: 'NewTaipei', route: '299' })
    expect(signals[0]?.aborted).toBe(true)
    expect(clock.size()).toBe(1)
    expect(onStop).toHaveBeenCalledTimes(2)

    second.resolve('new route')
    await flush()
    expect(onResponse).toHaveBeenCalledWith('new route')

    first.resolve('old route')
    await flush()
    expect(onResponse).toHaveBeenCalledTimes(1)
  })

  it('stops the timer, aborts the request and discards late settlement', async () => {
    const clock = createIntervalClock()
    const request = deferred<string>()
    let signal: AbortSignal | undefined
    const onResponse = vi.fn()
    const onError = vi.fn()
    const onStop = vi.fn()
    const controller = createVehicleRefreshController({
      load: (_city, _route, requestSignal) => {
        signal = requestSignal
        return request.promise
      },
      isActive: () => true,
      onResponse,
      onError,
      onStop,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
    })

    controller.start({ cityCode: 'Taipei', route: '307' })
    controller.stop()
    expect(signal?.aborted).toBe(true)
    expect(clock.size()).toBe(0)
    expect(onStop).toHaveBeenCalledTimes(2)

    request.resolve('late')
    await flush()
    expect(onResponse).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })

  it('does not load or publish while the session is inactive', async () => {
    const clock = createIntervalClock()
    let active = false
    const load = vi.fn(async () => 'positions')
    const onResponse = vi.fn()
    const controller = createVehicleRefreshController({
      load,
      isActive: () => active,
      onResponse,
      onError: vi.fn(),
      onStop: vi.fn(),
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
    })

    controller.start({ cityCode: 'Taipei', route: '307' })
    await clock.tick()
    expect(load).not.toHaveBeenCalled()

    active = true
    await controller.refresh()
    expect(load).toHaveBeenCalledTimes(1)
    expect(onResponse).toHaveBeenCalledWith('positions')
  })

  it('reports only active, non-aborted request failures', async () => {
    const clock = createIntervalClock()
    const onError = vi.fn()
    let active = true
    const controller = createVehicleRefreshController({
      load: vi.fn(async () => { throw new Error('offline') }),
      isActive: () => active,
      onResponse: vi.fn(),
      onError,
      onStop: vi.fn(),
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
    })

    controller.start({ cityCode: 'Taipei', route: '307' })
    await flush()
    expect(onError).toHaveBeenCalledTimes(1)

    active = false
    await clock.tick()
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('rejects invalid refresh intervals', () => {
    expect(() => createVehicleRefreshController({
      load: async () => undefined,
      isActive: () => true,
      onResponse: vi.fn(),
      onError: vi.fn(),
      onStop: vi.fn(),
      intervalMs: 0,
    })).toThrow('Vehicle refresh interval must be a positive finite number')
  })
})
