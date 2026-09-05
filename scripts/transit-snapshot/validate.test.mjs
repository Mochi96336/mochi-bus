import { describe, expect, it } from 'vitest'
import { SnapshotValidationError, validateSnapshot } from './validate.mjs'

function validSnapshot() {
  const shapeFeature = {
    type: 'Feature', properties: {},
    geometry: { type: 'LineString', coordinates: [[120.4, 23.4], [120.5, 23.5]] },
  }
  const route = { uid: 'R1', name: '1' }
  const pattern = {
    id: 'P1',
    routeUid: 'R1',
    shapeKey: 'snapshots/v1/cities/Chiayi/shapes/P1.json',
    shapeFeature,
  }
  const place = { id: 'L1', lat: 23.4, lon: 120.4 }
  const stop = { uid: 'S1', placeId: 'L1', lat: 23.4, lon: 120.4 }
  const secondStop = { uid: 'S2', placeId: 'L1', lat: 23.5, lon: 120.5 }
  return {
    city: 'Chiayi', version: 'v1',
    routes: new Map([['R1', route]]),
    patterns: [pattern],
    stops: new Map([['S1', stop], ['S2', secondStop]]),
    places: new Map([['L1', place]]),
    patternStops: [
      { patternId: 'P1', stopUid: 'S1', placeId: 'L1', sequence: 1 },
      { patternId: 'P1', stopUid: 'S2', placeId: 'L1', sequence: 2 },
    ],
    schedules: new Map([['R1', []]]),
    placeBundles: new Map([['L1', {
      version: 'v1', placeId: 'L1',
      routes: [
        { routeUid: 'R1', variantKey: 'P1', stopUid: 'S1', stopSequence: 1, schedules: [] },
        { routeUid: 'R1', variantKey: 'P1', stopUid: 'S2', stopSequence: 2, schedules: [] },
      ],
    }]]),
    network: {
      schemaVersion: 1, city: 'Chiayi', version: 'v1',
      routes: [{ variantKey: 'P1', shape: shapeFeature }],
      places: [{ placeId: 'L1' }],
    },
  }
}

describe('validateSnapshot', () => {
  it('accepts a complete internally consistent snapshot', () => {
    const result = validateSnapshot(validSnapshot())
    expect(result).toMatchObject({
      valid: true,
      counts: { routes: 1, patterns: 1, stops: 2, places: 1, patternStops: 2, schedules: 1, placeBundles: 1 },
      quality: {
        scheduledRoutes: 0,
        scheduleRouteCoverage: 0,
        bundleRoutes: 2,
        bundleRoutesWithSchedules: 0,
        bundleScheduleCoverage: 0,
        networkCoordinates: 2,
      },
    })
    expect(result.quality.networkBytes).toBeGreaterThan(0)
  })

  it('rejects dangling route, stop, place and network references', () => {
    const snapshot = validSnapshot()
    snapshot.patterns[0].routeUid = 'MISSING'
    snapshot.patternStops[0].stopUid = 'MISSING'
    snapshot.stops.get('S1').placeId = 'MISSING'
    snapshot.network.routes[0].variantKey = 'MISSING'

    expect(() => validateSnapshot(snapshot)).toThrow(SnapshotValidationError)
    expect(() => validateSnapshot(snapshot)).toThrow(/references missing route|references missing stop|references missing place|network references missing pattern/)
  })

  it('rejects catalogue routes that have no pattern', () => {
    const snapshot = validSnapshot()
    snapshot.routes.set('ORPHAN', { uid: 'ORPHAN', name: 'orphan' })
    snapshot.schedules.set('ORPHAN', [])

    expect(() => validateSnapshot(snapshot)).toThrow(/route ORPHAN has no pattern/)
  })

  it('rejects pattern-stop places that differ from the canonical stop', () => {
    const snapshot = validSnapshot()
    snapshot.places.set('L2', { id: 'L2', lat: 23.41, lon: 120.41 })
    snapshot.patternStops[0].placeId = 'L2'

    expect(() => validateSnapshot(snapshot)).toThrow(/canonical place/)
  })

  it('rejects empty or geographically invalid data', () => {
    const empty = validSnapshot()
    empty.routes.clear()
    empty.schedules.clear()
    expect(() => validateSnapshot(empty)).toThrow(/routes must not be empty|patterns.*missing route/)

    const invalid = validSnapshot()
    invalid.stops.get('S1').lat = 99
    expect(() => validateSnapshot(invalid)).toThrow(/invalid Taiwan coordinate/)
  })

  it('blocks catastrophic count regression against the previous published state', () => {
    const previous = {
      counts: { routes: 3, patterns: 3, stops: 10, places: 3, patternStops: 10, placeBundles: 3 },
    }
    expect(() => validateSnapshot(validSnapshot(), previous)).toThrow(/dropped/)
  })

  it('requires every pattern to have at least two stops and every bundle entry to be backed by one', () => {
    const short = validSnapshot()
    short.patternStops.pop()
    short.placeBundles.get('L1').routes.pop()
    expect(() => validateSnapshot(short)).toThrow(/only 1 stop/)

    const unbacked = validSnapshot()
    unbacked.placeBundles.get('L1').routes[0].stopSequence = 99
    expect(() => validateSnapshot(unbacked)).toThrow(/not backed by a pattern stop|no matching place bundle route/)
  })

  it('blocks catastrophic schedule coverage and network geometry regression', () => {
    const snapshot = validSnapshot()
    const previous = {
      counts: { routes: 1, patterns: 1, stops: 2, places: 1, patternStops: 2, placeBundles: 1 },
      quality: {
        scheduledRoutes: 1,
        scheduleRouteCoverage: 1,
        bundleRoutes: 2,
        bundleRoutesWithSchedules: 2,
        bundleScheduleCoverage: 1,
        networkCoordinates: 10,
        networkBytes: 10_000,
      },
    }
    expect(() => validateSnapshot(snapshot, previous)).toThrow(/scheduledRoutes|scheduleRouteCoverage|networkCoordinates|networkBytes/)
  })
})
