import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMeasurementReport } from './report.mjs'
import { runMeasurement } from './run.mjs'

const roots = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'shape-measure-memory-'))
  roots.push(root)
  const rawDir = join(root, 'raw')
  const reportDir = join(root, 'reports')
  const generatedRoot = join(root, 'generated')
  await Promise.all([mkdir(rawDir), mkdir(reportDir), mkdir(generatedRoot)])
  return { root, rawDir, reportDir, generatedRoot }
}

function runOptions(root) {
  return {
    replay: true,
    cities: ['Taipei'],
    citiesExplicit: false,
    includeIntercity: false,
    includeIntercityExplicit: false,
    rawDir: root.rawDir,
    reportDir: root.reportDir,
    generatedRoot: root.generatedRoot,
    fetchConcurrency: 1,
    warmup: 0,
    iterations: 1,
    topOutliers: 2,
    instrumented: false,
    expectedMatcherSha256: null,
  }
}

function rawManifest() {
  return {
    schemaVersion: 2,
    fetchedAt: '2026-07-24T00:00:00.000Z',
    cities: ['Taipei'],
    includeIntercity: false,
    endpoints: [
      {
        endpointId: 'city-Taipei-shape', scope: 'city', city: 'Taipei', category: 'shape',
        fileName: 'city-Taipei-shape.json', contentHash: '4'.repeat(64), itemCount: 2, maxUpdateTime: null,
      },
      {
        endpointId: 'city-Taipei-stop-of-route', scope: 'city', city: 'Taipei', category: 'stop-of-route',
        fileName: 'city-Taipei-stop-of-route.json', contentHash: '5'.repeat(64), itemCount: 2, maxUpdateTime: null,
      },
    ],
    bundleContentHash: '6'.repeat(64),
  }
}

function candidatePartition(index) {
  const routeUid = `R${index}`
  const patternId = `city-Taipei:pattern:p${index}`
  const shapeId = `city-Taipei:shape:s${index}`
  return {
    partitionId: String(index).repeat(24),
    key: `city\0Taipei\0${routeUid}\00`,
    sourceScope: 'city',
    city: 'Taipei',
    routeUid,
    direction: 0,
    patterns: [{
      patternId, routeUid, subRouteUid: `SR${index}`, direction: 0,
      stops: [
        { stopUid: `A${index}`, coordinate: [121, 25] },
        { stopUid: `B${index}`, coordinate: [121.01, 25.01] },
      ],
    }],
    shapes: [{
      shapeId, routeUid, subRouteUid: `SR${index}`, direction: 0,
      coordinates: [[121, 25], [121.01, 25.01]],
    }],
    stats: {
      patternCount: 1,
      shapeCount: 1,
      minSideCount: 1,
      completeIdentityCount: 2,
      duplicateIdentityCount: 0,
      contradictoryIdentityCount: 0,
      candidateMultiplicity: 1,
    },
  }
}

function fakeLoader(onSecondInvoke) {
  let invocation = 0
  return async () => ({
    sourceSha256: '2'.repeat(64),
    sourceGitBlobSha1: '3'.repeat(40),
    loaderTimings: { sourceVerificationTimeMs: 0, transpileTimeMs: 0, importTimeMs: 0 },
    invoke: (patterns, shapes) => {
      invocation += 1
      if (invocation === 2) onSecondInvoke()
      return {
        matches: [{
          patternId: patterns[0].patternId,
          shapeId: shapes[0].shapeId,
          basis: 'exact-identity',
          costMeters: null,
          metrics: null,
        }],
        unresolved: [],
        rejectedShapes: [],
        unusedShapeIds: [],
      }
    },
    takeCollectorError: () => null,
    dispose: async () => undefined,
    outputPath: 'generated-test.mjs',
  })
}

describe('measurement working-set ownership', () => {
  it('detaches the verified raw bundle before report measurement begins', async () => {
    const root = await workspace()
    const source = {
      bundle: { schemaVersion: 2, fetchedAt: '2026-07-24T00:00:00.000Z', sources: [] },
      manifest: rawManifest(),
    }
    const candidateBundle = { partitions: [], rejected: [], rejectionCounts: {} }
    const buildCandidates = vi.fn(() => candidateBundle)
    const createReport = vi.fn(async ({ candidateBundle: received }) => {
      expect(source.bundle).toBeNull()
      expect(received).toBe(candidateBundle)
      return { metadata: { runId: 'bounded-memory-test' } }
    })

    await runMeasurement(runOptions(root), {
      replayRawBundle: async () => source,
      buildCandidatePartitions: buildCandidates,
      createMeasurementReport: createReport,
      publishMeasurementReport: async () => join(root.reportDir, 'bounded-memory-test'),
      repositoryMainSha: '1'.repeat(40),
    })

    expect(buildCandidates).toHaveBeenCalledTimes(1)
    expect(createReport).toHaveBeenCalledTimes(1)
  })

  it('releases each measured partition before invoking the next partition', async () => {
    const root = await workspace()
    const first = candidatePartition(1)
    const second = candidatePartition(2)
    const candidateBundle = { partitions: [first, second], rejected: [], rejectionCounts: {} }
    const progress = vi.fn()

    const report = await createMeasurementReport({
      candidateBundle,
      rawManifest: rawManifest(),
      options: {
        instrumented: false,
        expectedMatcherSha256: null,
        generatedRunDir: root.generatedRoot,
        warmup: 0,
        iterations: 1,
        topOutliers: 2,
      },
      repositoryMainSha: '1'.repeat(40),
    }, {
      loadMatcherModule: fakeLoader(() => {
        expect(first.patterns).toEqual([])
        expect(first.shapes).toEqual([])
      }),
      progress,
    })

    expect(report.partitions).toHaveLength(2)
    expect(first.patterns).toEqual([])
    expect(first.shapes).toEqual([])
    expect(second.patterns).toEqual([])
    expect(second.shapes).toEqual([])
    expect(progress.mock.calls.map(([entry]) => entry.phase)).toEqual([
      'partition-start', 'partition-complete',
      'partition-start', 'partition-complete',
    ])
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'partition-start',
      partitionId: first.partitionId,
      patternCount: 1,
      shapeCount: 1,
      candidateMultiplicity: 1,
    }))
  })
})
