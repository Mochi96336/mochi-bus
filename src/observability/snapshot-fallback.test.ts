import { describe, expect, it, vi } from 'vitest'
import {
  createSnapshotFallbackReporter,
  snapshotFallbackFailureClasses,
} from './snapshot-fallback'

describe('snapshot fallback telemetry', () => {
  it('emits one sampled low-cardinality fallback event per request reporter', () => {
    const emitter = vi.fn()
    const report = createSnapshotFallbackReporter({
      operation: 'map_stop_place',
      random: () => 0,
      emitter,
    })

    expect(report({
      city: 'Taipei',
      snapshotVersion: '20260910T000000000Z',
      reason: 'manifest_missing',
    })).toBe(true)
    expect(report({
      city: 'Taipei',
      snapshotVersion: '20260910T000000000Z',
      reason: 'r2',
    })).toBe(false)

    expect(emitter).toHaveBeenCalledTimes(1)
    expect(emitter).toHaveBeenCalledWith(expect.objectContaining({
      eventSchema: 7,
      event: 'snapshot_fallback_selected',
      city: 'Taipei',
      operation: 'map_stop_place',
      result: 'degraded',
      source: 'fallback',
      snapshotVersion: '20260910T000000000Z',
      sampleProbability: 0.1,
      failureClass: 'manifest_missing',
      trafficClass: 'user',
    }))
  })

  it('keeps unsampled organic requests silent', () => {
    const emitter = vi.fn()
    const report = createSnapshotFallbackReporter({
      operation: 'map_search',
      random: () => 0.5,
      emitter,
    })

    expect(report({
      city: 'NewTaipei',
      snapshotVersion: 'v1',
      reason: 'routing_authority_incomplete',
    })).toBe(false)
    expect(emitter).not.toHaveBeenCalled()
  })

  it.each(snapshotFallbackFailureClasses)('accepts bounded fallback reason %s', (reason) => {
    const emitter = vi.fn()
    const report = createSnapshotFallbackReporter({
      operation: 'bus_stop_routes',
      random: () => 0,
      emitter,
    })

    expect(report({ city: 'Taichung', snapshotVersion: 'v1', reason })).toBe(true)
    expect(emitter).toHaveBeenCalledWith(expect.objectContaining({ failureClass: reason }))
  })

  it('fails soft for unsupported city or emitter failure', () => {
    const unsupported = createSnapshotFallbackReporter({
      operation: 'map_search',
      random: () => 0,
      emitter: vi.fn(),
    })
    expect(unsupported({
      city: 'NotACity',
      snapshotVersion: 'v1',
      reason: 'manifest_missing',
    })).toBe(false)

    const report = createSnapshotFallbackReporter({
      operation: 'map_search',
      random: () => 0,
      emitter: () => { throw new Error('telemetry sink unavailable') },
    })
    expect(() => report({
      city: 'Taipei',
      snapshotVersion: 'v1',
      reason: 'r2',
    })).not.toThrow()
  })
})
