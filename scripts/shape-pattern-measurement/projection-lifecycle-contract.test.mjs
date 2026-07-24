import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { MATCHER_SOURCE } from './constants.mjs'
import { loadMatcherModule } from './instrument-loader.mjs'

const roots = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

async function sha256() { return createHash('sha256').update(await readFile(MATCHER_SOURCE)).digest('hex') }
async function generatedRoot() { const root = await mkdtemp(join(tmpdir(), 'projection-lifecycle-')); roots.push(root); return root }

const shape = { shapeId: 's1', routeUid: 'R1', direction: 0, coordinates: [[121, 25], [121.01, 25.01]] }
const pattern = (stops) => ({ patternId: 'p1', routeUid: 'R1', direction: 0, stops })
const projectionOptions = (objective = 'cost') => ({
  objective,
  maxSpanMeters: null,
  maxMeanStopDistanceMeters: 250,
  maxStopDistanceMeters: 1_000,
})

async function eventsFor(patterns, shapes = [shape]) {
  const events = []
  const loaded = await loadMatcherModule({ instrumented: true, expectedMatcherSha256: await sha256(), generatedRunDir: await generatedRoot(), onMeasurement: (event, payload) => events.push({ event, payload }) })
  try { loaded.invoke(patterns, shapes) } finally { await loaded.dispose() }
  return events
}

async function probeEvents({ stops, coordinates = shape.coordinates, objective = 'cost', injectThrow = false }) {
  const events = []
  const loaded = await loadMatcherModule({ instrumented: true, expectedMatcherSha256: await sha256(), generatedRunDir: await generatedRoot(), onMeasurement: (event, payload) => events.push({ event, payload }) })
  let thrown = null
  try {
    loaded.invokeProjectionProbe(stops, coordinates, projectionOptions(objective), { injectThrow })
  } catch (error) {
    thrown = error
  } finally {
    await loaded.dispose()
  }
  return { events, thrown }
}

function projectionStatuses(events) { return events.filter((entry) => entry.event === 'projection-end').map((entry) => entry.payload.status) }

function expectBalancedLifecycle(events) {
  const projectionStarts = events.filter((entry) => entry.event === 'projection-start')
  const projectionEnds = events.filter((entry) => entry.event === 'projection-end')
  const orientationStarts = events.filter((entry) => entry.event === 'orientation-start')
  const orientationEnds = events.filter((entry) => entry.event === 'orientation-end')
  expect(projectionStarts).toHaveLength(projectionEnds.length)
  expect(orientationStarts).toHaveLength(orientationEnds.length)
  expect([...projectionEnds, ...orientationEnds].every((entry) =>
    Number.isFinite(entry.payload.elapsedMs) && entry.payload.elapsedMs >= 0)).toBe(true)
}

describe('projection and orientation lifecycle', () => {
  it('emits exact no-path for an initial state with no stops', async () => {
    const { events, thrown } = await probeEvents({ stops: [] })
    expect(thrown).toBeNull()
    expect(projectionStatuses(events)).toEqual(['no-path'])
    expect(events.filter((entry) => entry.event === 'orientation-end').map((entry) => entry.payload.status)).toEqual(['no-path'])
    expectBalancedLifecycle(events)
  })

  it('emits exact threshold-rejected status for final distance rejection', async () => {
    const events = await eventsFor([pattern([{ coordinate: [130, 35] }, { coordinate: [130.1, 35.1] }])])
    expect(projectionStatuses(events)).toEqual(['threshold-rejected', 'threshold-rejected'])
    expectBalancedLifecycle(events)
  })

  it('emits directional success/frontier outcomes with reconciled orientation events', async () => {
    const events = await eventsFor([pattern([{ coordinate: [121, 25] }, { coordinate: [121.01, 25.01] }])])
    const projectionEnds = events.filter((entry) => entry.event === 'projection-end')
    expect(projectionEnds.map((entry) => [entry.payload.orientation, entry.payload.status])).toEqual([
      ['forward', 'success'],
      ['reverse', 'frontier-empty'],
    ])
    const orientationStarts = events.filter((entry) => entry.event === 'orientation-start')
    const orientationEnds = events.filter((entry) => entry.event === 'orientation-end')
    expect(orientationStarts.map((entry) => entry.payload.orientation).sort()).toEqual(['forward', 'reverse'])
    expect(orientationEnds.map((entry) => entry.payload.orientation).sort()).toEqual(['forward', 'reverse'])
    expectBalancedLifecycle(events)
  })

  it('classifies a middle-layer frontier exhaustion as frontier-empty', async () => {
    const events = await eventsFor([pattern([
      { coordinate: [121.01, 25.01] },
      { coordinate: [121, 25] },
      { coordinate: [121.01, 25.01] },
    ])])
    expect(projectionStatuses(events)).toEqual(['frontier-empty', 'frontier-empty'])
    expectBalancedLifecycle(events)
  })

  it.each(['cost', 'span'])('emits a complete successful %s-objective probe lifecycle', async (objective) => {
    const { events, thrown } = await probeEvents({
      stops: [{ coordinate: [121, 25] }, { coordinate: [121.01, 25.01] }],
      objective,
    })
    expect(thrown).toBeNull()
    expect(events.filter((entry) => entry.event === 'projection-end').map((entry) => [entry.payload.objective, entry.payload.status])).toEqual([[objective, 'success']])
    expectBalancedLifecycle(events)
  })

  it('emits throw end events for an injected projection failure', async () => {
    const { events, thrown } = await probeEvents({
      stops: [{ coordinate: [121, 25] }, { coordinate: [121.01, 25.01] }],
      injectThrow: true,
    })
    expect(thrown).toBeInstanceOf(Error)
    expect(projectionStatuses(events)).toEqual(['throw'])
    expect(events.filter((entry) => entry.event === 'orientation-end').map((entry) => entry.payload.status)).toEqual(['throw'])
    expectBalancedLifecycle(events)
  })
})
