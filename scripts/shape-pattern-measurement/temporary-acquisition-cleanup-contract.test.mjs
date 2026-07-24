import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMeasurementReport, publishMeasurementReport } from './report.mjs'
import { createOwnedGeneratedChild } from './run.mjs'

const roots = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function tempRoot(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

const patternId = 'city-Taipei:pattern:p1'
const shapeId = 'city-Taipei:shape:s1'
const matcherResult = {
  matches: [{ patternId, shapeId, basis: 'exact-identity', costMeters: null, metrics: null }],
  unresolved: [], rejectedShapes: [], unusedShapeIds: [],
}
const candidateBundle = {
  partitions: [{
    partitionId: 'a'.repeat(24), key: 'city\u0000Taipei\u0000R1\u00000',
    sourceScope: 'city', city: 'Taipei', routeUid: 'R1', direction: 0,
    patterns: [{
      patternId, routeUid: 'R1', subRouteUid: 'SR1', direction: 0,
      stops: [
        { stopUid: 'A', coordinate: [121, 25] },
        { stopUid: 'B', coordinate: [121.01, 25.01] },
      ],
    }],
    shapes: [{
      shapeId, routeUid: 'R1', subRouteUid: 'SR1', direction: 0,
      coordinates: [[121, 25], [121.01, 25.01]],
    }],
    stats: {
      patternCount: 1, shapeCount: 1, minSideCount: 1, completeIdentityCount: 2,
      duplicateIdentityCount: 0, contradictoryIdentityCount: 0, candidateMultiplicity: 1,
    },
  }],
  rejected: [], rejectionCounts: {},
}
const rawManifest = {
  schemaVersion: 2,
  fetchedAt: '2026-07-24T00:00:00.000Z',
  cities: ['Taipei'],
  includeIntercity: false,
  endpoints: [
    {
      endpointId: 'city-Taipei-shape', scope: 'city', city: 'Taipei', category: 'shape',
      fileName: 'city-Taipei-shape.json', contentHash: '4'.repeat(64), itemCount: 1, maxUpdateTime: null,
    },
    {
      endpointId: 'city-Taipei-stop-of-route', scope: 'city', city: 'Taipei', category: 'stop-of-route',
      fileName: 'city-Taipei-stop-of-route.json', contentHash: '5'.repeat(64), itemCount: 1, maxUpdateTime: null,
    },
  ],
  bundleContentHash: '6'.repeat(64),
}

async function validReport() {
  const root = await tempRoot('temporary-acquisition-report-')
  const generatedRunDir = join(root, 'generated')
  await mkdir(generatedRunDir)
  return createMeasurementReport({
    candidateBundle,
    rawManifest,
    options: {
      instrumented: false,
      expectedMatcherSha256: null,
      generatedRunDir,
      warmup: 0,
      iterations: 1,
      topOutliers: 1,
    },
    repositoryMainSha: '1'.repeat(40),
  }, {
    loadMatcherModule: async () => ({
      sourceSha256: '2'.repeat(64),
      sourceGitBlobSha1: '3'.repeat(40),
      loaderTimings: { sourceVerificationTimeMs: 0, transpileTimeMs: 0, importTimeMs: 0 },
      invoke: () => structuredClone(matcherResult),
      takeCollectorError: () => null,
      dispose: vi.fn(async () => undefined),
      outputPath: join(generatedRunDir, 'plain.mjs'),
    }),
  })
}

describe('temporary resource acquisition cleanup', () => {
  it('removes a generated child when ownership marker creation fails', async () => {
    const root = await tempRoot('temporary-acquisition-generated-')
    const generatedRoot = join(root, 'generated')
    const error = await createOwnedGeneratedChild(generatedRoot, {
      writeMarker: async () => {
        throw Object.assign(new Error('marker write failed'), { code: 'MARKER_WRITE_FAILED' })
      },
    }).catch((caught) => caught)

    expect(error.code).toBe('MARKER_WRITE_FAILED')
    expect(await readdir(generatedRoot)).toEqual([])
  })

  it('preserves marker creation failure when generated-child cleanup also fails', async () => {
    const root = await tempRoot('temporary-acquisition-generated-failure-')
    const generatedRoot = join(root, 'generated')
    const error = await createOwnedGeneratedChild(generatedRoot, {
      writeMarker: async () => {
        throw Object.assign(new Error('marker write failed'), { code: 'MARKER_WRITE_FAILED' })
      },
      removeDirectory: async () => { throw new Error('raw cleanup detail') },
    }).catch((caught) => caught)

    expect(error.code).toBe('MARKER_WRITE_FAILED')
    expect(error.cleanupFailures).toEqual([{
      stage: 'generated-run-initialization-cleanup',
      temporaryPath: expect.stringMatching(/^run-/),
    }])
    expect(JSON.stringify(error)).not.toContain('raw cleanup detail')
  })

  it('removes report staging when canonicalization fails after mkdtemp', async () => {
    const report = await validReport()
    const root = await tempRoot('temporary-acquisition-publication-')
    const error = await publishMeasurementReport(report, root, {
      realpath: async () => {
        throw Object.assign(new Error('realpath failed'), { code: 'REALPATH_FAILED' })
      },
    }).catch((caught) => caught)

    expect(error.code).toBe('REALPATH_FAILED')
    expect(await readdir(root)).toEqual([])
  })

  it('preserves canonicalization failure when report-staging cleanup also fails', async () => {
    const report = await validReport()
    const root = await tempRoot('temporary-acquisition-publication-failure-')
    const error = await publishMeasurementReport(report, root, {
      realpath: async () => {
        throw Object.assign(new Error('realpath failed'), { code: 'REALPATH_FAILED' })
      },
      rm: async () => { throw new Error('raw cleanup detail') },
    }).catch((caught) => caught)

    expect(error.code).toBe('REALPATH_FAILED')
    expect(error.cleanupFailures).toEqual([{
      stage: 'report-temporary-cleanup',
      temporaryPath: expect.stringMatching(/^\./),
    }])
    expect(JSON.stringify(error)).not.toContain('raw cleanup detail')
    expect((await readdir(root)).some((name) => name.startsWith('.'))).toBe(true)
  })
})
