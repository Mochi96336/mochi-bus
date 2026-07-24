import { describe, expect, it } from 'vitest'
import { buildCandidatePartitions, extractShapeCoordinates } from './build-candidates.mjs'

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

const stop = (sequence, lon, lat, uid = `S${sequence}`) => ({
  StopUID: uid,
  StopSequence: sequence,
  StopPosition: { PositionLon: lon, PositionLat: lat },
})
const pattern = (overrides = {}) => ({
  RouteUID: 'R1', SubRouteUID: 'SR1', Direction: 0,
  Stops: [stop(1, 121, 25), stop(2, 121.01, 25.01)],
  ...overrides,
})
const shape = (overrides = {}) => ({
  RouteUID: 'R1', SubRouteUID: 'SR1', Direction: 0,
  Coordinates: [[121, 25], [121.01, 25.01]],
  ...overrides,
})
const bundle = (stopOfRoute = [pattern()], shapes = [shape()]) => ({
  sources: [{ scope: 'city', city: 'Taipei', stopOfRoute, shapes }],
})

function rejectionReasons(result, kind) {
  return result.rejected.filter((entry) => entry.kind === kind).map((entry) => entry.reason)
}
function allPatterns(result) { return result.partitions.flatMap((entry) => entry.patterns) }

describe('strict raw TDX candidate boundary', () => {
  it.each([null, undefined, '', '0', '1', '2', false, true, NaN, Infinity, -1, 3, 0.5])(
    'rejects non-contract Direction %s',
    (Direction) => {
      const result = buildCandidatePartitions(bundle([pattern({ Direction })], [shape({ Direction })]))
      expect(result.partitions).toEqual([])
      expect(rejectionReasons(result, 'pattern')).toEqual(['unsupported-direction'])
      expect(rejectionReasons(result, 'shape')).toEqual(['unsupported-direction'])
    },
  )

  it.each([
    [null, 25], ['', 25], ['121', 25], [undefined, 25], [NaN, 25], [Infinity, 25], [181, 25],
    [121, null], [121, '25'], [121, undefined], [121, NaN], [121, Infinity], [121, 91],
  ])('rejects malformed raw coordinates without dropping only the bad point', (longitude, latitude) => {
    const result = buildCandidatePartitions(bundle(
      [pattern({ Stops: [stop(1, longitude, latitude), stop(2, 121.01, 25.01)] })],
      [shape({ Coordinates: [[121, 25], [longitude, latitude], [121.01, 25.01]] })],
    ))
    expect(result.partitions).toEqual([])
    expect(rejectionReasons(result, 'pattern')).toEqual(['invalid-stop-coordinate'])
    expect(rejectionReasons(result, 'shape')).toEqual(['invalid-coordinates'])
  })

  it('preserves a genuine numeric [0,0] coordinate only when both raw values are numbers', () => {
    const accepted = buildCandidatePartitions(bundle(
      [pattern({ Stops: [stop(1, 0, 0), stop(2, 1, 1)] })],
      [shape({ Coordinates: [[0, 0], [1, 1]] })],
    ))
    expect(accepted.partitions[0].patterns[0].stops[0].coordinate).toEqual([0, 0])
    expect(accepted.partitions[0].shapes[0].coordinates[0]).toEqual([0, 0])
    const rejected = buildCandidatePartitions(bundle(
      [pattern({ Stops: [stop(1, '', null), stop(2, 1, 1)] })],
      [shape({ Coordinates: [['', null], [1, 1]] })],
    ))
    expect(rejected.partitions).toEqual([])
  })

  it('uses a numeric stable StopSequence order instead of array or lexical order', () => {
    const input = pattern({ Stops: [stop(10, 10, 10), stop(2, 2, 2), stop(1, 1, 1)] })
    const result = buildCandidatePartitions(bundle([input]))
    expect(result.partitions[0].patterns[0].stops.map((entry) => entry.coordinate[0])).toEqual([1, 2, 10])
  })

  it.each([
    [[stop(1, 1, 1), stop(1, 2, 2)], 'duplicate-stop-sequence'],
    [[{ ...stop(1, 1, 1), StopSequence: undefined }, stop(2, 2, 2)], 'invalid-stop-sequence'],
    [[{ ...stop(1, 1, 1), StopSequence: '1' }, stop(2, 2, 2)], 'invalid-stop-sequence'],
    [[{ ...stop(1, 1, 1), StopSequence: 1.5 }, stop(2, 2, 2)], 'invalid-stop-sequence'],
    [[{ ...stop(1, 1, 1), StopSequence: 0 }, stop(2, 2, 2)], 'non-positive-stop-sequence'],
    [[{ ...stop(1, 1, 1), StopSequence: -1 }, stop(2, 2, 2)], 'non-positive-stop-sequence'],
  ])('fails closed when StopSequence cannot form a trusted total order', (Stops, reason) => {
    const result = buildCandidatePartitions(bundle([pattern({ Stops })]))
    expect(allPatterns(result)).toEqual([])
    expect(result.partitions.flatMap((entry) => entry.shapes)).toHaveLength(1)
    expect(rejectionReasons(result, 'pattern')).toEqual([reason])
    expect(result.rejectionCounts[`pattern:${reason}`]).toBe(1)
  })

  it('is deterministic across source/record/stop permutations and does not mutate frozen input', () => {
    const duplicatePattern = pattern({ Stops: [stop(2, 2, 2), stop(1, 1, 1)] })
    const secondPattern = pattern({ SubRouteUID: 'SR2', Stops: [stop(2, 4, 4), stop(1, 3, 3)] })
    const firstBundle = deepFreeze({
      sources: [{ scope: 'city', city: 'Taipei', stopOfRoute: [duplicatePattern, secondPattern, duplicatePattern], shapes: [shape(), shape(), shape({ SubRouteUID: 'SR2' })] }],
    })
    const secondBundle = deepFreeze({
      sources: [{ scope: 'city', city: 'Taipei', stopOfRoute: [secondPattern, duplicatePattern, duplicatePattern], shapes: [shape({ SubRouteUID: 'SR2' }), shape(), shape()] }],
    })
    expect(buildCandidatePartitions(firstBundle)).toEqual(buildCandidatePartitions(secondBundle))
    expect(buildCandidatePartitions(firstBundle).partitions[0].patterns).toHaveLength(3)
  })

  it('treats missing, null, empty, and valid identities as distinct contract states', () => {
    for (const RouteUID of [undefined, null, '']) {
      const item = pattern({ RouteUID })
      if (RouteUID === undefined) delete item.RouteUID
      const result = buildCandidatePartitions(bundle([item]))
      expect(allPatterns(result)).toEqual([])
      expect(rejectionReasons(result, 'pattern')).toHaveLength(1)
    }
    expect(buildCandidatePartitions(bundle([pattern({ SubRouteUID: null })])).partitions[0].patterns).toHaveLength(1)
    const empty = buildCandidatePartitions(bundle([pattern({ SubRouteUID: '' })]))
    expect(allPatterns(empty)).toEqual([])
    expect(rejectionReasons(empty, 'pattern')).toEqual(['empty-sub-route-uid'])
  })

  it('rejects the whole direct Shape when any point is invalid', () => {
    expect(extractShapeCoordinates(shape({ Coordinates: [[121, 25], [null, null], [121.1, 25.1]] }))).toEqual({
      coordinates: [], rawCoordinateCount: 3, failure: 'invalid-coordinates',
    })
  })
})
