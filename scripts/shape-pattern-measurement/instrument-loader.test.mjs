import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MATCHER_SOURCE, SUPPORTED_MATCHER_GIT_BLOB_SHA1 } from './constants.mjs'
import { executeMatcher, instrumentSource, loadMatcherModule } from './instrument-loader.mjs'
import { gitBlobSha1 } from './util.mjs'

const roots = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function generatedRoot() {
  const root = await mkdtemp(join(tmpdir(), 'shape-measure-instrument-'))
  roots.push(root)
  await writeFile(join(root, 'sentinel.txt'), 'keep')
  return root
}
async function sourceSha256() {
  return createHash('sha256').update(await readFile(MATCHER_SOURCE)).digest('hex')
}

const patterns = [{
  patternId: 'p1', routeUid: 'R1', subRouteUid: 'SR1', direction: 0,
  stops: [{ stopUid: 'A', coordinate: [121, 25] }, { stopUid: 'B', coordinate: [121.01, 25.01] }],
}]
const shapes = [{
  shapeId: 's1', routeUid: 'R1', subRouteUid: 'SR1', direction: 0,
  coordinates: [[121, 25], [121.01, 25.01]],
}]

describe('temporary matcher observer instrumentation', () => {
  it('pins the production matcher blob and requires exact source and anchors', async () => {
    const source = await readFile(MATCHER_SOURCE, 'utf8')
    expect(gitBlobSha1(source)).toBe(SUPPORTED_MATCHER_GIT_BLOB_SHA1)
    expect(() => instrumentSource(source)).not.toThrow()
    const broken = source.replace(
      '      const geometry = scoreGeometry(pattern, shape, options)',
      '      const geometry = scoreCandidateGeometry(pattern, shape, options)',
    )
    expect(() => instrumentSource(broken)).toThrow(/anchor mismatch/)
  })

  it('loads once, invokes repeatedly, and removes only its own generated module on dispose', async () => {
    const root = await generatedRoot()
    const loaded = await loadMatcherModule({
      instrumented: false, matcherSourcePath: MATCHER_SOURCE, generatedRunDir: root,
    })
    expect((await readdir(root)).filter((name) => name.endsWith('.mjs'))).toHaveLength(1)
    expect(loaded.invoke(patterns, shapes)).toEqual(loaded.invoke(patterns, shapes))
    await loaded.dispose()
    expect(await readdir(root)).toEqual(['sentinel.txt'])
  })

  it('emits reconciled pair, projection, orientation, shape, and assignment events without changing results', async () => {
    const root = await generatedRoot()
    const events = []
    const plain = await loadMatcherModule({ instrumented: false, generatedRunDir: root })
    const instrumented = await loadMatcherModule({
      instrumented: true,
      expectedMatcherSha256: await sourceSha256(),
      generatedRunDir: root,
      onMeasurement: (event, payload) => events.push({ event, payload }),
    })
    try {
      const expected = plain.invoke(patterns, shapes)
      const actual = instrumented.invoke(patterns, shapes)
      expect(actual).toEqual(expected)
      expect(events.map((entry) => entry.event)).toContain('shape-classified')
      expect(events.map((entry) => entry.event)).toContain('pair-start')
      expect(events.map((entry) => entry.event)).toContain('pair-end')
      const orientationStarts = events.filter((entry) => entry.event === 'orientation-start')
      const orientationEnds = events.filter((entry) => entry.event === 'orientation-end')
      expect(orientationStarts.map((entry) => entry.payload.orientation).sort()).toEqual(['forward', 'reverse'])
      expect(orientationEnds.map((entry) => entry.payload.orientation).sort()).toEqual(['forward', 'reverse'])
      const projectionStarts = events.filter((entry) => entry.event === 'projection-start')
      const projectionEnds = events.filter((entry) => entry.event === 'projection-end')
      expect(projectionStarts).toHaveLength(2)
      expect(projectionEnds).toHaveLength(2)
      expect(projectionEnds.map((entry) => [entry.payload.orientation, entry.payload.status])).toEqual([
        ['forward', 'success'],
        ['reverse', 'frontier-empty'],
      ])
      for (const entry of projectionEnds) {
        expect(entry.payload).toMatchObject({ patternId: 'p1', shapeId: 's1', objective: 'cost' })
        expect(['forward', 'reverse']).toContain(entry.payload.orientation)
        expect(Number.isFinite(entry.payload.elapsedMs)).toBe(true)
        expect(entry.payload.elapsedMs).toBeGreaterThanOrEqual(0)
      }
    } finally {
      await instrumented.dispose()
      await plain.dispose()
    }
    expect(await readdir(root)).toEqual(['sentinel.txt'])
  })

  it('emits exact threshold-rejected outcomes for final distance rejection', async () => {
    const root = await generatedRoot()
    const events = []
    const loaded = await loadMatcherModule({
      instrumented: true,
      expectedMatcherSha256: await sourceSha256(),
      generatedRunDir: root,
      onMeasurement: (event, payload) => events.push({ event, payload }),
    })
    try {
      const farPatterns = [{ ...patterns[0], stops: [
        { stopUid: 'A', coordinate: [130, 35] }, { stopUid: 'B', coordinate: [130.1, 35.1] },
      ] }]
      loaded.invoke(farPatterns, shapes)
      const endings = events.filter((entry) => entry.event === 'projection-end')
      expect(endings).toHaveLength(2)
      expect(endings.map((entry) => entry.payload.status)).toEqual(['threshold-rejected', 'threshold-rejected'])
      expect(endings.every((entry) => Number.isFinite(entry.payload.elapsedMs) && entry.payload.elapsedMs >= 0)).toBe(true)
    } finally {
      await loaded.dispose()
    }
  })

  it('contains callback failure, redacts raw callback data, completes semantics, and cleans output', async () => {
    const root = await generatedRoot()
    const callback = vi.fn(() => {
      const error = new Error('callback fake secret token p1 s1')
      error.stack = 'raw callback stack route-R1'
      throw error
    })
    const error = await executeMatcher({
      instrumented: true,
      expectedMatcherSha256: await sourceSha256(),
      generatedRunDir: root,
      patterns,
      shapes,
      onMeasurement: callback,
    }).catch((caught) => caught)
    expect(error).toMatchObject({ code: 'MEASUREMENT_COLLECTOR_ERROR', stage: 'observer-callback' })
    expect(callback).toHaveBeenCalled()
    expect(error.cause).toBeUndefined()
    const publicText = JSON.stringify(error)
    for (const forbidden of ['fake secret', 'route-R1', 'callback fake', ' p1 ', ' s1 ']) {
      expect(publicText).not.toContain(forbidden)
    }
    expect(await readdir(root)).toEqual(['sentinel.txt'])
  })

  it('fails closed on source SHA mismatch without leaving generated files', async () => {
    const root = await generatedRoot()
    await expect(loadMatcherModule({
      instrumented: true,
      expectedMatcherSha256: '0'.repeat(64),
      generatedRunDir: root,
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_MATCHER_REVISION' })
    expect(await readdir(root)).toEqual(['sentinel.txt'])
  })
})
