import { HARNESS_VERSION, REPORT_FILES, REPORT_SCHEMA_VERSION } from './constants.mjs'
import {
  buildOutliers, buildSummary, deterministicContentHash, OUTLIER_FIELDS,
  SUMMARY_METRIC_FIELDS,
} from './report-analysis.mjs'
import { assertFiniteTree, stableStringify } from './util.mjs'

const TOP_LEVEL_KEYS = ['metadata', 'partitions', 'pairs', 'outcomes', 'outliers', 'summary']
const DISTRIBUTION_KEYS = ['count', 'min', 'median', 'p75', 'p90', 'p95', 'p99', 'max']
const PARTITION_KEYS = [
  'partitionId', 'sourceScope', 'city', 'routeUid', 'direction', 'patternIds', 'shapeIds',
  'patternCount', 'shapeCount', 'minSideCount', 'candidateMultiplicity',
  'completeIdentityCount', 'duplicateIdentityCount', 'contradictoryIdentityCount',
  'compatibleEdgeCount', 'compatibleEdgeDensity', 'pairMetricsAvailable',
  'bestAssignmentTimeMs', 'ambiguityProofTimeMs', 'matcherLatencyMs',
  'matcherIterationSamplesMs', 'matchedCount', 'unresolvedCount', 'unusedShapeCount',
  'outcomeReasonCounts', 'rejectedShapeReasonCounts', 'memoryObservation',
  'assignmentBestSolveCount', 'forcedMatchSolveCount', 'forcedUnmatchedSolveCount',
  'activeMaskPeak', 'direction2ClosureCounts',
]
const MEMORY_KEYS = [
  'rssBeforeBytes', 'rssAfterBytes', 'rssDeltaBytes',
  'heapBeforeBytes', 'heapAfterBytes', 'heapDeltaBytes',
  'sampleCount', 'forcedGc', 'peakClaimed',
]
const PAIR_KEYS = [
  'partitionId', 'patternId', 'shapeId', 'stopCount', 'rawCoordinateCount',
  'normalizedCoordinateCount', 'segmentCount', 'direction2UnwrappedSegmentCount',
  'duplicateCoordinateRemovalCount', 'collinearCoordinateRemovalCount',
  'closureClassification', 'closureGapDistanceMeters', 'projectionCandidateCount',
  'peakFrontierWidth', 'retainedNodeCount', 'parentNodeCount',
  'pathKeyApproximateBytes', 'forwardTimeMs', 'reverseTimeMs',
  'costObjectiveSolveTimeMs', 'spanObjectiveSolveTimeMs', 'projectionOutcomes',
  'pairTimeMs', 'compatible', 'status', 'instrumented',
]
const PROJECTION_KEYS = ['orientation', 'objective', 'status', 'elapsedMs']
const METADATA_KEYS = [
  'schemaVersion', 'runId', 'repositoryMainSha', 'matcherSourcePath',
  'matcherSourceSha256', 'matcherSourceGitBlobSha1', 'harnessVersion', 'topOutlierCount',
  'nodeVersion', 'os', 'cpuModel', 'logicalCpuCount', 'totalMemoryBytes',
  'startedAt', 'completedAt', 'provenance', 'mode', 'pairMetricsAvailable',
  'warmupCount', 'iterationCount', 'loaderTimings', 'memoryPolicy',
  'deterministicContentHash',
]
const PROVENANCE_KEYS = [
  'fetchedAt', 'selectedCities', 'includeIntercity', 'endpoints',
  'bundleContentHash', 'tdxPayloadMaxUpdateTime',
]
const ENDPOINT_KEYS = [
  'endpointId', 'scope', 'city', 'category', 'fileName', 'contentHash',
  'itemCount', 'maxUpdateTime',
]
const LOADER_TIMING_KEYS = ['sourceVerificationTimeMs', 'transpileTimeMs', 'importTimeMs']
const OUTCOME_KEYS = [
  'exactIdentity', 'geometry', 'invalidPattern', 'noCompatibleShape',
  'compatibleShapeAssigned', 'assignmentAmbiguous',
  'toleranceEquivalentAlternatives', 'contradictoryCompleteIdentity',
  'nearClosedGeometryDisabled', 'rejectedOrInvalidShapes',
  'rejectedShapeReasons', 'sourceRejections', 'unusedShapes', 'direction2',
]
const DIRECTION2_KEYS = [
  'pairMetricsAvailable', 'trulyClosed', 'nearClosed', 'openOrInvalid',
  'identitySuccess', 'geometrySuccess', 'failClosedUnresolved', 'rejectedCount',
]
const UNRESOLVED_REASONS = new Set([
  'invalid-pattern', 'no-compatible-shape', 'compatible-shape-assigned',
  'assignment-ambiguous', 'tolerance-equivalent-alternatives',
  'contradictory-complete-identity', 'near-closed-geometry-disabled',
  'rejected-or-invalid-shapes',
])
const REJECTED_SHAPE_REASONS = new Set([
  'duplicate-shape-id', 'invalid-coordinates', 'direction-2-not-closed',
])
const OUTCOME_REASON_FIELDS = Object.freeze({
  'invalid-pattern': 'invalidPattern',
  'no-compatible-shape': 'noCompatibleShape',
  'compatible-shape-assigned': 'compatibleShapeAssigned',
  'assignment-ambiguous': 'assignmentAmbiguous',
  'tolerance-equivalent-alternatives': 'toleranceEquivalentAlternatives',
  'contradictory-complete-identity': 'contradictoryCompleteIdentity',
  'near-closed-geometry-disabled': 'nearClosedGeometryDisabled',
  'rejected-or-invalid-shapes': 'rejectedOrInvalidShapes',
})

export function validateReport(report) {
  object(report, 'report')
  exactKeys(report, TOP_LEVEL_KEYS, 'report')
  array(report.partitions, 'report.partitions')
  array(report.pairs, 'report.pairs')
  validateMetadata(report.metadata)
  report.partitions.forEach((entry, index) => validatePartition(entry, `report.partitions[${index}]`))
  report.pairs.forEach((entry, index) => validatePair(entry, `report.pairs[${index}]`))
  validateOutcomes(report.outcomes)
  validateOutliers(report.outliers)
  validateDistributionTree(report.summary)
  assertFiniteTree(report)
  reconcileReport(report)
  return report
}

function validateMetadata(value) {
  object(value, 'report.metadata')
  exactKeys(value, METADATA_KEYS, 'report.metadata')
  integer(value.schemaVersion, 'report.metadata.schemaVersion', { minimum: REPORT_SCHEMA_VERSION, maximum: REPORT_SCHEMA_VERSION })
  canonicalRunId(value.runId, 'report.metadata.runId')
  hash(value.repositoryMainSha, 40, 'report.metadata.repositoryMainSha')
  string(value.matcherSourcePath, 'report.metadata.matcherSourcePath')
  hash(value.matcherSourceSha256, 64, 'report.metadata.matcherSourceSha256')
  hash(value.matcherSourceGitBlobSha1, 40, 'report.metadata.matcherSourceGitBlobSha1')
  integer(value.harnessVersion, 'report.metadata.harnessVersion', { minimum: HARNESS_VERSION, maximum: HARNESS_VERSION })
  integer(value.topOutlierCount, 'report.metadata.topOutlierCount', { minimum: 1 })
  string(value.nodeVersion, 'report.metadata.nodeVersion')
  exactKeys(value.os, ['platform', 'release'], 'report.metadata.os')
  string(value.os.platform, 'report.metadata.os.platform')
  string(value.os.release, 'report.metadata.os.release')
  string(value.cpuModel, 'report.metadata.cpuModel')
  integer(value.logicalCpuCount, 'report.metadata.logicalCpuCount', { minimum: 1 })
  number(value.totalMemoryBytes, 'report.metadata.totalMemoryBytes', { minimum: 0 })
  timestamp(value.startedAt, 'report.metadata.startedAt')
  timestamp(value.completedAt, 'report.metadata.completedAt')
  validateProvenance(value.provenance)
  enumValue(value.mode, ['instrumented', 'uninstrumented'], 'report.metadata.mode')
  boolean(value.pairMetricsAvailable, 'report.metadata.pairMetricsAvailable')
  if (value.pairMetricsAvailable !== (value.mode === 'instrumented')) throw new TypeError('metadata mode disagrees with pairMetricsAvailable')
  integer(value.warmupCount, 'report.metadata.warmupCount', { minimum: 0 })
  integer(value.iterationCount, 'report.metadata.iterationCount', { minimum: 1 })
  exactKeys(value.loaderTimings, ['plain', 'instrumented'], 'report.metadata.loaderTimings')
  validateLoaderTiming(value.loaderTimings.plain, 'report.metadata.loaderTimings.plain')
  if (value.mode === 'instrumented') validateLoaderTiming(value.loaderTimings.instrumented, 'report.metadata.loaderTimings.instrumented')
  else nullable(value.loaderTimings.instrumented, 'report.metadata.loaderTimings.instrumented')
  enumValue(value.memoryPolicy, ['before-after-process-memory-no-forced-gc-no-peak-claim'], 'report.metadata.memoryPolicy')
  hash(value.deterministicContentHash, 64, 'report.metadata.deterministicContentHash')
}

function validateLoaderTiming(value, path) {
  object(value, path)
  exactKeys(value, LOADER_TIMING_KEYS, path)
  for (const key of LOADER_TIMING_KEYS) number(value[key], `${path}.${key}`, { minimum: 0 })
}

function validateProvenance(value) {
  object(value, 'report.metadata.provenance')
  exactKeys(value, PROVENANCE_KEYS, 'report.metadata.provenance')
  timestamp(value.fetchedAt, 'report.metadata.provenance.fetchedAt')
  array(value.selectedCities, 'report.metadata.provenance.selectedCities')
  value.selectedCities.forEach((city, index) => string(city, `report.metadata.provenance.selectedCities[${index}]`))
  if (new Set(value.selectedCities).size !== value.selectedCities.length) throw new TypeError('provenance selectedCities contains duplicates')
  boolean(value.includeIntercity, 'report.metadata.provenance.includeIntercity')
  array(value.endpoints, 'report.metadata.provenance.endpoints')
  const endpointIds = new Set()
  for (let index = 0; index < value.endpoints.length; index += 1) {
    const endpoint = value.endpoints[index]
    const path = `report.metadata.provenance.endpoints[${index}]`
    object(endpoint, path)
    exactKeys(endpoint, ENDPOINT_KEYS, path)
    string(endpoint.endpointId, `${path}.endpointId`)
    if (endpointIds.has(endpoint.endpointId)) throw new TypeError(`duplicate endpointId ${endpoint.endpointId}`)
    endpointIds.add(endpoint.endpointId)
    enumValue(endpoint.scope, ['city', 'intercity'], `${path}.scope`)
    nullableString(endpoint.city, `${path}.city`)
    enumValue(endpoint.category, ['shape', 'stop-of-route'], `${path}.category`)
    string(endpoint.fileName, `${path}.fileName`)
    hash(endpoint.contentHash, 64, `${path}.contentHash`)
    integer(endpoint.itemCount, `${path}.itemCount`, { minimum: 0 })
    nullableTimestamp(endpoint.maxUpdateTime, `${path}.maxUpdateTime`)
  }
  hash(value.bundleContentHash, 64, 'report.metadata.provenance.bundleContentHash')
  nullableTimestamp(value.tdxPayloadMaxUpdateTime, 'report.metadata.provenance.tdxPayloadMaxUpdateTime')
}

function validatePartition(value, path) {
  object(value, path)
  exactKeys(value, PARTITION_KEYS, path)
  string(value.partitionId, `${path}.partitionId`)
  enumValue(value.sourceScope, ['city', 'intercity'], `${path}.sourceScope`)
  nullableString(value.city, `${path}.city`)
  if (value.sourceScope === 'city' && value.city === null) throw new TypeError(`${path}.city is required for city scope`)
  if (value.sourceScope === 'intercity' && value.city !== null) throw new TypeError(`${path}.city must be null for InterCity scope`)
  string(value.routeUid, `${path}.routeUid`)
  enumValue(value.direction, [0, 1, 2], `${path}.direction`)
  validateIdentityList(value.patternIds, `${path}.patternIds`)
  validateIdentityList(value.shapeIds, `${path}.shapeIds`)
  for (const key of [
    'patternCount', 'shapeCount', 'minSideCount', 'candidateMultiplicity',
    'completeIdentityCount', 'duplicateIdentityCount', 'contradictoryIdentityCount',
    'matchedCount', 'unresolvedCount', 'unusedShapeCount',
  ]) integer(value[key], `${path}.${key}`, { minimum: 0 })
  if (value.patternIds.length !== value.patternCount) throw new TypeError(`${path}.patternIds count mismatch`)
  if (value.shapeIds.length !== value.shapeCount) throw new TypeError(`${path}.shapeIds count mismatch`)
  if (value.minSideCount !== Math.min(value.patternCount, value.shapeCount)) throw new TypeError(`${path}.minSideCount disagrees with candidate counts`)
  if (value.candidateMultiplicity !== value.patternCount * value.shapeCount) throw new TypeError(`${path}.candidateMultiplicity disagrees with candidate counts`)
  boolean(value.pairMetricsAvailable, `${path}.pairMetricsAvailable`)
  nullableInteger(value.compatibleEdgeCount, `${path}.compatibleEdgeCount`, { minimum: 0 })
  nullableNumber(value.compatibleEdgeDensity, `${path}.compatibleEdgeDensity`, { minimum: 0, maximum: 1 })
  nullableNumber(value.bestAssignmentTimeMs, `${path}.bestAssignmentTimeMs`, { minimum: 0 })
  nullableNumber(value.ambiguityProofTimeMs, `${path}.ambiguityProofTimeMs`, { minimum: 0 })
  number(value.matcherLatencyMs, `${path}.matcherLatencyMs`, { minimum: 0 })
  array(value.matcherIterationSamplesMs, `${path}.matcherIterationSamplesMs`)
  if (!value.matcherIterationSamplesMs.length) throw new TypeError(`${path}.matcherIterationSamplesMs must not be empty`)
  value.matcherIterationSamplesMs.forEach((sample, index) => number(sample, `${path}.matcherIterationSamplesMs[${index}]`, { minimum: 0 }))
  countMap(value.outcomeReasonCounts, UNRESOLVED_REASONS, `${path}.outcomeReasonCounts`)
  countMap(value.rejectedShapeReasonCounts, REJECTED_SHAPE_REASONS, `${path}.rejectedShapeReasonCounts`)
  validateMemory(value.memoryObservation, `${path}.memoryObservation`)
  for (const key of ['assignmentBestSolveCount', 'forcedMatchSolveCount', 'forcedUnmatchedSolveCount', 'activeMaskPeak']) {
    nullableInteger(value[key], `${path}.${key}`, { minimum: 0 })
  }
  if (value.direction2ClosureCounts !== null) {
    if (value.direction !== 2 || !value.pairMetricsAvailable) throw new TypeError(`${path}.direction2ClosureCounts is not available`)
    countMap(value.direction2ClosureCounts, new Set(['truly-closed', 'near-closed', 'open-or-invalid']), `${path}.direction2ClosureCounts`)
  }
  if (value.matchedCount + value.unresolvedCount !== value.patternCount) throw new TypeError(`${path} pattern accounting mismatch`)
  if (!value.pairMetricsAvailable) {
    for (const key of ['compatibleEdgeCount', 'compatibleEdgeDensity', 'bestAssignmentTimeMs', 'ambiguityProofTimeMs', 'assignmentBestSolveCount', 'forcedMatchSolveCount', 'forcedUnmatchedSolveCount', 'activeMaskPeak']) {
      if (value[key] !== null) throw new TypeError(`${path}.${key} must be null when pair metrics are unavailable`)
    }
    return
  }
  if (value.compatibleEdgeCount === null || value.compatibleEdgeDensity === null
    || value.assignmentBestSolveCount === null || value.forcedMatchSolveCount === null
    || value.forcedUnmatchedSolveCount === null) {
    throw new TypeError(`${path} instrumented metrics are required`)
  }
  if (value.compatibleEdgeCount > value.candidateMultiplicity) throw new TypeError(`${path}.compatibleEdgeCount exceeds candidate capacity`)
  const expectedDensity = value.candidateMultiplicity === 0 ? 0 : value.compatibleEdgeCount / value.candidateMultiplicity
  if (!sameNumber(value.compatibleEdgeDensity, expectedDensity)) throw new TypeError(`${path}.compatibleEdgeDensity disagrees with count/capacity`)
  if ((value.assignmentBestSolveCount === 0) !== (value.bestAssignmentTimeMs === null)) {
    throw new TypeError(`${path} best assignment timing/count null contract mismatch`)
  }
  const proofCount = value.forcedMatchSolveCount + value.forcedUnmatchedSolveCount
  if ((proofCount === 0) !== (value.ambiguityProofTimeMs === null)) {
    throw new TypeError(`${path} ambiguity proof timing/count null contract mismatch`)
  }
}

function validateIdentityList(value, path) {
  array(value, path)
  value.forEach((id, index) => string(id, `${path}[${index}]`))
  const ordered = [...value].sort()
  if (new Set(value).size !== value.length) throw new TypeError(`${path} contains duplicate candidate identity`)
  if (stableStringify(value) !== stableStringify(ordered)) throw new TypeError(`${path} must use deterministic ordering`)
}

function validateMemory(value, path) {
  object(value, path)
  exactKeys(value, MEMORY_KEYS, path)
  for (const key of MEMORY_KEYS.slice(0, 6)) number(value[key], `${path}.${key}`)
  integer(value.sampleCount, `${path}.sampleCount`, { minimum: 1 })
  boolean(value.forcedGc, `${path}.forcedGc`)
  boolean(value.peakClaimed, `${path}.peakClaimed`)
  if (value.forcedGc || value.peakClaimed) throw new TypeError(`${path} may not claim forced GC or peak memory`)
  if (value.rssAfterBytes - value.rssBeforeBytes !== value.rssDeltaBytes) throw new TypeError(`${path} RSS delta mismatch`)
  if (value.heapAfterBytes - value.heapBeforeBytes !== value.heapDeltaBytes) throw new TypeError(`${path} heap delta mismatch`)
}

function validatePair(value, path) {
  object(value, path)
  exactKeys(value, PAIR_KEYS, path)
  for (const key of ['partitionId', 'patternId', 'shapeId']) string(value[key], `${path}.${key}`)
  for (const key of ['stopCount', 'rawCoordinateCount', 'normalizedCoordinateCount', 'segmentCount']) integer(value[key], `${path}.${key}`, { minimum: 0 })
  for (const key of ['direction2UnwrappedSegmentCount', 'duplicateCoordinateRemovalCount', 'collinearCoordinateRemovalCount', 'projectionCandidateCount', 'peakFrontierWidth', 'retainedNodeCount', 'parentNodeCount', 'pathKeyApproximateBytes']) nullableInteger(value[key], `${path}.${key}`, { minimum: 0 })
  enumValue(value.closureClassification, ['not-direction-2', 'truly-closed', 'near-closed'], `${path}.closureClassification`)
  nullableNumber(value.closureGapDistanceMeters, `${path}.closureGapDistanceMeters`, { minimum: 0 })
  for (const key of ['forwardTimeMs', 'reverseTimeMs', 'costObjectiveSolveTimeMs', 'spanObjectiveSolveTimeMs', 'pairTimeMs']) nullableNumber(value[key], `${path}.${key}`, { minimum: 0 })
  array(value.projectionOutcomes, `${path}.projectionOutcomes`)
  value.projectionOutcomes.forEach((outcome, index) => {
    const outcomePath = `${path}.projectionOutcomes[${index}]`
    object(outcome, outcomePath)
    exactKeys(outcome, PROJECTION_KEYS, outcomePath)
    enumValue(outcome.orientation, ['forward', 'reverse'], `${outcomePath}.orientation`)
    enumValue(outcome.objective, ['cost', 'span'], `${outcomePath}.objective`)
    enumValue(outcome.status, ['success', 'no-path', 'frontier-empty', 'threshold-rejected', 'throw'], `${outcomePath}.status`)
    number(outcome.elapsedMs, `${outcomePath}.elapsedMs`, { minimum: 0 })
  })
  nullableBoolean(value.compatible, `${path}.compatible`)
  enumValue(value.status, ['compatible', 'incompatible', 'throw'], `${path}.status`)
  if (value.instrumented !== true) throw new TypeError(`${path}.instrumented must be true`)
  if (value.status === 'compatible' && value.compatible !== true) throw new TypeError(`${path} compatible status mismatch`)
  if (value.status === 'incompatible' && value.compatible !== false) throw new TypeError(`${path} incompatible status mismatch`)
}

function validateOutcomes(value) {
  object(value, 'report.outcomes')
  exactKeys(value, OUTCOME_KEYS, 'report.outcomes')
  for (const key of OUTCOME_KEYS.slice(0, 10)) integer(value[key], `report.outcomes.${key}`, { minimum: 0 })
  countMap(value.rejectedShapeReasons, REJECTED_SHAPE_REASONS, 'report.outcomes.rejectedShapeReasons')
  genericCountMap(value.sourceRejections, 'report.outcomes.sourceRejections')
  integer(value.unusedShapes, 'report.outcomes.unusedShapes', { minimum: 0 })
  object(value.direction2, 'report.outcomes.direction2')
  exactKeys(value.direction2, DIRECTION2_KEYS, 'report.outcomes.direction2')
  boolean(value.direction2.pairMetricsAvailable, 'report.outcomes.direction2.pairMetricsAvailable')
  for (const key of ['trulyClosed', 'nearClosed', 'openOrInvalid']) nullableInteger(value.direction2[key], `report.outcomes.direction2.${key}`, { minimum: 0 })
  for (const key of ['identitySuccess', 'geometrySuccess', 'failClosedUnresolved', 'rejectedCount']) integer(value.direction2[key], `report.outcomes.direction2.${key}`, { minimum: 0 })
  if (!value.direction2.pairMetricsAvailable && ['trulyClosed', 'nearClosed', 'openOrInvalid'].some((key) => value.direction2[key] !== null)) {
    throw new TypeError('Direction 2 closure counts must be null when pair metrics are unavailable')
  }
}

function validateOutliers(value) {
  object(value, 'report.outliers')
  exactKeys(value, OUTLIER_FIELDS, 'report.outliers')
  for (const key of OUTLIER_FIELDS) array(value[key], `report.outliers.${key}`)
}

export function validateDistributionTree(summary) {
  object(summary, 'report.summary')
  exactKeys(summary, SUMMARY_METRIC_FIELDS, 'report.summary')
  for (const name of SUMMARY_METRIC_FIELDS) {
    const value = summary[name]
    object(value, `report.summary.${name}`)
    exactKeys(value, DISTRIBUTION_KEYS, `report.summary.${name}`)
    integer(value.count, `report.summary.${name}.count`, { minimum: 0 })
    const metrics = DISTRIBUTION_KEYS.slice(1)
    for (const key of metrics) nullableNumber(value[key], `report.summary.${name}.${key}`)
    if (value.count === 0) {
      if (metrics.some((key) => value[key] !== null)) throw new TypeError(`report.summary.${name} count-zero distributions require null metrics`)
      continue
    }
    if (metrics.some((key) => value[key] === null)) throw new TypeError(`report.summary.${name} non-empty distributions require metrics`)
    for (let index = 1; index < metrics.length; index += 1) {
      if (value[metrics[index]] < value[metrics[index - 1]]) throw new TypeError(`report.summary.${name} percentiles are not ordered`)
    }
  }
}

function reconcileReport(report) {
  const partitionById = new Map()
  const patternOwner = new Map()
  const shapeOwner = new Map()
  for (const partition of report.partitions) {
    if (partitionById.has(partition.partitionId)) throw new TypeError(`duplicate partitionId ${partition.partitionId}`)
    partitionById.set(partition.partitionId, partition)
    if (partition.pairMetricsAvailable !== report.metadata.pairMetricsAvailable) throw new TypeError(`partition ${partition.partitionId} pairMetricsAvailable mismatch`)
    for (const patternId of partition.patternIds) registerCandidate(patternOwner, patternId, partition.partitionId, 'pattern')
    for (const shapeId of partition.shapeIds) registerCandidate(shapeOwner, shapeId, partition.partitionId, 'Shape')
  }
  if (!report.metadata.pairMetricsAvailable && report.pairs.length) throw new TypeError('uninstrumented reports must not contain pair rows')
  const pairKeys = new Set()
  const compatibleByPartition = new Map()
  for (const pair of report.pairs) {
    const partition = partitionById.get(pair.partitionId)
    if (!partition) throw new TypeError(`pair references missing partition ${pair.partitionId}`)
    if (patternOwner.get(pair.patternId) !== pair.partitionId) throw new TypeError(`pair pattern is not a candidate in partition ${pair.partitionId}`)
    if (shapeOwner.get(pair.shapeId) !== pair.partitionId) throw new TypeError(`pair Shape is not a candidate in partition ${pair.partitionId}`)
    const key = `${pair.partitionId}\0${pair.patternId}\0${pair.shapeId}`
    if (pairKeys.has(key)) throw new TypeError(`duplicate pair ${key}`)
    pairKeys.add(key)
    if (pair.compatible === true) compatibleByPartition.set(pair.partitionId, (compatibleByPartition.get(pair.partitionId) ?? 0) + 1)
  }
  for (const partition of report.partitions) {
    if (partition.pairMetricsAvailable && partition.compatibleEdgeCount !== (compatibleByPartition.get(partition.partitionId) ?? 0)) {
      throw new TypeError(`partition ${partition.partitionId} compatible-edge reconciliation mismatch`)
    }
  }
  const matched = report.partitions.reduce((sum, entry) => sum + entry.matchedCount, 0)
  if (matched !== report.outcomes.exactIdentity + report.outcomes.geometry) throw new TypeError('global matched outcome reconciliation mismatch')
  const unresolvedByReason = {}
  for (const partition of report.partitions) for (const [reason, count] of Object.entries(partition.outcomeReasonCounts)) unresolvedByReason[reason] = (unresolvedByReason[reason] ?? 0) + count
  for (const [reason, field] of Object.entries(OUTCOME_REASON_FIELDS)) {
    if ((unresolvedByReason[reason] ?? 0) !== report.outcomes[field]) throw new TypeError(`global unresolved outcome reconciliation mismatch for ${reason}`)
  }
  const rejectedByReason = {}
  for (const partition of report.partitions) for (const [reason, count] of Object.entries(partition.rejectedShapeReasonCounts)) rejectedByReason[reason] = (rejectedByReason[reason] ?? 0) + count
  for (const reason of REJECTED_SHAPE_REASONS) {
    if ((rejectedByReason[reason] ?? 0) !== (report.outcomes.rejectedShapeReasons[reason] ?? 0)) throw new TypeError(`global rejected Shape reconciliation mismatch for ${reason}`)
  }
  if (report.partitions.reduce((sum, entry) => sum + entry.unusedShapeCount, 0) !== report.outcomes.unusedShapes) throw new TypeError('global unused Shape reconciliation mismatch')
  if (report.outcomes.direction2.pairMetricsAvailable !== report.metadata.pairMetricsAvailable) throw new TypeError('Direction 2 metrics availability mismatch')

  const expectedSummary = buildSummary(report.partitions, report.pairs)
  if (stableStringify(report.summary) !== stableStringify(expectedSummary)) throw new TypeError('summary does not reconcile with formal rows')
  const expectedOutliers = buildOutliers(report.partitions, report.pairs, report.metadata.topOutlierCount)
  if (stableStringify(report.outliers) !== stableStringify(expectedOutliers)) throw new TypeError('outliers do not reconcile with formal rows and ranking')
  const expectedHash = deterministicContentHash(report)
  if (report.metadata.deterministicContentHash !== expectedHash) throw new TypeError('deterministic content hash mismatch')
}

function registerCandidate(owners, id, partitionId, kind) {
  if (owners.has(id)) throw new TypeError(`duplicate ${kind} candidate identity ${id}`)
  owners.set(id, partitionId)
}

export function validateCompletionManifest(value) {
  object(value, 'completion')
  const keys = [
    'schemaVersion', 'runId', 'mode', 'matcherSourceSha256', 'matcherSourceGitBlobSha1',
    'bundleContentHash', 'selectedCities', 'includeIntercity', 'harnessVersion',
    'reportFiles', 'publishedAt',
  ]
  exactKeys(value, keys, 'completion')
  integer(value.schemaVersion, 'completion.schemaVersion', { minimum: REPORT_SCHEMA_VERSION, maximum: REPORT_SCHEMA_VERSION })
  canonicalRunId(value.runId, 'completion.runId')
  enumValue(value.mode, ['instrumented', 'uninstrumented'], 'completion.mode')
  hash(value.matcherSourceSha256, 64, 'completion.matcherSourceSha256')
  hash(value.matcherSourceGitBlobSha1, 40, 'completion.matcherSourceGitBlobSha1')
  hash(value.bundleContentHash, 64, 'completion.bundleContentHash')
  array(value.selectedCities, 'completion.selectedCities')
  value.selectedCities.forEach((city, index) => string(city, `completion.selectedCities[${index}]`))
  if (new Set(value.selectedCities).size !== value.selectedCities.length) throw new TypeError('completion selectedCities contains duplicates')
  boolean(value.includeIntercity, 'completion.includeIntercity')
  integer(value.harnessVersion, 'completion.harnessVersion', { minimum: HARNESS_VERSION, maximum: HARNESS_VERSION })
  object(value.reportFiles, 'completion.reportFiles')
  exactKeys(value.reportFiles, REPORT_FILES, 'completion.reportFiles')
  for (const file of REPORT_FILES) hash(value.reportFiles[file], 64, `completion.reportFiles.${file}`)
  timestamp(value.publishedAt, 'completion.publishedAt')
  return value
}

export function toJsonLines(records) {
  return records.map((record) => stableStringify(record)).join('\n') + (records.length ? '\n' : '')
}

export function parseJsonLines(source) {
  if (!source.trim()) return []
  return source.trimEnd().split('\n').map((line) => JSON.parse(line))
}

function countMap(value, allowed, path) {
  object(value, path)
  for (const [key, count] of Object.entries(value)) {
    if (!allowed.has(key)) throw new TypeError(`${path} contains unknown reason ${key}`)
    integer(count, `${path}.${key}`, { minimum: 0 })
  }
}
function genericCountMap(value, path) {
  object(value, path)
  for (const [key, count] of Object.entries(value)) {
    if (!key) throw new TypeError(`${path} contains an empty key`)
    integer(count, `${path}.${key}`, { minimum: 0 })
  }
}
function exactKeys(value, allowed, path) {
  object(value, path)
  const actual = Object.keys(value).sort()
  const expected = [...allowed].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${path} fields mismatch; expected ${expected.join(', ')}`)
  }
}
function canonicalRunId(value, path) {
  string(value, path)
  if (value !== value.trim() || value.length > 128 || value === '.' || value === '..'
    || /[\\/\0]/.test(value) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new TypeError(`${path} must be a bounded canonical path fragment`)
  }
  let decoded
  try { decoded = decodeURIComponent(value) } catch { throw new TypeError(`${path} encoding is invalid`) }
  if (decoded !== value) throw new TypeError(`${path} must not change after percent decoding`)
}
function sameNumber(left, right) {
  if (Object.is(left, right)) return true
  const tolerance = Number.EPSILON * 16 * Math.max(1, Math.abs(left), Math.abs(right))
  return Math.abs(left - right) <= tolerance
}
function object(value, path) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${path} must be an object`) }
function array(value, path) { if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`) }
function string(value, path) { if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${path} must be a non-empty string`) }
function nullableString(value, path) { if (value !== null) string(value, path) }
function boolean(value, path) { if (typeof value !== 'boolean') throw new TypeError(`${path} must be boolean`) }
function nullableBoolean(value, path) { if (value !== null) boolean(value, path) }
function nullable(value, path) { if (value !== null) throw new TypeError(`${path} must be null`) }
function integer(value, path, bounds = {}) { if (!Number.isSafeInteger(value)) throw new TypeError(`${path} must be a safe integer`); boundsCheck(value, path, bounds) }
function nullableInteger(value, path, bounds = {}) { if (value !== null) integer(value, path, bounds) }
function number(value, path, bounds = {}) { if (!Number.isFinite(value)) throw new TypeError(`${path} must be finite`); boundsCheck(value, path, bounds) }
function nullableNumber(value, path, bounds = {}) { if (value !== null) number(value, path, bounds) }
function boundsCheck(value, path, { minimum, maximum } = {}) { if (minimum !== undefined && value < minimum) throw new RangeError(`${path} must be >= ${minimum}`); if (maximum !== undefined && value > maximum) throw new RangeError(`${path} must be <= ${maximum}`) }
function enumValue(value, allowed, path) { if (!allowed.includes(value)) throw new TypeError(`${path} is invalid`) }
function hash(value, length, path) { if (typeof value !== 'string' || !new RegExp(`^[a-f0-9]{${length}}$`).test(value)) throw new TypeError(`${path} must be a ${length}-character lowercase hex hash`) }
function timestamp(value, path) { string(value, path); if (!Number.isFinite(Date.parse(value))) throw new TypeError(`${path} must be an ISO timestamp`) }
function nullableTimestamp(value, path) { if (value !== null) timestamp(value, path) }
