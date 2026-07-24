import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanupOwnedGeneratedChild, createOwnedGeneratedChild, runMeasurement } from './run.mjs'

const roots = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function makeWorkspace() {
  const root = await mkdtemp(join(tmpdir(), 'shape-measure-run-'))
  roots.push(root)
  const generatedRoot = join(root, 'generated')
  const rawDir = join(root, 'raw')
  const reportDir = join(root, 'reports')
  await Promise.all([mkdir(generatedRoot), mkdir(rawDir), mkdir(reportDir)])
  await writeFile(join(generatedRoot, 'unrelated-sentinel.txt'), 'keep')
  await writeFile(join(rawDir, 'raw-sentinel.txt'), 'keep')
  await writeFile(join(reportDir, 'report-sentinel.txt'), 'keep')
  return { root, generatedRoot, rawDir, reportDir }
}

const source = {
  bundle: {
    schemaVersion: 2,
    fetchedAt: '2026-07-22T00:00:00.000Z',
    sources: [{
      scope: 'city', city: 'Taipei',
      stopOfRoute: [{
        RouteUID: 'R1', SubRouteUID: 'SR1', Direction: 0,
        Stops: [
          { StopUID: 'A', StopSequence: 1, StopPosition: { PositionLon: 121, PositionLat: 25 } },
          { StopUID: 'B', StopSequence: 2, StopPosition: { PositionLon: 121.01, PositionLat: 25.01 } },
        ],
      }],
      shapes: [{
        RouteUID: 'R1', SubRouteUID: 'SR1', Direction: 0,
        Coordinates: [[121, 25], [121.01, 25.01]],
      }],
    }],
  },
  manifest: {
    schemaVersion: 2, fetchedAt: '2026-07-22T00:00:00.000Z', cities: ['Taipei'], includeIntercity: false,
    endpoints: [], bundleContentHash: '6'.repeat(64),
  },
}

function options(workspace) {
  return {
    replay: true, cities: ['Taipei'], citiesExplicit: false,
    includeIntercity: false, includeIntercityExplicit: false,
    rawDir: workspace.rawDir, reportDir: workspace.reportDir,
    generatedRoot: workspace.generatedRoot,
    fetchConcurrency: 1, warmup: 0, iterations: 1, topOutliers: 1,
    instrumented: false, expectedMatcherSha256: null,
  }
}

async function expectPersistentSentinels(workspace) {
  expect(await readFile(join(workspace.generatedRoot, 'unrelated-sentinel.txt'), 'utf8')).toBe('keep')
  expect(await readFile(join(workspace.rawDir, 'raw-sentinel.txt'), 'utf8')).toBe('keep')
  expect(await readFile(join(workspace.reportDir, 'report-sentinel.txt'), 'utf8')).toBe('keep')
  expect((await readdir(workspace.generatedRoot)).filter((name) => name.startsWith('run-'))).toEqual([])
}

describe('per-run generated cleanup ownership', () => {
  it('deletes only the child created by this run', async () => {
    const workspace = await makeWorkspace()
    const ownership = await createOwnedGeneratedChild(workspace.generatedRoot)
    await writeFile(join(ownership.child, 'generated.mjs'), 'temporary')
    await cleanupOwnedGeneratedChild(ownership, workspace)
    await expectPersistentSentinels(workspace)
  })

  it('fails closed if the ownership marker was changed', async () => {
    const workspace = await makeWorkspace()
    const ownership = await createOwnedGeneratedChild(workspace.generatedRoot)
    await writeFile(ownership.marker, 'forged\n')
    await expect(cleanupOwnedGeneratedChild(ownership, workspace)).rejects.toThrow(/ownership marker/)
    expect(await readdir(ownership.child)).toContain('.measurement-run-owner')
  })

  it.each(['matcher', 'collector', 'report'])('cleans its child after %s failure without deleting raw, reports, or unrelated files', async (failureClass) => {
    const workspace = await makeWorkspace()
    const publish = vi.fn(async () => { throw new Error('report failure') })
    const create = vi.fn(async () => {
      if (failureClass === 'report') return { metadata: { runId: 'fake' } }
      const error = new Error(`${failureClass} failure`)
      if (failureClass === 'collector') error.code = 'MEASUREMENT_COLLECTOR_ERROR'
      throw error
    })
    await expect(runMeasurement(options(workspace), {
      replayRawBundle: async () => source,
      createMeasurementReport: create,
      publishMeasurementReport: publish,
      repositoryMainSha: '1'.repeat(40),
    })).rejects.toThrow(new RegExp(failureClass))
    if (failureClass !== 'report') expect(publish).not.toHaveBeenCalled()
    await expectPersistentSentinels(workspace)
  })

  it('also cleans the child after a successful run', async () => {
    const workspace = await makeWorkspace()
    const result = await runMeasurement(options(workspace), {
      replayRawBundle: async () => source,
      createMeasurementReport: async () => ({ metadata: { runId: 'fake' } }),
      publishMeasurementReport: async () => join(workspace.reportDir, 'fake'),
      repositoryMainSha: '1'.repeat(40),
    })
    expect(result.runDir).toBe(join(workspace.reportDir, 'fake'))
    await expectPersistentSentinels(workspace)
  })
})
