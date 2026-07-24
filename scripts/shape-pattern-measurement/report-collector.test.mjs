import { describe, expect, it } from 'vitest'
import {
  aggregatePairIterations, assertCollectorsDeterministic, createInstrumentationCollector,
} from './report-collector.mjs'

const partition = { partitionId: 'a'.repeat(24) }

function drivePair(collector, {
  compatible = false,
  projectionStatus = 'threshold-rejected',
  elapsedMs = 0,
} = {}) {
  collector.observe('shape-classified', {
    shapeId: 's1', direction: 0, rawCoordinateCount: 2,
    normalizedCoordinateCount: 2, segmentCount: 1,
    closureClassification: 'not-direction-2', closureGapDistanceMeters: null, accepted: true,
  })
  collector.observe('pair-start', {
    patternId: 'p1', shapeId: 's1', stopCount: 2,
    rawCoordinateCount: 2, normalizedCoordinateCount: 2, segmentCount: 1,
    closureClassification: 'not-direction-2', closureGapDistanceMeters: null,
  })
  collector.observe('orientation-start', {
    patternId: 'p1', shapeId: 's1', orientation: 'forward',
  })
  collector.observe('projection-start', {
    patternId: 'p1', shapeId: 's1', orientation: 'forward', objective: 'cost',
    stopCount: 2, segmentCount: 1, candidateCount: 2,
  })
  collector.observe('projection-layer', {
    patternId: 'p1', shapeId: 's1', orientation: 'forward', objective: 'cost',
    layer: 0, frontierWidth: 1, retainedNodes: 1, parentNodeCount: 0, pathKeyChars: 12,
  })
  collector.observe('projection-end', {
    patternId: 'p1', shapeId: 's1', orientation: 'forward', objective: 'cost',
    status: projectionStatus, elapsedMs,
  })
  collector.observe('orientation-end', {
    patternId: 'p1', shapeId: 's1', orientation: 'forward', status: compatible ? 'success' : 'no-path', elapsedMs,
  })
  collector.observe('pair-end', {
    patternId: 'p1', shapeId: 's1',
    status: compatible ? 'compatible' : 'incompatible', compatible, elapsedMs,
  })
}

describe('formal matcher event collector', () => {
  it.each(['no-path', 'frontier-empty', 'threshold-rejected', 'throw'])(
    'records a completed %s projection solve with non-negative duration',
    (status) => {
      const collector = createInstrumentationCollector(partition)
      drivePair(collector, { projectionStatus: status, elapsedMs: 0 })
      collector.finish()
      expect(collector.snapshot().pairs[0].projectionOutcomes).toEqual([{
        orientation: 'forward', objective: 'cost', status, elapsedMs: 0,
      }])
    },
  )

  it('fails when a started pair, orientation or projection has no matching end event', () => {
    const collector = createInstrumentationCollector(partition)
    collector.observe('pair-start', {
      patternId: 'p1', shapeId: 's1', stopCount: 1,
      rawCoordinateCount: 2, normalizedCoordinateCount: 2, segmentCount: 1,
      closureClassification: 'not-direction-2', closureGapDistanceMeters: null,
    })
    collector.observe('orientation-start', {
      patternId: 'p1', shapeId: 's1', orientation: 'forward',
    })
    collector.observe('projection-start', {
      patternId: 'p1', shapeId: 's1', orientation: 'forward', objective: 'cost',
      stopCount: 1, segmentCount: 1, candidateCount: 1,
    })
    expect(() => collector.finish()).toThrow(/Unclosed/)
  })

  it('uses null for unavailable internals while preserving a genuinely measured zero', () => {
    const collector = createInstrumentationCollector(partition)
    drivePair(collector, { elapsedMs: 0 })
    collector.finish()
    const pair = collector.snapshot().pairs[0]
    expect(pair.pairTimeMs).toBe(0)
    expect(pair.duplicateCoordinateRemovalCount).toBeNull()
    expect(pair.collinearCoordinateRemovalCount).toBeNull()
    expect(pair.spanObjectiveSolveTimeMs).toBeNull()
  })

  it('requires identical structural counters across iterations and aggregates timing by median', () => {
    const first = createInstrumentationCollector(partition)
    drivePair(first, { elapsedMs: 1 })
    first.finish()
    const second = createInstrumentationCollector(partition)
    drivePair(second, { elapsedMs: 9 })
    second.finish()
    const snapshots = [first.snapshot(), second.snapshot()]
    expect(() => assertCollectorsDeterministic(snapshots, partition.partitionId)).not.toThrow()
    expect(aggregatePairIterations(snapshots, partition.partitionId)[0].pairTimeMs).toBe(1)

    snapshots[1].pairs[0].segmentCount = 99
    expect(() => assertCollectorsDeterministic(snapshots, partition.partitionId)).toThrow(/not deterministic/)
  })

  it('fails closed on unknown instrumentation events', () => {
    const collector = createInstrumentationCollector(partition)
    expect(() => collector.observe('new-production-event', {})).toThrow(/Unknown instrumentation event/)
  })
})
