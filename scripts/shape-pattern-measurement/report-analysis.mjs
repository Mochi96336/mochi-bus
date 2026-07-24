import { contentHash, distribution, omitNondeterministic, stableStringify } from './util.mjs'

const UNRESOLVED_REASON_FIELDS = Object.freeze({
  'invalid-pattern': 'invalidPattern',
  'no-compatible-shape': 'noCompatibleShape',
  'compatible-shape-assigned': 'compatibleShapeAssigned',
  'assignment-ambiguous': 'assignmentAmbiguous',
  'tolerance-equivalent-alternatives': 'toleranceEquivalentAlternatives',
  'contradictory-complete-identity': 'contradictoryCompleteIdentity',
  'near-closed-geometry-disabled': 'nearClosedGeometryDisabled',
  'rejected-or-invalid-shapes': 'rejectedOrInvalidShapes',
})
const REJECTED_SHAPE_REASONS = new Set(['duplicate-shape-id', 'invalid-coordinates', 'direction-2-not-closed'])

export const SUMMARY_METRIC_FIELDS = Object.freeze([
  'patternCount', 'shapeCount', 'minSideCount', 'compatibleEdgeCount',
  'compatibleEdgeDensity', 'stopCount', 'rawCoordinateCount',
  'normalizedCoordinateCount', 'segmentCount', 'peakFrontierWidth',
  'retainedNodeCount', 'pairLatencyMs', 'matcherLatencyMs',
  'assignmentLatencyMs', 'ambiguityProofLatencyMs', 'rssDeltaBytes',
  'heapDeltaBytes',
])

export const OUTLIER_FIELDS = Object.freeze([
  'largestPatternPartitions', 'largestShapePartitions', 'largestMinSidePartitions',
  'densestCompatibleMatrices', 'mostStopsPairs', 'mostSegmentsPairs',
  'widestFrontierPairs', 'mostRetainedNodesPairs', 'slowestPairScoring',
  'slowestAssignmentProofs', 'slowestPartitions', 'highestRssDeltaPartitions',
  'highestHeapDeltaPartitions', 'direction2MostSiblings',
])

const DETERMINISTIC_OUTLIER_FIELDS = new Set([
  'largestPatternPartitions', 'largestShapePartitions', 'largestMinSidePartitions',
  'densestCompatibleMatrices', 'mostStopsPairs', 'mostSegmentsPairs',
  'widestFrontierPairs', 'mostRetainedNodesPairs', 'direction2MostSiblings',
])

export function deterministicContentHash(report) {
  assertProvenanceScope(report.metadata.provenance)
  assertSourceScopedCandidateIdentities(report.partitions)
  const deterministicOutliers = Object.fromEntries(Object.entries(report.outliers)
    .filter(([key]) => DETERMINISTIC_OUTLIER_FIELDS.has(key)))
  return contentHash(omitNondeterministic({
    metadata: report.metadata,
    partitions: report.partitions,
    pairs: report.pairs,
    outcomes: report.outcomes,
    summary: report.summary,
    outliers: deterministicOutliers,
  }))
}

export function buildSummary(partitions, pairs) {
  const fields = {
    patternCount: partitions.map((item) => item.patternCount),
    shapeCount: partitions.map((item) => item.shapeCount),
    minSideCount: partitions.map((item) => item.minSideCount),
    compatibleEdgeCount: partitions.map((item) => item.compatibleEdgeCount),
    compatibleEdgeDensity: partitions.map((item) => item.compatibleEdgeDensity),
    stopCount: pairs.map((item) => item.stopCount),
    rawCoordinateCount: pairs.map((item) => item.rawCoordinateCount),
    normalizedCoordinateCount: pairs.map((item) => item.normalizedCoordinateCount),
    segmentCount: pairs.map((item) => item.segmentCount),
    peakFrontierWidth: pairs.map((item) => item.peakFrontierWidth),
    retainedNodeCount: pairs.map((item) => item.retainedNodeCount),
    pairLatencyMs: pairs.map((item) => item.pairTimeMs),
    matcherLatencyMs: partitions.map((item) => item.matcherLatencyMs),
    assignmentLatencyMs: partitions.map((item) => item.bestAssignmentTimeMs),
    ambiguityProofLatencyMs: partitions.map((item) => item.ambiguityProofTimeMs),
    rssDeltaBytes: partitions.map((item) => item.memoryObservation?.rssDeltaBytes),
    heapDeltaBytes: partitions.map((item) => item.memoryObservation?.heapDeltaBytes),
  }
  return Object.fromEntries(SUMMARY_METRIC_FIELDS.map((key) => [key, distribution(fields[key])]))
}

export function buildOutliers(partitions, pairs, topN) {
  return {
    largestPatternPartitions: top(partitions, 'patternCount', topN, (item) => item.partitionId),
    largestShapePartitions: top(partitions, 'shapeCount', topN, (item) => item.partitionId),
    largestMinSidePartitions: top(partitions, 'minSideCount', topN, (item) => item.partitionId),
    densestCompatibleMatrices: top(partitions, 'compatibleEdgeDensity', topN, (item) => item.partitionId),
    mostStopsPairs: top(pairs, 'stopCount', topN, pairIdentity),
    mostSegmentsPairs: top(pairs, 'segmentCount', topN, pairIdentity),
    widestFrontierPairs: top(pairs, 'peakFrontierWidth', topN, pairIdentity),
    mostRetainedNodesPairs: top(pairs, 'retainedNodeCount', topN, pairIdentity),
    slowestPairScoring: top(pairs, 'pairTimeMs', topN, pairIdentity),
    slowestAssignmentProofs: top(partitions, 'ambiguityProofTimeMs', topN, (item) => item.partitionId),
    slowestPartitions: top(partitions, 'matcherLatencyMs', topN, (item) => item.partitionId),
    highestRssDeltaPartitions: top(partitions, ['memoryObservation', 'rssDeltaBytes'], topN, (item) => item.partitionId),
    highestHeapDeltaPartitions: top(partitions, ['memoryObservation', 'heapDeltaBytes'], topN, (item) => item.partitionId),
    direction2MostSiblings: top(partitions.filter((item) => item.direction === 2), 'shapeCount', topN, (item) => item.partitionId),
  }
}

export function createOutcomeCounts(candidateBundle) {
  return {
    exactIdentity: 0,
    geometry: 0,
    invalidPattern: 0,
    noCompatibleShape: 0,
    compatibleShapeAssigned: 0,
    assignmentAmbiguous: 0,
    toleranceEquivalentAlternatives: 0,
    contradictoryCompleteIdentity: 0,
    nearClosedGeometryDisabled: 0,
    rejectedOrInvalidShapes: 0,
    rejectedShapeReasons: {},
    sourceRejections: { ...(candidateBundle.rejectionCounts ?? {}) },
    unusedShapes: 0,
  }
}

export function createDirection2Counts(pairMetricsAvailable) {
  return {
    pairMetricsAvailable,
    trulyClosed: pairMetricsAvailable ? 0 : null,
    nearClosed: pairMetricsAvailable ? 0 : null,
    openOrInvalid: pairMetricsAvailable ? 0 : null,
    identitySuccess: 0,
    geometrySuccess: 0,
    failClosedUnresolved: 0,
    rejectedCount: 0,
  }
}

export function accumulateOutcomes(target, result) {
  target.exactIdentity += result.matches.filter((entry) => entry.basis === 'exact-identity').length
  target.geometry += result.matches.filter((entry) => entry.basis === 'geometry').length
  for (const entry of result.unresolved) {
    const field = UNRESOLVED_REASON_FIELDS[entry.reason]
    if (!field) throw new Error(`Unknown unresolved reason: ${entry.reason}`)
    target[field] += 1
  }
  for (const entry of result.rejectedShapes) {
    if (!REJECTED_SHAPE_REASONS.has(entry.reason)) throw new Error(`Unknown rejected Shape reason: ${entry.reason}`)
    target.rejectedShapeReasons[entry.reason] = (target.rejectedShapeReasons[entry.reason] ?? 0) + 1
  }
  target.unusedShapes += result.unusedShapeIds.length
}

export function accumulateDirection2(target, partition, result, collectorSnapshot) {
  if (partition.direction !== 2) return
  target.identitySuccess += result.matches.filter((entry) => entry.basis === 'exact-identity').length
  target.geometrySuccess += result.matches.filter((entry) => entry.basis === 'geometry').length
  target.failClosedUnresolved += result.unresolved.length
  target.rejectedCount += result.rejectedShapes.length
  if (!target.pairMetricsAvailable) return
  for (const shape of collectorSnapshot.shapes) {
    if (shape.direction !== 2) continue
    if (shape.closureClassification === 'truly-closed') target.trulyClosed += 1
    else if (shape.closureClassification === 'near-closed') target.nearClosed += 1
    else if (shape.closureClassification === 'open-or-invalid') target.openOrInvalid += 1
    else throw new Error(`Unknown Direction 2 closure classification: ${shape.closureClassification}`)
  }
}

export function maxRawUpdateTime(rawManifest) {
  return rawManifest.endpoints.map((entry) => entry.maxUpdateTime).filter(Boolean).sort().at(-1) ?? null
}

export function countBy(records, selector) {
  const result = {}
  for (const record of records) {
    const key = selector(record)
    result[key] = (result[key] ?? 0) + 1
  }
  return Object.fromEntries(Object.entries(result).sort())
}

function assertProvenanceScope(provenance) {
  if (!Array.isArray(provenance?.selectedCities) || provenance.selectedCities.length === 0
    || new Set(provenance.selectedCities).size !== provenance.selectedCities.length
    || typeof provenance.includeIntercity !== 'boolean' || !Array.isArray(provenance.endpoints)) {
    throw new TypeError('report provenance scope is invalid')
  }
  const expected = []
  for (const city of provenance.selectedCities) {
    if (typeof city !== 'string' || !city) throw new TypeError('report provenance city is invalid')
    expected.push(endpointIdentity('city', city, 'shape'))
    expected.push(endpointIdentity('city', city, 'stop-of-route'))
  }
  if (provenance.includeIntercity) {
    expected.push(endpointIdentity('intercity', null, 'shape'))
    expected.push(endpointIdentity('intercity', null, 'stop-of-route'))
  }
  const actual = provenance.endpoints.map((entry) => ({
    endpointId: entry.endpointId,
    scope: entry.scope,
    city: entry.city,
    category: entry.category,
    fileName: entry.fileName,
  })).sort((a, b) => a.endpointId.localeCompare(b.endpointId))
  expected.sort((a, b) => a.endpointId.localeCompare(b.endpointId))
  if (stableStringify(actual) !== stableStringify(expected)) {
    throw new TypeError('report provenance endpoints do not match selected scope')
  }
}

function endpointIdentity(scope, city, category) {
  const endpointId = scope === 'intercity'
    ? `intercity-${category}`
    : `city-${city}-${category}`
  return {
    endpointId,
    scope,
    city,
    category,
    fileName: `${endpointId}.json`,
  }
}

function assertSourceScopedCandidateIdentities(partitions) {
  for (const partition of partitions) {
    const prefix = partition.sourceScope === 'intercity'
      ? 'intercity:'
      : `city-${partition.city}:`
    for (const id of [...partition.patternIds, ...partition.shapeIds]) {
      if (!id.startsWith(prefix)) {
        throw new TypeError(`candidate identity is not scoped to partition source: ${partition.partitionId}`)
      }
    }
  }
}

function top(records, field, count, identity) {
  const valueAt = Array.isArray(field)
    ? (record) => field.reduce((value, key) => value?.[key], record)
    : (record) => record[field]
  const unique = new Map()
  for (const record of records) {
    const value = valueAt(record)
    if (!Number.isFinite(value)) continue
    const key = identity(record)
    const previous = unique.get(key)
    if (!previous || value > valueAt(previous)) unique.set(key, record)
  }
  return [...unique.values()].sort((a, b) => valueAt(b) - valueAt(a)
    || identity(a).localeCompare(identity(b))).slice(0, count)
}

function pairIdentity(item) { return `${item.partitionId}\0${item.patternId}\0${item.shapeId}` }
