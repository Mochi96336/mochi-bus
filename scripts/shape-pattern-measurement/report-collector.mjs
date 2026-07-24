import { stableStringify } from './util.mjs'

const PROJECTION_STATUSES = new Set(['success', 'no-path', 'frontier-empty', 'threshold-rejected', 'throw'])

export function createInstrumentationCollector(partition) {
  const pairMap = new Map()
  const shapeEvents = []
  const openProjections = new Map()
  const openOrientations = new Set()
  let currentPairKey = null
  const assignment = {
    bestCount: 0,
    forcedMatchCount: 0,
    forcedUnmatchedCount: 0,
    bestTimeSamplesMs: [],
    forcedMatchTimeSamplesMs: [],
    forcedUnmatchedTimeSamplesMs: [],
    activeMaskPeak: null,
  }

  const observe = (event, payload = {}) => {
    if (event === 'shape-classified') return shapeClassified(payload)
    if (event === 'pair-start') return pairStart(payload)
    if (event === 'pair-end') return pairEnd(payload)
    if (event === 'orientation-start') return orientationStart(payload)
    if (event === 'orientation-end') return orientationEnd(payload)
    if (event === 'projection-start') return projectionStart(payload)
    if (event === 'projection-layer') return projectionLayer(payload)
    if (event === 'projection-end') return projectionEnd(payload)
    if (event === 'assignment-solve-end') return assignmentEnd(payload)
    if (event === 'assignment-state') return assignmentState(payload)
    if (event === 'assignment-solve-start') return undefined
    throw new Error(`Unknown instrumentation event: ${event}`)
  }

  function shapeClassified(payload) {
    shapeEvents.push({
      shapeId: requiredId(payload.shapeId, 'shapeId'),
      direction: enumValue(payload.direction, [0, 1, 2], 'direction'),
      rawCoordinateCount: nonNegativeInteger(payload.rawCoordinateCount, 'rawCoordinateCount'),
      normalizedCoordinateCount: nullableNonNegativeInteger(payload.normalizedCoordinateCount, 'normalizedCoordinateCount'),
      segmentCount: nullableNonNegativeInteger(payload.segmentCount, 'segmentCount'),
      closureClassification: enumValue(payload.closureClassification, ['not-direction-2', 'truly-closed', 'near-closed', 'open-or-invalid'], 'closureClassification'),
      closureGapDistanceMeters: nullableNonNegative(payload.closureGapDistanceMeters, 'closureGapDistanceMeters'),
      accepted: payload.accepted === true,
    })
  }

  function pairStart(payload) {
    if (currentPairKey !== null) throw new Error(`Nested pair-start in ${partition.partitionId}`)
    const key = pairKey(payload)
    if (pairMap.has(key)) throw new Error(`Duplicate pair-start for ${key}`)
    currentPairKey = key
    pairMap.set(key, {
      patternId: requiredId(payload.patternId, 'patternId'),
      shapeId: requiredId(payload.shapeId, 'shapeId'),
      stopCount: nonNegativeInteger(payload.stopCount, 'stopCount'),
      rawCoordinateCount: nonNegativeInteger(payload.rawCoordinateCount, 'rawCoordinateCount'),
      normalizedCoordinateCount: nonNegativeInteger(payload.normalizedCoordinateCount, 'normalizedCoordinateCount'),
      segmentCount: nonNegativeInteger(payload.segmentCount, 'segmentCount'),
      direction2UnwrappedSegmentCount: null,
      duplicateCoordinateRemovalCount: null,
      collinearCoordinateRemovalCount: null,
      closureClassification: enumValue(payload.closureClassification, ['not-direction-2', 'truly-closed', 'near-closed'], 'closureClassification'),
      closureGapDistanceMeters: nullableNonNegative(payload.closureGapDistanceMeters, 'closureGapDistanceMeters'),
      projectionCandidateCount: null,
      peakFrontierWidth: null,
      retainedNodeCount: null,
      parentNodeCount: null,
      pathKeyApproximateBytes: null,
      forwardTimeMs: null,
      reverseTimeMs: null,
      costObjectiveSolveTimeMs: null,
      spanObjectiveSolveTimeMs: null,
      projectionOutcomes: [],
      pairTimeMs: null,
      compatible: null,
      status: null,
      instrumented: true,
    })
  }

  function pairEnd(payload) {
    const key = pairKey(payload)
    if (currentPairKey !== key) throw new Error(`pair-end without matching pair-start for ${key}`)
    if ([...openProjections.keys()].some((projectionKey) => projectionKey.startsWith(`${key}\0`))) {
      throw new Error(`pair-end with open projection for ${key}`)
    }
    if ([...openOrientations].some((orientationKey) => orientationKey.startsWith(`${key}\0`))) {
      throw new Error(`pair-end with open orientation for ${key}`)
    }
    const record = pairMap.get(key)
    if (record.status !== null) throw new Error(`Duplicate pair-end for ${key}`)
    record.pairTimeMs = finiteNonNegative(payload.elapsedMs, 'pair elapsedMs')
    record.status = enumValue(payload.status, ['compatible', 'incompatible', 'throw'], 'pair status')
    record.compatible = payload.compatible === null ? null : Boolean(payload.compatible)
    if (record.status === 'compatible' && record.compatible !== true) throw new Error('Compatible pair status disagrees with compatible flag')
    if (record.status === 'incompatible' && record.compatible !== false) throw new Error('Incompatible pair status disagrees with compatible flag')
    currentPairKey = null
  }

  function orientationStart(payload) {
    currentRecord(payload)
    const key = orientationKey(payload)
    if (openOrientations.has(key)) throw new Error(`Duplicate orientation-start for ${key}`)
    openOrientations.add(key)
  }

  function orientationEnd(payload) {
    const record = currentRecord(payload)
    const key = orientationKey(payload)
    if (!openOrientations.has(key)) throw new Error(`orientation-end without matching start for ${key}`)
    if ([...openProjections.keys()].some((projectionKey) => projectionKey.startsWith(`${key}\0`))) {
      throw new Error(`orientation-end with open projection for ${key}`)
    }
    openOrientations.delete(key)
    const orientation = enumValue(payload.orientation, ['forward', 'reverse'], 'orientation')
    enumValue(payload.status, ['success', 'no-path', 'throw'], 'orientation status')
    const field = orientation === 'forward' ? 'forwardTimeMs' : 'reverseTimeMs'
    record[field] = addNullable(record[field], finiteNonNegative(payload.elapsedMs, `${orientation} elapsedMs`))
  }

  function projectionStart(payload) {
    const record = currentRecord(payload)
    const orientation = enumValue(payload.orientation, ['forward', 'reverse'], 'orientation')
    if (!openOrientations.has(`${pairKey(payload)}\0${orientation}`)) throw new Error('projection-start without open orientation')
    const key = projectionKey(payload)
    if (openProjections.has(key)) throw new Error(`Duplicate projection-start for ${key}`)
    const segmentCount = nonNegativeInteger(payload.segmentCount, 'projection segmentCount')
    const candidateCount = nonNegativeInteger(payload.candidateCount, 'projection candidateCount')
    if (record.closureClassification === 'truly-closed') {
      record.direction2UnwrappedSegmentCount = maxNullable(record.direction2UnwrappedSegmentCount, segmentCount)
    } else if (record.segmentCount !== segmentCount) {
      throw new Error(`Projection segment count disagrees for ${key}`)
    }
    record.projectionCandidateCount = addNullable(record.projectionCandidateCount, candidateCount)
    openProjections.set(key, { record })
  }

  function projectionLayer(payload) {
    const key = projectionKey(payload)
    const state = openProjections.get(key)
    if (!state) throw new Error(`projection-layer without start for ${key}`)
    state.record.peakFrontierWidth = maxNullable(state.record.peakFrontierWidth, nonNegativeInteger(payload.frontierWidth, 'frontierWidth'))
    state.record.retainedNodeCount = addNullable(state.record.retainedNodeCount, nonNegativeInteger(payload.retainedNodes, 'retainedNodes'))
    state.record.parentNodeCount = addNullable(state.record.parentNodeCount, nonNegativeInteger(payload.parentNodeCount, 'parentNodeCount'))
    state.record.pathKeyApproximateBytes = addNullable(state.record.pathKeyApproximateBytes, nonNegativeInteger(payload.pathKeyChars, 'pathKeyChars') * 2)
  }

  function projectionEnd(payload) {
    const key = projectionKey(payload)
    const state = openProjections.get(key)
    if (!state) throw new Error(`projection-end without start for ${key}`)
    openProjections.delete(key)
    const status = enumValue(payload.status, [...PROJECTION_STATUSES], 'projection status')
    const elapsedMs = finiteNonNegative(payload.elapsedMs, 'projection elapsedMs')
    const objective = enumValue(payload.objective, ['cost', 'span'], 'objective')
    const field = objective === 'span' ? 'spanObjectiveSolveTimeMs' : 'costObjectiveSolveTimeMs'
    state.record[field] = addNullable(state.record[field], elapsedMs)
    state.record.projectionOutcomes.push({
      orientation: enumValue(payload.orientation, ['forward', 'reverse'], 'orientation'),
      objective,
      status,
      elapsedMs,
    })
  }

  function assignmentEnd(payload) {
    const kind = enumValue(payload.kind, ['best', 'forced-match', 'forced-unmatched'], 'assignment kind')
    const elapsedMs = finiteNonNegative(payload.elapsedMs, 'assignment elapsedMs')
    if (payload.status !== 'success') throw new Error(`Assignment solve did not complete: ${kind}`)
    if (kind === 'best') {
      assignment.bestCount += 1
      assignment.bestTimeSamplesMs.push(elapsedMs)
    } else if (kind === 'forced-match') {
      assignment.forcedMatchCount += 1
      assignment.forcedMatchTimeSamplesMs.push(elapsedMs)
    } else {
      assignment.forcedUnmatchedCount += 1
      assignment.forcedUnmatchedTimeSamplesMs.push(elapsedMs)
    }
  }

  function assignmentState(payload) {
    if (payload.kind === null) throw new Error('assignment-state is missing its solve kind')
    assignment.activeMaskPeak = maxNullable(assignment.activeMaskPeak, nonNegativeInteger(payload.activeMaskCount, 'activeMaskCount'))
  }

  function currentRecord(payload) {
    const key = pairKey(payload)
    if (currentPairKey !== key) throw new Error(`Event is not associated with the current pair: ${key}`)
    const record = pairMap.get(key)
    if (!record) throw new Error(`Unknown pair: ${key}`)
    return record
  }

  return {
    observe,
    finish: () => {
      if (currentPairKey !== null) throw new Error(`Unclosed instrumentation pair in ${partition.partitionId}`)
      if (openOrientations.size) throw new Error(`Unclosed orientation in ${partition.partitionId}`)
      if (openProjections.size) throw new Error(`Unclosed projection solve in ${partition.partitionId}`)
      for (const record of pairMap.values()) {
        if (record.status === null) throw new Error(`Pair record has no end event: ${record.patternId}/${record.shapeId}`)
      }
    },
    snapshot: () => ({
      shapes: [...shapeEvents].sort((a, b) => stableStringify(a).localeCompare(stableStringify(b))),
      pairs: [...pairMap.values()].map(finalizePair).sort(comparePairRecord),
      assignment: {
        bestCount: assignment.bestCount,
        forcedMatchCount: assignment.forcedMatchCount,
        forcedUnmatchedCount: assignment.forcedUnmatchedCount,
        bestTimeSamplesMs: [...assignment.bestTimeSamplesMs],
        forcedMatchTimeSamplesMs: [...assignment.forcedMatchTimeSamplesMs],
        forcedUnmatchedTimeSamplesMs: [...assignment.forcedUnmatchedTimeSamplesMs],
        activeMaskPeak: assignment.activeMaskPeak,
      },
    }),
  }
}

function finalizePair(record) {
  return {
    ...record,
    projectionOutcomes: [...record.projectionOutcomes].sort((a, b) =>
      `${a.orientation}\0${a.objective}`.localeCompare(`${b.orientation}\0${b.objective}`)),
  }
}

export function structuralCollectorSnapshot(snapshot) {
  return {
    shapes: snapshot.shapes,
    pairs: snapshot.pairs.map((pair) => ({
      ...pair,
      pairTimeMs: null,
      forwardTimeMs: null,
      reverseTimeMs: null,
      costObjectiveSolveTimeMs: null,
      spanObjectiveSolveTimeMs: null,
      projectionOutcomes: pair.projectionOutcomes.map(({ elapsedMs: _elapsedMs, ...outcome }) => outcome),
    })),
    assignment: {
      bestCount: snapshot.assignment.bestCount,
      forcedMatchCount: snapshot.assignment.forcedMatchCount,
      forcedUnmatchedCount: snapshot.assignment.forcedUnmatchedCount,
      activeMaskPeak: snapshot.assignment.activeMaskPeak,
    },
  }
}

export function assertCollectorsDeterministic(collectors, partitionId) {
  if (!collectors.length) return
  const expected = stableStringify(structuralCollectorSnapshot(collectors[0]))
  for (const collector of collectors.slice(1)) {
    if (stableStringify(structuralCollectorSnapshot(collector)) !== expected) {
      throw new Error(`Instrumentation counters are not deterministic for partition ${partitionId}`)
    }
  }
}

export function aggregatePairIterations(collectors, partitionId) {
  assertCollectorsDeterministic(collectors, partitionId)
  if (!collectors.length) return []
  return collectors[0].pairs.map((base, index) => {
    const samples = collectors.map((collector) => collector.pairs[index])
    return {
      partitionId,
      ...base,
      pairTimeMs: medianFinite(samples.map((entry) => entry.pairTimeMs)),
      forwardTimeMs: medianFinite(samples.map((entry) => entry.forwardTimeMs)),
      reverseTimeMs: medianFinite(samples.map((entry) => entry.reverseTimeMs)),
      costObjectiveSolveTimeMs: medianFinite(samples.map((entry) => entry.costObjectiveSolveTimeMs)),
      spanObjectiveSolveTimeMs: medianFinite(samples.map((entry) => entry.spanObjectiveSolveTimeMs)),
      projectionOutcomes: base.projectionOutcomes.map((outcome, outcomeIndex) => ({
        ...outcome,
        elapsedMs: medianFinite(samples.map((entry) => entry.projectionOutcomes[outcomeIndex]?.elapsedMs)),
      })),
    }
  })
}

function pairKey(payload) { return `${requiredId(payload.patternId, 'patternId')}\0${requiredId(payload.shapeId, 'shapeId')}` }
function orientationKey(payload) { return `${pairKey(payload)}\0${enumValue(payload.orientation, ['forward', 'reverse'], 'orientation')}` }
function projectionKey(payload) {
  return `${orientationKey(payload)}\0${enumValue(payload.objective, ['cost', 'span'], 'objective')}`
}
function requiredId(value, name) {
  if (typeof value !== 'string' || !value) throw new TypeError(`${name} must be a non-empty string`)
  return value
}
function nonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`)
  return value
}
function finiteNonNegative(value, name) {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${name} must be finite and non-negative`)
  return value
}
function nullableNonNegative(value, name) { return value === null ? null : finiteNonNegative(value, name) }
function enumValue(value, allowed, name) {
  if (!allowed.includes(value)) throw new TypeError(`${name} is invalid`)
  return value
}
function nullableNonNegativeInteger(value, name) { return value === null ? null : nonNegativeInteger(value, name) }
function addNullable(current, value) { return current === null ? value : current + value }
function maxNullable(current, value) { return current === null ? value : Math.max(current, value) }
function medianFinite(values) {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!finite.length) return null
  return finite[Math.ceil(finite.length * 0.5) - 1]
}
function comparePairRecord(a, b) {
  return `${a.patternId}\0${a.shapeId}`.localeCompare(`${b.patternId}\0${b.shapeId}`)
}
