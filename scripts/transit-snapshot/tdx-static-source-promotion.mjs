const PENDING_MARKER = Symbol.for('mochi-bus.tdx-static-cache-pending-promotions')
const FLIGHT_MARKER = Symbol.for('mochi-bus.tdx-static-cache-promotion-flight')

function pendingPromotions() {
  globalThis[PENDING_MARKER] ??= []
  return globalThis[PENDING_MARKER]
}

export function registerTdxStaticSourceCandidate(entry) {
  if (!entry?.cache?.promote || !entry?.candidate) return false
  pendingPromotions().push(entry)
  return true
}

// Validation is synchronous, so callers may intentionally fire-and-forget this drain.
// One process-wide flight serializes state.json commits and keeps candidates registered
// during the drain from being picked up until the next successful validation boundary.
export function promotePendingTdxStaticSources({ logger = console } = {}) {
  const existing = globalThis[FLIGHT_MARKER]
  if (existing) return existing

  const flight = (async () => {
    const pending = pendingPromotions().splice(0)
    let promoted = 0
    let failed = 0
    for (const entry of pending) {
      try {
        if (await entry.cache.promote(entry.candidate)) promoted += 1
        else failed += 1
      } catch (error) {
        failed += 1
        logger?.warn?.(`TDX static source cache promotion failed for ${entry.city ? `${entry.city}/` : ''}${entry.resource}: ${errorMessage(error)}`)
      }
    }
    if (pending.length) {
      logger?.log?.(JSON.stringify({
        event: 'tdx_static_cache_promotion',
        candidates: pending.length,
        promoted,
        failed,
      }))
    }
    return Object.freeze({ candidates: pending.length, promoted, failed })
  })().finally(() => {
    if (globalThis[FLIGHT_MARKER] === flight) globalThis[FLIGHT_MARKER] = null
  })

  globalThis[FLIGHT_MARKER] = flight
  return flight
}

export function pendingTdxStaticSourceCandidates() {
  return pendingPromotions().length
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
