import { describe, expect, it } from 'vitest'
import { collectorFailure } from './instrument-loader.mjs'
import { attachCleanupFailure, cleanupOnlyFailure } from './measurement-errors.mjs'

function serialized(error) {
  return JSON.stringify({
    name: error.name,
    message: error.message,
    code: error.code,
    stage: error.stage,
    cleanupFailures: error.cleanupFailures,
    cause: error.cause,
    stack: error.stack,
  })
}

describe('bounded public measurement errors', () => {
  it('redacts callback message, stack, payload identities and raw cause', () => {
    const raw = new Error('fake secret token pattern-p1 shape-s1')
    raw.stack = 'fake secret stack route-R1'
    const error = collectorFailure(raw, { event: 'pair-end', payload: { patternId: 'p1', shapeId: 's1' } })
    expect(error).toMatchObject({ code: 'MEASUREMENT_COLLECTOR_ERROR', stage: 'observer-callback' })
    const text = serialized(error)
    for (const forbidden of ['fake secret', 'pattern-p1', 'shape-s1', 'route-R1']) expect(text).not.toContain(forbidden)
    expect(error.cause).toBeUndefined()
  })

  it('preserves the primary code while adding bounded cleanup failures', () => {
    const primary = collectorFailure(new Error('secret'))
    const combined = attachCleanupFailure(primary, { stage: 'instrumented-dispose', temporaryPath: '/tmp/root/run-secret' })
    expect(combined.code).toBe('MEASUREMENT_COLLECTOR_ERROR')
    expect(combined.cleanupFailures).toEqual([{ stage: 'instrumented-dispose', temporaryPath: 'run-secret' }])
    expect(combined.cause).toBeUndefined()
  })

  it('uses a cleanup-specific code when there is no primary error', () => {
    expect(cleanupOnlyFailure({ stage: 'plain-dispose' })).toMatchObject({
      code: 'MEASUREMENT_CLEANUP_ERROR', stage: 'plain-dispose',
    })
  })
})
