import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseJsonWithDeadline, requestJsonWithRetry } from './tdx-source.mjs'

class FakeWorker extends EventEmitter {
  constructor(schedule, terminate = () => Promise.resolve(0)) {
    super()
    this.terminated = false
    this.cancel = null
    this.terminateImplementation = terminate
    schedule(this)
  }

  terminate() {
    this.terminated = true
    this.cancel?.()
    return this.terminateImplementation()
  }
}

function fakeClock(start = 0) {
  let current = start
  return {
    now: () => current,
    advance: (milliseconds) => { current += milliseconds },
  }
}

async function flushMicrotasks() {
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => vi.useRealTimers())

describe('bounded worker JSON parse', () => {
  it('times out when Worker construction consumes the absolute deadline', async () => {
    const clock = fakeClock()
    let worker
    const error = await parseJsonWithDeadline('[1]', {
      timeoutMs: 10,
      deadlineAt: 10,
      monotonicNow: clock.now,
      workerFactory: () => {
        clock.advance(30)
        worker = new FakeWorker(() => undefined)
        return worker
      },
    }).catch((caught) => caught)

    expect(error).toMatchObject({ details: { failureClass: 'timeout' } })
    expect(worker.terminated).toBe(true)
  })

  it('does not install a normal parse timer when construction ends exactly at the deadline', async () => {
    const clock = fakeClock()
    const setTimer = vi.fn(setTimeout)
    const error = await parseJsonWithDeadline('[1]', {
      timeoutMs: 10,
      deadlineAt: 10,
      monotonicNow: clock.now,
      setTimer,
      workerFactory: () => {
        clock.advance(10)
        return new FakeWorker(() => undefined)
      },
    }).catch((caught) => caught)

    expect(error).toMatchObject({ details: { failureClass: 'timeout' } })
    expect(setTimer).toHaveBeenCalledTimes(1)
    expect(setTimer.mock.calls[0][1]).toBe(1_000)
  })

  it('lets timeout win over an immediate success queued after an overlong constructor', async () => {
    const clock = fakeClock()
    let worker
    const result = parseJsonWithDeadline('[1]', {
      timeoutMs: 10,
      deadlineAt: 10,
      monotonicNow: clock.now,
      workerFactory: () => {
        clock.advance(30)
        worker = new FakeWorker((instance) => {
          queueMicrotask(() => instance.emit('message', { ok: true, value: [1] }))
        })
        return worker
      },
    }).catch((caught) => caught)

    await flushMicrotasks()
    await expect(result).resolves.toMatchObject({ details: { failureClass: 'timeout' } })
    expect(worker.terminated).toBe(true)
  })

  it('rejects at the operation deadline without waiting for never-resolving termination', async () => {
    vi.useFakeTimers()
    const cleanupFailures = []
    let publiclySettled = false
    const promise = parseJsonWithDeadline('[1]', {
      timeoutMs: 10,
      terminationTimeoutMs: 50,
      operationId: 'parse-never-terminates',
      onCleanupFailure: (failure) => cleanupFailures.push(failure),
      workerFactory: () => new FakeWorker(
        () => undefined,
        () => new Promise(() => undefined),
      ),
    }).catch((caught) => {
      publiclySettled = true
      return caught
    })

    await vi.advanceTimersByTimeAsync(11)
    expect(publiclySettled).toBe(true)
    await expect(promise).resolves.toMatchObject({ details: { failureClass: 'timeout' } })
    expect(cleanupFailures).toEqual([])

    await vi.advanceTimersByTimeAsync(50)
    expect(cleanupFailures).toEqual([{
      stage: 'parse-worker-termination',
      failureClass: 'termination-timeout',
      operationId: 'parse-never-terminates',
    }])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves timeout while reporting rejected termination through the bounded observer', async () => {
    vi.useFakeTimers()
    const cleanupFailures = []
    const promise = parseJsonWithDeadline('[1]', {
      timeoutMs: 10,
      operationId: 'parse-termination-rejects',
      onCleanupFailure: (failure) => cleanupFailures.push(failure),
      workerFactory: () => new FakeWorker(
        () => undefined,
        () => Promise.reject(new Error('fake secret termination error')),
      ),
    }).catch((caught) => caught)

    await vi.advanceTimersByTimeAsync(11)
    await expect(promise).resolves.toMatchObject({ details: { failureClass: 'timeout' } })
    await flushMicrotasks()
    expect(cleanupFailures).toEqual([{
      stage: 'parse-worker-termination',
      failureClass: 'termination-error',
      operationId: 'parse-termination-rejects',
    }])
    expect(JSON.stringify(cleanupFailures)).not.toContain('fake secret')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores a late success message after timeout settlement', async () => {
    vi.useFakeTimers()
    let worker
    const promise = parseJsonWithDeadline('[1]', {
      timeoutMs: 10,
      workerFactory: () => (worker = new FakeWorker(() => undefined)),
    }).catch((caught) => caught)

    await vi.advanceTimersByTimeAsync(11)
    const timeout = await promise
    worker.emit('message', { ok: true, value: [1] })
    await flushMicrotasks()
    expect(timeout).toMatchObject({ details: { failureClass: 'timeout' } })
    for (const event of ['message', 'error', 'messageerror', 'exit']) {
      expect(worker.listenerCount(event)).toBe(0)
    }
  })

  it('terminates a parse that exceeds the remaining monotonic deadline', async () => {
    vi.useFakeTimers()
    let worker
    const promise = parseJsonWithDeadline('[1]', {
      timeoutMs: 10,
      workerFactory: () => (worker = new FakeWorker((instance) => {
        const timer = setTimeout(() => instance.emit('message', { ok: true, value: [1] }), 100)
        instance.cancel = () => clearTimeout(timer)
      })),
    })
    const rejection = expect(promise).rejects.toMatchObject({ details: { failureClass: 'timeout' } })
    await vi.advanceTimersByTimeAsync(11)
    await rejection
    expect(worker.terminated).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('returns parsed JSON and removes every worker listener on success', async () => {
    let worker
    await expect(parseJsonWithDeadline('{"ok":true}', {
      timeoutMs: 100,
      workerFactory: () => (worker = new FakeWorker((instance) => {
        queueMicrotask(() => instance.emit('message', { ok: true, value: { ok: true } }))
      })),
    })).resolves.toEqual({ ok: true })
    expect(worker.terminated).toBe(true)
    for (const event of ['message', 'error', 'messageerror', 'exit']) {
      expect(worker.listenerCount(event)).toBe(0)
    }
  })

  it.each([
    ['malformed JSON', (instance) => instance.emit('message', { ok: false, failureClass: 'invalid_json' }), 'invalid_json'],
    ['worker throw', (instance) => instance.emit('error', new Error('fake secret token')), 'parse_worker_error'],
    ['worker message failure', (instance) => instance.emit('messageerror', new Error('fake body')), 'parse_worker_message_error'],
    ['worker exit without result', (instance) => instance.emit('exit', 0), 'parse_worker_error'],
  ])('returns a bounded error for %s', async (_name, emit, failureClass) => {
    const error = await parseJsonWithDeadline('secret body', {
      timeoutMs: 100,
      workerFactory: () => new FakeWorker((instance) => queueMicrotask(() => emit(instance))),
    }).catch((caught) => caught)
    expect(error.details.failureClass).toBe(failureClass)
    expect(JSON.stringify(error)).not.toContain('secret body')
    expect(String(error.stack)).not.toContain('fake secret token')
  })

  it('does not create a worker when the deadline is already exhausted', async () => {
    const workerFactory = vi.fn()
    await expect(parseJsonWithDeadline('[]', { timeoutMs: 0, workerFactory })).rejects.toMatchObject({ details: { failureClass: 'timeout' } })
    expect(workerFactory).not.toHaveBeenCalled()
  })

  it('passes the request-level absolute deadline into parsing rather than granting a fresh timeout', async () => {
    const clock = fakeClock(100)
    const parseJson = vi.fn(async () => [])
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => {
        clock.advance(7)
        return '[]'
      },
    }))

    await requestJsonWithRetry({
      endpointCategory: 'shape',
      city: 'Taipei',
      url: 'https://example.invalid',
      init: {},
      fetcher,
      random: () => 0,
      now: () => new Date('2026-07-24T00:00:00.000Z'),
      monotonicNow: clock.now,
      parseJson,
      expectArray: true,
      maxAttempts: 1,
      timeoutMs: 10,
    })

    expect(parseJson).toHaveBeenCalledTimes(1)
    expect(parseJson.mock.calls[0][1]).toMatchObject({ deadlineAt: 110 })
  })
})
