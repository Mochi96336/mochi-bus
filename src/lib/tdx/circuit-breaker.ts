import type { TDXWarning } from '../../domain/tdx-warning'
import { TDXServiceError } from './error-classification'

const DEFAULT_MAX_ENTRIES = 128
const DEFAULT_FAILURE_THRESHOLD = 3
const DEFAULT_FAILURE_WINDOW_MS = 60 * 1000
const DEFAULT_TRANSIENT_OPEN_MS = 30 * 1000
const DEFAULT_QUOTA_OPEN_MS = 5 * 60 * 1000
const DEFAULT_MAX_RETRY_AFTER_MS = 5 * 60 * 1000

type CircuitState = {
  failures: number
  lastFailureAt: number
  openedUntil: number
  halfOpen: boolean
  warning: TDXWarning
}

export type TDXCircuitBreakerOptions = {
  now?: () => number
  maxEntries?: number
  failureThreshold?: number
  failureWindowMs?: number
  transientOpenMs?: number
  quotaOpenMs?: number
  maxRetryAfterMs?: number
  onOpened?: (event: { key: string; warning: TDXWarning; openMs: number }) => void
}

export type TDXCircuitBreaker = {
  assertClosed: (key: string) => boolean
  assertAllClosed: (keys: readonly string[]) => boolean
  recordFailure: (key: string, error: TDXServiceError, retryAfter?: string | null) => void
  recordSuccess: (key: string) => void
  reset: () => void
}

// Circuit ownership lives here. Token/data request loops still decide when failures and successes
// should be recorded, while this boundary owns LRU state and every closed/open/half-open transition.
// Resolve the clock for each transition so Worker stubs and fake timers remain observable after initialization.
export function createTDXCircuitBreaker(options: TDXCircuitBreakerOptions = {}): TDXCircuitBreaker {
  const circuits = new Map<string, CircuitState>()
  const now = () => options.now ? options.now() : Date.now()
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
  const failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD
  const failureWindowMs = options.failureWindowMs ?? DEFAULT_FAILURE_WINDOW_MS
  const transientOpenMs = options.transientOpenMs ?? DEFAULT_TRANSIENT_OPEN_MS
  const quotaOpenMs = options.quotaOpenMs ?? DEFAULT_QUOTA_OPEN_MS
  const maxRetryAfterMs = options.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS

  const cacheCircuit = (key: string, state: CircuitState): void => {
    circuits.delete(key)
    circuits.set(key, state)
    while (circuits.size > maxEntries) {
      const oldestKey = circuits.keys().next().value
      if (oldestKey === undefined) break
      circuits.delete(oldestKey)
    }
  }

  const recordSuccess = (key: string): void => {
    circuits.delete(key)
  }

  // Inspect every key first, then reserve any half-open probes together. This avoids leaving one
  // circuit stuck in half-open when another key blocks the same request.
  const assertAllClosed = (keys: readonly string[]): boolean => {
    const uniqueKeys = [...new Set(keys)]
    const currentTime = now()

    for (const key of uniqueKeys) {
      const state = circuits.get(key)
      if (!state) continue
      if (state.openedUntil > currentTime) {
        throw circuitOpenError('TDX circuit breaker is open', state.warning)
      }
      if (state.halfOpen) {
        throw circuitOpenError('TDX circuit breaker probe is in progress', state.warning)
      }
    }

    let probing = false
    for (const key of uniqueKeys) {
      const state = circuits.get(key)
      if (!state) continue
      if (state.openedUntil > 0) {
        cacheCircuit(key, {
          ...state,
          failures: failureThreshold - 1,
          openedUntil: 0,
          halfOpen: true,
        })
        probing = true
      } else if (currentTime - state.lastFailureAt >= failureWindowMs) {
        circuits.delete(key)
      }
    }
    return probing
  }

  const assertClosed = (key: string): boolean => assertAllClosed([key])

  const recordFailure = (key: string, error: TDXServiceError, retryAfter: string | null = null): void => {
    const status = error.status
    const transient = status === undefined || status === 408 || (status >= 500 && status <= 599)
    if (!error.rateLimited && !transient) {
      recordSuccess(key)
      return
    }

    const currentTime = now()
    const previous = circuits.get(key)
    const failures = previous?.halfOpen
      ? failureThreshold
      : previous && currentTime - previous.lastFailureAt < failureWindowMs
        ? previous.failures + 1
        : 1
    const warning = error.warning ?? (error.rateLimited ? 'tdx-rate-limit' : 'tdx-unavailable')
    let openedUntil = 0
    if (error.rateLimited) {
      const openFor = warning === 'tdx-quota'
        ? quotaOpenMs
        : retryAfterMilliseconds(retryAfter, currentTime, maxRetryAfterMs) ?? transientOpenMs
      openedUntil = currentTime + openFor
    } else if (failures >= failureThreshold) {
      openedUntil = currentTime + transientOpenMs
    }

    cacheCircuit(key, {
      failures,
      lastFailureAt: currentTime,
      openedUntil,
      halfOpen: false,
      warning,
    })
    if (openedUntil > currentTime && (!previous || previous.openedUntil <= currentTime)) {
      options.onOpened?.({ key, warning, openMs: openedUntil - currentTime })
    }
  }

  return {
    assertClosed,
    assertAllClosed,
    recordFailure,
    recordSuccess,
    reset: () => circuits.clear(),
  }
}

export const tokenCircuitKey = (credentialKey: string): string => `token/${credentialKey}`
export const dataCircuitKey = (
  credentialKey: string,
  operation = 'default',
  scope = 'global',
): string => `data/${credentialKey}/${operation}/${scope}`
export const dataRateLimitCircuitKey = (credentialKey: string): string => `data-limit/${credentialKey}`

export function redactedCircuitKey(key: string): string {
  const [kind, _credential, ...rest] = key.split('/')
  if (kind === 'token') return 'token/*'
  if (kind === 'data-limit') return 'data-limit/*'
  if (kind === 'data' && rest.length >= 2) return ['data', '*', ...rest].join('/')
  return 'unknown'
}

function circuitOpenError(message: string, warning: TDXWarning): TDXServiceError {
  const error = new TDXServiceError(
    message,
    warning === 'tdx-unavailable' ? 503 : 429,
    { failureKind: 'circuit_open' },
  )
  error.warning = warning
  return error
}

function retryAfterMilliseconds(value: string | null, now: number, maxRetryAfterMs: number): number | undefined {
  if (!value) return undefined
  const seconds = Number(value.trim())
  const milliseconds = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(value) - now
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return undefined
  return Math.min(Math.max(milliseconds, 1000), maxRetryAfterMs)
}
