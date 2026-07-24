import { describe, expect, it } from 'vitest'
import { buildOutliers, buildSummary, deterministicContentHash } from './report-analysis.mjs'
import { validateReport } from './report-schema.mjs'

const zeroDistribution = () => ({ count: 0, min: null, median: null, p75: null, p90: null, p95: null, p99: null, max: null })
const taipeiEndpoints = () => [
  { endpointId: 'city-Taipei-shape', scope: 'city', city: 'Taipei', category: 'shape', fileName: 'city-Taipei-shape.json', contentHash: '5'.repeat(64), itemCount: 1, maxUpdateTime: null },
  { endpointId: 'city-Taipei-stop-of-route', scope: 'city', city: 'Taipei', category: 'stop-of-route', fileName: 'city-Taipei-stop-of-route.json', contentHash: '6'.repeat(64), itemCount: 1, maxUpdateTime: null },
]

function reportFixture() {
  const partition = {
    partitionId: 'a'.repeat(24), sourceScope: 'city', city: 'Taipei', routeUid: 'R1', direction: 0,
    patternIds: ['city-Taipei:pattern:p1'], shapeIds: ['city-Taipei:shape:s1'],
    patternCount: 1, shapeCount: 1, minSideCount: 1, candidateMultiplicity: 1,
    completeIdentityCount: 2, duplicateIdentityCount: 0, contradictoryIdentityCount: 0,
    compatibleEdgeCount: 1, compatibleEdgeDensity: 1, pairMetricsAvailable: true,
    bestAssignmentTimeMs: null, ambiguityProofTimeMs: null, matcherLatencyMs: 0,
    matcherIterationSamplesMs: [0], matchedCount: 1, unresolvedCount: 0, unusedShapeCount: 0,
    outcomeReasonCounts: {}, rejectedShapeReasonCounts: {},
    memoryObservation: { rssBeforeBytes: 1, rssAfterBytes: 1, rssDeltaBytes: 0, heapBeforeBytes: 1, heapAfterBytes: 1, heapDeltaBytes: 0, sampleCount: 1, forcedGc: false, peakClaimed: false },
    assignmentBestSolveCount: 0, forcedMatchSolveCount: 0, forcedUnmatchedSolveCount: 0,
    activeMaskPeak: null, direction2ClosureCounts: null,
  }
  const pair = {
    partitionId: partition.partitionId, patternId: partition.patternIds[0], shapeId: partition.shapeIds[0],
    stopCount: 2, rawCoordinateCount: 2, normalizedCoordinateCount: 2, segmentCount: 1,
    direction2UnwrappedSegmentCount: null, duplicateCoordinateRemovalCount: null, collinearCoordinateRemovalCount: null,
    closureClassification: 'not-direction-2', closureGapDistanceMeters: null,
    projectionCandidateCount: 4, peakFrontierWidth: 1, retainedNodeCount: 1, parentNodeCount: 0,
    pathKeyApproximateBytes: 8, forwardTimeMs: 0, reverseTimeMs: 0,
    costObjectiveSolveTimeMs: 0, spanObjectiveSolveTimeMs: null,
    projectionOutcomes: [
      { orientation: 'forward', objective: 'cost', status: 'success', elapsedMs: 0 },
      { orientation: 'reverse', objective: 'cost', status: 'success', elapsedMs: 0 },
    ],
    pairTimeMs: 0, compatible: true, status: 'compatible', instrumented: true,
  }
  const report = {
    metadata: {
      schemaVersion: 3, runId: 'instrumented-test-run', repositoryMainSha: '1'.repeat(40),
      matcherSourcePath: 'src/domain/map/shape-pattern-matcher.ts', matcherSourceSha256: '2'.repeat(64),
      matcherSourceGitBlobSha1: '3'.repeat(40), harnessVersion: 3, topOutlierCount: 2,
      nodeVersion: 'v22.0.0', os: { platform: 'linux', release: 'test' }, cpuModel: 'test', logicalCpuCount: 1,
      totalMemoryBytes: 1, startedAt: '2026-07-23T00:00:00.000Z', completedAt: '2026-07-23T00:00:01.000Z',
      provenance: { fetchedAt: '2026-07-22T00:00:00.000Z', selectedCities: ['Taipei'], includeIntercity: false, endpoints: taipeiEndpoints(), bundleContentHash: '4'.repeat(64), tdxPayloadMaxUpdateTime: null },
      mode: 'instrumented', pairMetricsAvailable: true, warmupCount: 0, iterationCount: 1,
      loaderTimings: { plain: { sourceVerificationTimeMs: 0, transpileTimeMs: 0, importTimeMs: 0 }, instrumented: { sourceVerificationTimeMs: 0, transpileTimeMs: 0, importTimeMs: 0 } },
      memoryPolicy: 'before-after-process-memory-no-forced-gc-no-peak-claim', deterministicContentHash: '0'.repeat(64),
    },
    partitions: [partition], pairs: [pair],
    outcomes: { exactIdentity: 1, geometry: 0, invalidPattern: 0, noCompatibleShape: 0, compatibleShapeAssigned: 0, assignmentAmbiguous: 0, toleranceEquivalentAlternatives: 0, contradictoryCompleteIdentity: 0, nearClosedGeometryDisabled: 0, rejectedOrInvalidShapes: 0, rejectedShapeReasons: {}, sourceRejections: {}, unusedShapes: 0, direction2: { pairMetricsAvailable: true, trulyClosed: 0, nearClosed: 0, openOrInvalid: 0, identitySuccess: 0, geometrySuccess: 0, failClosedUnresolved: 0, rejectedCount: 0 } },
    outliers: {}, summary: {},
  }
  refreshDerived(report)
  return report
}

function refreshDerived(report) {
  report.summary = buildSummary(report.partitions, report.pairs)
  report.outliers = buildOutliers(report.partitions, report.pairs, report.metadata.topOutlierCount)
  report.metadata.deterministicContentHash = deterministicContentHash(report)
}

function addSecondPartition(report) {
  const partition = structuredClone(report.partitions[0])
  partition.partitionId = 'b'.repeat(24)
  partition.routeUid = 'R2'
  partition.patternIds = ['city-Taipei:pattern:p2']
  partition.shapeIds = ['city-Taipei:shape:s2']
  const pair = structuredClone(report.pairs[0])
  pair.partitionId = partition.partitionId
  pair.patternId = partition.patternIds[0]
  pair.shapeId = partition.shapeIds[0]
  pair.stopCount = 3
  report.partitions.push(partition)
  report.pairs.push(pair)
  report.outcomes.exactIdentity = 2
  refreshDerived(report)
}

function clonedReport() { return structuredClone(reportFixture()) }

describe('report integrity reconciliation', () => {
  it('accepts a report whose summary, outliers, memberships, provenance and hash derive from rows', () => {
    expect(() => validateReport(reportFixture())).not.toThrow()
  })

  it('checks nearest-rank distributions against an independent hand-calculated oracle', () => {
    const partitions = [1, 3, 2].map((patternCount, index) => ({
      patternCount, shapeCount: 0, minSideCount: 0, compatibleEdgeCount: null,
      compatibleEdgeDensity: null, matcherLatencyMs: index, bestAssignmentTimeMs: null,
      ambiguityProofTimeMs: null,
      memoryObservation: { rssDeltaBytes: index, heapDeltaBytes: -index },
    }))
    expect(buildSummary(partitions, []).patternCount).toEqual({
      count: 3, min: 1, median: 2, p75: 3, p90: 3, p95: 3, p99: 3, max: 3,
    })
  })

  it.each([
    ['empty summary', (r) => { r.summary = {} }],
    ['missing summary field', (r) => { delete r.summary.patternCount }],
    ['unknown summary field', (r) => { r.summary.unknown = zeroDistribution() }],
    ['row-inconsistent summary', (r) => { r.summary.patternCount.median = 999 }],
    ['edge count over capacity', (r) => { r.partitions[0].compatibleEdgeCount = 2 }],
    ['edge density mismatch', (r) => { r.partitions[0].compatibleEdgeDensity = 0.5 }],
    ['best count zero with finite timing', (r) => { r.partitions[0].bestAssignmentTimeMs = 0 }],
    ['best count positive with null timing', (r) => { r.partitions[0].assignmentBestSolveCount = 1 }],
    ['forced count zero with finite timing', (r) => { r.partitions[0].ambiguityProofTimeMs = 0 }],
    ['forced count positive with null timing', (r) => { r.partitions[0].forcedMatchSolveCount = 1 }],
    ['pair pattern missing', (r) => { r.pairs[0].patternId = 'missing-pattern' }],
    ['pair Shape missing', (r) => { r.pairs[0].shapeId = 'missing-shape' }],
    ['City pair uses InterCity candidate identity', (r) => { r.partitions[0].shapeIds = ['intercity:shape:s1']; r.pairs[0].shapeId = r.partitions[0].shapeIds[0] }],
    ['arbitrary outlier', (r) => { r.outliers.mostStopsPairs = [{ partitionId: r.partitions[0].partitionId, patternId: 'fake', shapeId: 'fake', stopCount: 999 }] }],
    ['outlier value mismatch', (r) => { r.outliers.mostStopsPairs[0].stopCount = 999 }],
    ['stale deterministic hash', (r) => { r.partitions[0].routeUid = 'R2' }],
    ['missing endpoint for selected city', (r) => { r.metadata.provenance.endpoints.pop() }],
    ['extra InterCity endpoint outside selected scope', (r) => { r.metadata.provenance.endpoints.push({ endpointId: 'intercity-shape', scope: 'intercity', city: null, category: 'shape', fileName: 'intercity-shape.json', contentHash: '7'.repeat(64), itemCount: 1, maxUpdateTime: null }) }],
    ['endpoint filename mismatch', (r) => { r.metadata.provenance.endpoints[0].fileName = 'wrong.json' }],
  ])('rejects %s', (_name, mutate) => {
    const report = clonedReport()
    mutate(report)
    expect(() => validateReport(report)).toThrow()
  })

  it('rejects an illegal nonzero density for zero candidate capacity', () => {
    const report = clonedReport()
    const partition = report.partitions[0]
    Object.assign(partition, {
      patternIds: [], shapeIds: [], patternCount: 0, shapeCount: 0, minSideCount: 0,
      candidateMultiplicity: 0, compatibleEdgeCount: 0, compatibleEdgeDensity: 1,
      matchedCount: 0, unresolvedCount: 0, unusedShapeCount: 0,
    })
    report.pairs = []
    report.outcomes.exactIdentity = 0
    expect(() => validateReport(report)).toThrow(/density|capacity/i)
  })

  it('rejects incorrect deterministic outlier ranking even when all references exist', () => {
    const report = clonedReport()
    addSecondPartition(report)
    report.outliers.mostStopsPairs.reverse()
    expect(() => validateReport(report)).toThrow(/outliers/i)
  })

  it('rejects duplicate candidate identities across source-scoped partitions', () => {
    const report = clonedReport()
    const duplicate = structuredClone(report.partitions[0])
    duplicate.partitionId = 'b'.repeat(24)
    duplicate.sourceScope = 'intercity'
    duplicate.city = null
    report.partitions.push(duplicate)
    expect(() => refreshDerived(report)).toThrow(/candidate identity|scoped/i)
  })
})
