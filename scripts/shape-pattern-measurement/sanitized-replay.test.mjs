import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildCandidatePartitions } from './build-candidates.mjs'
import { MATCHER_SOURCE } from './constants.mjs'
import { createMeasurementReport } from './report.mjs'
import { validateReport } from './report-schema.mjs'
import { cleanupOwnedGeneratedChild, createOwnedGeneratedChild } from './run.mjs'
import {
  createRawCacheEntry, createRawCacheManifest, expectedEndpointSpecs, replayRawBundle,
} from './tdx-source.mjs'
import { sha256Hex, stableStringify } from './util.mjs'

const roots = []
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function materializeVerifiedRawCache(root, fixture) {
  const rawDir = join(root, 'raw')
  await mkdir(rawDir)
  const source = fixture.sources[0]
  const responses = []
  for (const spec of expectedEndpointSpecs(['Taipei'], false)) {
    const payload = spec.category === 'shape' ? source.shapes : source.stopOfRoute
    const entry = createRawCacheEntry(spec, payload)
    await writeFile(join(rawDir, entry.fileName), `${stableStringify(payload, 2)}\n`)
    responses.push({ ...entry, payload })
  }
  const manifest = createRawCacheManifest({
    cities: ['Taipei'],
    includeIntercity: false,
    fetchedAt: fixture.fetchedAt,
    responses,
  })
  await writeFile(join(rawDir, 'manifest.json'), `${stableStringify(manifest, 2)}\n`)
  return { rawDir, manifest }
}

async function makeReport({
  candidateBundle,
  manifest,
  generatedRoot,
  rawDir,
  reportDir,
  instrumented,
  matcherSha256,
}) {
  const ownership = await createOwnedGeneratedChild(generatedRoot)
  try {
    return await createMeasurementReport({
      candidateBundle,
      rawManifest: manifest,
      options: {
        instrumented,
        expectedMatcherSha256: instrumented ? matcherSha256 : null,
        generatedRunDir: ownership.child,
        warmup: 0,
        iterations: 1,
        topOutliers: 5,
      },
      repositoryMainSha: '1'.repeat(40),
    })
  } finally {
    await cleanupOwnedGeneratedChild(ownership, { rawDir, reportDir })
  }
}

describe('sanitized verified raw replay', () => {
  it('executes both report modes from the same formally verified raw cache', async () => {
    const fixture = JSON.parse(await readFile(
      'scripts/shape-pattern-measurement/fixtures/sanitized-raw-bundle.json',
      'utf8',
    ))
    const root = await mkdtemp(join(tmpdir(), 'shape-measure-sanitized-replay-'))
    roots.push(root)
    const generatedRoot = join(root, 'generated')
    const reportDir = join(root, 'reports')
    await Promise.all([mkdir(generatedRoot), mkdir(reportDir)])
    const { rawDir, manifest: writtenManifest } = await materializeVerifiedRawCache(root, fixture)

    const network = vi.fn(() => { throw new Error('sanitized replay attempted network access') })
    vi.stubGlobal('fetch', network)
    const replay = vi.fn(replayRawBundle)
    const verified = await replay({ rawDir })

    expect(replay).toHaveBeenCalledOnce()
    expect(network).not.toHaveBeenCalled()
    expect(verified.manifest).toEqual(writtenManifest)
    expect(verified.manifest.bundleContentHash).toBe(writtenManifest.bundleContentHash)
    expect(verified.manifest.endpoints.map((entry) => entry.endpointId).sort()).toEqual([
      'city-Taipei-shape',
      'city-Taipei-stop-of-route',
    ])

    const candidateBundle = buildCandidatePartitions(verified.bundle)
    expect(candidateBundle.rejected).toEqual([])
    expect(new Set(candidateBundle.partitions.map((partition) => partition.direction))).toEqual(new Set([0, 2]))

    const matcherSha256 = sha256Hex(await readFile(MATCHER_SOURCE))
    const shared = {
      candidateBundle,
      manifest: verified.manifest,
      generatedRoot,
      rawDir,
      reportDir,
      matcherSha256,
    }
    const plain = await makeReport({ ...shared, instrumented: false })
    const instrumented = await makeReport({ ...shared, instrumented: true })

    expect(() => validateReport(plain)).not.toThrow()
    expect(() => validateReport(instrumented)).not.toThrow()
    expect(plain.metadata.mode).toBe('uninstrumented')
    expect(plain.metadata.pairMetricsAvailable).toBe(false)
    expect(plain.pairs).toEqual([])
    expect(instrumented.metadata.mode).toBe('instrumented')
    expect(instrumented.metadata.pairMetricsAvailable).toBe(true)
    expect(instrumented.pairs.length).toBeGreaterThan(0)
    expect(instrumented.pairs.some((pair) => pair.projectionOutcomes.length > 0)).toBe(true)

    // The sanitized fixture has one exact Shape for each pattern. It exercises
    // projection scoring and both Direction 0/2 paths, but not assignment ambiguity.
    expect(instrumented.partitions.every((partition) => partition.assignmentBestSolveCount === 0)).toBe(true)
    expect(instrumented.partitions.every((partition) => partition.forcedMatchSolveCount === 0)).toBe(true)
    expect(instrumented.partitions.every((partition) => partition.forcedUnmatchedSolveCount === 0)).toBe(true)

    expect(instrumented.outcomes.exactIdentity + instrumented.outcomes.geometry).toBeGreaterThan(0)
    expect(instrumented.metadata.matcherSourceSha256).toBe(plain.metadata.matcherSourceSha256)
    expect(instrumented.metadata.matcherSourceGitBlobSha1).toBe(plain.metadata.matcherSourceGitBlobSha1)
    expect(instrumented.metadata.provenance.bundleContentHash).toBe(plain.metadata.provenance.bundleContentHash)

    expect(await readdir(generatedRoot)).toEqual([])
    expect(await readdir(reportDir)).toEqual([])
    await expect(access(join(rawDir, 'manifest.json'))).resolves.toBeUndefined()
    await expect(access(join(rawDir, 'city-Taipei-shape.json'))).resolves.toBeUndefined()
    await expect(access(join(rawDir, 'city-Taipei-stop-of-route.json'))).resolves.toBeUndefined()
  })
})
