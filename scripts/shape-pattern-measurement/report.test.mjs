import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { REPORT_FILES } from './constants.mjs'
import {
  createMeasurementReport, publishMeasurementReport, readPublishedReport,
  validatePublishedDirectory,
} from './report.mjs'
import { atomicWrite } from './util.mjs'

const PATTERN_ID = 'city-Taipei:pattern:p1'
const SHAPE_ID = 'city-Taipei:shape:s1'
const roots = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const result = {
  matches: [{ patternId: PATTERN_ID, shapeId: SHAPE_ID, basis: 'exact-identity', costMeters: null, metrics: null }],
  unresolved: [], rejectedShapes: [], unusedShapeIds: [],
}
const candidateBundle = {
  partitions: [{
    partitionId: 'a'.repeat(24), key: 'city\u0000Taipei\u0000R1\u00000',
    sourceScope: 'city', city: 'Taipei', routeUid: 'R1', direction: 0,
    patterns: [{ patternId: PATTERN_ID, routeUid: 'R1', subRouteUid: 'SR1', direction: 0, stops: [
      { stopUid: 'A', coordinate: [121, 25] }, { stopUid: 'B', coordinate: [121.01, 25.01] },
    ] }],
    shapes: [{ shapeId: SHAPE_ID, routeUid: 'R1', subRouteUid: 'SR1', direction: 0, coordinates: [[121, 25], [121.01, 25.01]] }],
    stats: {
      patternCount: 1, shapeCount: 1, minSideCount: 1, completeIdentityCount: 2,
      duplicateIdentityCount: 0, contradictoryIdentityCount: 0, candidateMultiplicity: 1,
    },
  }],
  rejected: [], rejectionCounts: {},
}
const rawManifest = {
  schemaVersion: 2,
  fetchedAt: '2026-07-22T00:00:00.000Z', cities: ['Taipei'], includeIntercity: false,
  endpoints: [
    { endpointId: 'city-Taipei-shape', scope: 'city', city: 'Taipei', category: 'shape', fileName: 'city-Taipei-shape.json', contentHash: '4'.repeat(64), itemCount: 1, maxUpdateTime: null },
    { endpointId: 'city-Taipei-stop-of-route', scope: 'city', city: 'Taipei', category: 'stop-of-route', fileName: 'city-Taipei-stop-of-route.json', contentHash: '5'.repeat(64), itemCount: 1, maxUpdateTime: null },
  ],
  bundleContentHash: '6'.repeat(64),
}

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), 'shape-measure-report-'))
  roots.push(root)
  return root
}

function fakeLoader({ delayMs = 0, collectorError = null, disposeFailure = false } = {}) {
  return async ({ instrumented, onMeasurement }) => {
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs))
    return {
      sourceSha256: '2'.repeat(64), sourceGitBlobSha1: '3'.repeat(40),
      loaderTimings: { sourceVerificationTimeMs: delayMs, transpileTimeMs: 0, importTimeMs: 0 },
      invoke: () => {
        if (instrumented) emitPair(onMeasurement)
        return structuredClone(result)
      },
      takeCollectorError: () => instrumented ? collectorError : null,
      dispose: vi.fn(async () => {
        if (disposeFailure) throw new Error('raw cleanup fake secret')
      }),
      outputPath: join(process.cwd(), `generated-${instrumented ? 'instrumented' : 'plain'}.mjs`),
    }
  }
}

function emitPair(observe) {
  observe('shape-classified', {
    shapeId: SHAPE_ID, direction: 0, rawCoordinateCount: 2, normalizedCoordinateCount: 2,
    segmentCount: 1, closureClassification: 'not-direction-2', closureGapDistanceMeters: null, accepted: true,
  })
  observe('pair-start', {
    patternId: PATTERN_ID, shapeId: SHAPE_ID, stopCount: 2, rawCoordinateCount: 2,
    normalizedCoordinateCount: 2, segmentCount: 1,
    closureClassification: 'not-direction-2', closureGapDistanceMeters: null,
  })
  for (const orientation of ['forward', 'reverse']) {
    observe('orientation-start', { patternId: PATTERN_ID, shapeId: SHAPE_ID, orientation })
    observe('projection-start', { patternId: PATTERN_ID, shapeId: SHAPE_ID, orientation, objective: 'cost', stopCount: 2, segmentCount: 1, candidateCount: 2 })
    observe('projection-layer', { patternId: PATTERN_ID, shapeId: SHAPE_ID, orientation, objective: 'cost', layer: 0, frontierWidth: 1, retainedNodes: 1, parentNodeCount: 0, pathKeyChars: 4 })
    observe('projection-end', { patternId: PATTERN_ID, shapeId: SHAPE_ID, orientation, objective: 'cost', status: 'success', elapsedMs: 0 })
    observe('orientation-end', { patternId: PATTERN_ID, shapeId: SHAPE_ID, orientation, status: 'success', elapsedMs: 0 })
  }
  observe('pair-end', { patternId: PATTERN_ID, shapeId: SHAPE_ID, status: 'compatible', compatible: true, elapsedMs: 0 })
}

async function makeReport({ instrumented = false, loader = fakeLoader() } = {}) {
  const root = await tempRoot()
  const generatedRunDir = join(root, 'generated-run')
  await mkdir(generatedRunDir)
  return createMeasurementReport({
    candidateBundle,
    rawManifest,
    options: {
      instrumented, expectedMatcherSha256: instrumented ? '2'.repeat(64) : null,
      generatedRunDir, warmup: 0, iterations: 1, topOutliers: 3,
    },
    repositoryMainSha: '1'.repeat(40),
  }, { loadMatcherModule: loader })
}

describe('load once, measure matcher only', () => {
  it('keeps loader delay outside matcher latency and emits no phantom uninstrumented pair rows', async () => {
    const report = await makeReport({ loader: fakeLoader({ delayMs: 50 }) })
    expect(report.metadata.loaderTimings.plain.sourceVerificationTimeMs).toBe(50)
    expect(report.partitions[0].matcherLatencyMs).toBeLessThan(50)
    expect(report.pairs).toEqual([])
    expect(report.metadata.pairMetricsAvailable).toBe(false)
    expect(report.summary.pairLatencyMs).toEqual({
      count: 0, min: null, median: null, p75: null, p90: null, p95: null, p99: null, max: null,
    })
  })

  it('uses the same loaded function for warmup and formal iterations', async () => {
    const invoke = vi.fn(() => structuredClone(result))
    const loader = async () => ({
      sourceSha256: '2'.repeat(64), sourceGitBlobSha1: '3'.repeat(40),
      loaderTimings: { sourceVerificationTimeMs: 0, transpileTimeMs: 0, importTimeMs: 0 },
      invoke, takeCollectorError: () => null, dispose: vi.fn(async () => undefined), outputPath: 'test.mjs',
    })
    const root = await tempRoot()
    await createMeasurementReport({
      candidateBundle, rawManifest,
      options: { instrumented: false, generatedRunDir: root, warmup: 2, iterations: 3, topOutliers: 2 },
      repositoryMainSha: '1'.repeat(40),
    }, { loadMatcherModule: loader })
    expect(invoke).toHaveBeenCalledTimes(5)
  })

  it('compares semantics, then fails clearly when the collector callback failed', async () => {
    await expect(makeReport({
      instrumented: true,
      loader: fakeLoader({ collectorError: { event: 'pair-end' } }),
    })).rejects.toMatchObject({ code: 'MEASUREMENT_COLLECTOR_ERROR' })
  })

  it('preserves collector failure when both matcher module cleanups fail', async () => {
    const error = await makeReport({
      instrumented: true,
      loader: fakeLoader({ collectorError: { event: 'pair-end' }, disposeFailure: true }),
    }).catch((caught) => caught)
    expect(error.code).toBe('MEASUREMENT_COLLECTOR_ERROR')
    expect(error.cleanupFailures).toEqual([
      { stage: 'instrumented-module-dispose', temporaryPath: 'generated-instrumented.mjs' },
      { stage: 'plain-module-dispose', temporaryPath: 'generated-plain.mjs' },
    ])
    const publicText = JSON.stringify(error)
    expect(publicText).not.toContain('fake secret')
    expect(error.cause).toBeUndefined()
  })
})

describe('transactional report publication', () => {
  it('publishes six files plus a completion marker as one immutable run directory', async () => {
    const report = await makeReport()
    const root = await tempRoot()
    const runDir = await publishMeasurementReport(report, root)
    expect((await readdir(runDir)).sort()).toEqual([...REPORT_FILES, 'completion.json'].sort())
    await expect(readPublishedReport(runDir)).resolves.toEqual(report)
    await expect(publishMeasurementReport(report, root)).rejects.toThrow(/already exists/)
  })

  it('keeps instrumented and uninstrumented runs distinct', async () => {
    const root = await tempRoot()
    const plain = await makeReport()
    const instrumented = await makeReport({ instrumented: true })
    const plainDir = await publishMeasurementReport(plain, root)
    const instrumentedDir = await publishMeasurementReport(instrumented, root)
    expect(plainDir).not.toBe(instrumentedDir)
    expect((await readdir(root)).sort()).toEqual([plain.metadata.runId, instrumented.metadata.runId].sort())
  })

  it('removes a temporary directory after a mid-write or validation failure', async () => {
    const report = await makeReport()
    const firstRoot = await tempRoot()
    let writes = 0
    await expect(publishMeasurementReport(report, firstRoot, {
      atomicWriter: async (file, content) => {
        writes += 1
        if (writes === 3) throw new Error('mid-write')
        await atomicWrite(file, content)
      },
    })).rejects.toThrow(/mid-write/)
    expect(await readdir(firstRoot)).toEqual([])

    const secondRoot = await tempRoot()
    await expect(publishMeasurementReport(report, secondRoot, {
      validateDirectory: async () => { throw new Error('validation failure') },
    })).rejects.toThrow(/validation failure/)
    expect(await readdir(secondRoot)).toEqual([])
  })

  it('preserves the primary failure and exposes bounded orphan cleanup data', async () => {
    const report = await makeReport()
    const root = await tempRoot()
    let writes = 0
    const error = await publishMeasurementReport(report, root, {
      atomicWriter: async (file, content) => {
        writes += 1
        if (writes === 2) throw Object.assign(new Error('primary report failure'), { code: 'REPORT_WRITE_FAILED' })
        await atomicWrite(file, content)
      },
      rm: async () => { throw Object.assign(new Error('EACCES raw path'), { code: 'EACCES' }) },
    }).catch((caught) => caught)
    expect(error.code).toBe('REPORT_WRITE_FAILED')
    expect(error.cleanupFailures).toHaveLength(1)
    expect(error.cleanupFailures[0]).toMatchObject({ stage: 'report-temporary-cleanup' })
    expect(error.cleanupFailures[0].temporaryPath).toMatch(/^\./)
    expect(JSON.stringify(error)).not.toContain('EACCES raw path')
    expect((await readdir(root)).some((name) => name.startsWith('.'))).toBe(true)
    expect((await readdir(root)).some((name) => name === report.metadata.runId)).toBe(false)
  })

  it('fails closed on EXDEV rather than copying a report', async () => {
    const report = await makeReport()
    const root = await tempRoot()
    const error = await publishMeasurementReport(report, root, {
      rename: async () => { throw Object.assign(new Error('cross-device'), { code: 'EXDEV' }) },
    }).catch((caught) => caught)
    expect(error.code).toBe('EXDEV')
    expect(await readdir(root)).toEqual([])
  })

  it('rejects stale or corrupted runs instead of mixing them with new output', async () => {
    const report = await makeReport()
    const root = await tempRoot()
    const stale = join(root, 'stale-run')
    await mkdir(stale)
    for (const file of REPORT_FILES) await writeFile(join(stale, file), '{}\n')
    await expect(validatePublishedDirectory(stale)).rejects.toThrow()

    const runDir = await publishMeasurementReport(report, root)
    await rm(join(runDir, 'completion.json'))
    await expect(readPublishedReport(runDir)).rejects.toThrow()
  })
})
