import { describe, expect, it, vi } from 'vitest'
import { TDXServiceError } from './error-classification'
import {
  createTDXCircuitBreaker,
  dataCircuitKey,
  dataRateLimitCircuitKey,
  tokenCircuitKey,
} from './circuit-breaker'

const transientError = (status?: number) => new TDXServiceError('transient', status)
const limitedError = (warning: 'tdx-rate-limit' | 'tdx-quota' = 'tdx-rate-limit') => {
  const error = new TDXServiceError('limited', 429)
  error.warning = warning
  return error
}

describe('TDX circuit breaker boundary', () => {
  it('keeps token, scoped data, and credential rate-limit circuits isolated by explicit keys', () => {
    expect(tokenCircuitKey('credential')).toBe('token/credential')
    expect(dataCircuitKey('credential', 'place_arrivals', 'City/Tainan'))
      .toBe('data/credential/place_arrivals/City/Tainan')
    expect(dataRateLimitCircuitKey('credential')).toBe('data-limit/credential')
    expect(tokenCircuitKey('credential')).not.toBe(dataCircuitKey('credential'))
  })

  it('opens after three transient failures inside the one-minute window', () => {
    let time = 0
    const opened = vi.fn()
    const circuit = createTDXCircuitBreaker({ now: () => time, onOpened: opened })

    circuit.recordFailure('data/a', transientError())
    expect(circuit.assertClosed('data/a')).toBe(false)
    time += 10_000
    circuit.recordFailure('data/a', transientError(503))
    expect(circuit.assertClosed('data/a')).toBe(false)
    time += 10_000
    circuit.recordFailure('data/a', transientError(408))

    expect(() => circuit.assertClosed('data/a')).toThrowError(expect.objectContaining({
      warning: 'tdx-unavailable',
      status: 503,
      failureKind: 'circuit_open',
    }))
    expect(opened).toHaveBeenCalledOnce()
    expect(opened).toHaveBeenCalledWith({ key: 'data/a', warning: 'tdx-unavailable', openMs: 30_000 })
  })

  it('does not count invalid schema failures as upstream unavailability', () => {
    const circuit = createTDXCircuitBreaker()
    const schemaError = new TDXServiceError('invalid schema', 502, { failureKind: 'invalid_schema' })

    for (let index = 0; index < 10; index += 1) circuit.recordFailure('data/a', schemaError)

    expect(circuit.assertClosed('data/a')).toBe(false)
  })

  it('forgets stale failure counts after the failure window', () => {
    let time = 0
    const circuit = createTDXCircuitBreaker({ now: () => time })

    circuit.recordFailure('data/a', transientError())
    time = 60_000
    expect(circuit.assertClosed('data/a')).toBe(false)

    circuit.recordFailure('data/a', transientError())
    circuit.recordFailure('data/a', transientError())
    expect(circuit.assertClosed('data/a')).toBe(false)
  })

  it('opens rate limits immediately and honors Retry-After seconds', () => {
    let time = Date.parse('2026-07-22T00:00:00Z')
    const circuit = createTDXCircuitBreaker({ now: () => time })

    circuit.recordFailure('token/a', limitedError(), '10')
    expect(() => circuit.assertClosed('token/a')).toThrowError(expect.objectContaining({
      warning: 'tdx-rate-limit',
      status: 429,
    }))

    time += 9_999
    expect(() => circuit.assertClosed('token/a')).toThrow()
    time += 1
    expect(circuit.assertClosed('token/a')).toBe(true)
    expect(() => circuit.assertClosed('token/a')).toThrowError(/probe is in progress/)
  })

  it('checks multiple circuits atomically before reserving half-open probes', () => {
    let time = 0
    const circuit = createTDXCircuitBreaker({ now: () => time })
    circuit.recordFailure('data-limit/a', limitedError(), '1')
    circuit.recordFailure('data/a', transientError())
    circuit.recordFailure('data/a', transientError())
    circuit.recordFailure('data/a', transientError())
    time = 1_000

    expect(() => circuit.assertAllClosed(['data-limit/a', 'data/a'])).toThrow()

    circuit.recordSuccess('data/a')
    expect(circuit.assertAllClosed(['data-limit/a', 'data/a'])).toBe(true)
  })

  it('accepts Retry-After HTTP dates and clamps them to five minutes', () => {
    let time = Date.parse('2026-07-22T00:00:00Z')
    const circuit = createTDXCircuitBreaker({ now: () => time })

    circuit.recordFailure('token/a', limitedError(), 'Wed, 22 Jul 2026 00:20:00 GMT')
    time += 5 * 60 * 1000 - 1
    expect(() => circuit.assertClosed('token/a')).toThrow()
    time += 1
    expect(circuit.assertClosed('token/a')).toBe(true)
  })

  it('reopens immediately when the half-open probe fails', () => {
    let time = 0
    const circuit = createTDXCircuitBreaker({ now: () => time })

    circuit.recordFailure('data/a', limitedError(), '1')
    time = 1_000
    expect(circuit.assertClosed('data/a')).toBe(true)
    circuit.recordFailure('data/a', transientError(503))

    expect(() => circuit.assertClosed('data/a')).toThrowError(expect.objectContaining({
      warning: 'tdx-unavailable',
      status: 503,
    }))
  })

  it('keeps quota circuits open for five minutes regardless of Retry-After', () => {
    let time = 0
    const circuit = createTDXCircuitBreaker({ now: () => time })

    circuit.recordFailure('token/a', limitedError('tdx-quota'), '1')
    time = 5 * 60 * 1000 - 1
    expect(() => circuit.assertClosed('token/a')).toThrowError(expect.objectContaining({ warning: 'tdx-quota' }))
    time += 1
    expect(circuit.assertClosed('token/a')).toBe(true)
  })

  it('clears state on success and on non-transient failures', () => {
    const circuit = createTDXCircuitBreaker()
    circuit.recordFailure('data/a', limitedError())
    circuit.recordSuccess('data/a')
    expect(circuit.assertClosed('data/a')).toBe(false)

    circuit.recordFailure('data/a', limitedError())
    circuit.recordFailure('data/a', new TDXServiceError('bad request', 400))
    expect(circuit.assertClosed('data/a')).toBe(false)
  })

  it('retains a hard LRU cap and refreshes recency on writes', () => {
    let time = 0
    const circuit = createTDXCircuitBreaker({ now: () => time, maxEntries: 2 })

    circuit.recordFailure('data/a', transientError())
    time += 1
    circuit.recordFailure('data/b', transientError())
    time += 1
    circuit.recordFailure('data/a', transientError())
    time += 1
    circuit.recordFailure('data/c', transientError())

    expect(circuit.assertClosed('data/b')).toBe(false)
    circuit.recordFailure('data/a', transientError())
    expect(() => circuit.assertClosed('data/a')).toThrow()
  })

  it('reset removes every token and data circuit', () => {
    const circuit = createTDXCircuitBreaker()
    circuit.recordFailure('token/a', limitedError())
    circuit.recordFailure('data/a', limitedError())
    circuit.reset()

    expect(circuit.assertClosed('token/a')).toBe(false)
    expect(circuit.assertClosed('data/a')).toBe(false)
  })
})
