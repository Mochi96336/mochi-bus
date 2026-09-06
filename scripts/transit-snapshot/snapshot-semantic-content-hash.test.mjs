import { describe, expect, it } from 'vitest'
import { snapshotSemanticContentHash } from './snapshot-semantic-content-hash.mjs'

function fixture() {
  const shapeFeature = {
    type: 'Feature',
    properties: { routeUid: 'R1', direction: 0 },
    geometry: { type: 'LineString', coordinates: [[121.5, 25], [121.6, 25.1]] },
  }
  return {
    format: 9,
    routes: new Map([
      ['R2', { uid: 'R2', name: '2', departure: '丙', destination: '丁' }],
      ['R1', { uid: 'R1', name: '1', departure: '甲', destination: '乙' }],
    ]),
    patterns: [
      {
        id: 'P2', routeUid: 'R2', subrouteUid: null, subrouteName: '2', direction: 1,
        departure: '丁', destination: '丙', shapeKey: 'snapshots/v1/shapes/P2.json',
        updatedAt: '2026-09-05T00:00:00+08:00', shapeFeature,
      },
      {
        id: 'P1', routeUid: 'R1', subrouteUid: 'S1', subrouteName: '1A', direction: 0,
        departure: '甲', destination: '乙', shapeKey: 'snapshots/v1/shapes/P1.json',
        updatedAt: '2026-09-05T00:00:00+08:00', shapeFeature,
      },
    ],
    stops: new Map([
      ['STOP2', { uid: 'STOP2', name: '乙', normalized: '乙', lat: 25.1, lon: 121.6, placeId: 'L2' }],
      ['STOP1', { uid: 'STOP1', name: '甲', normalized: '甲', lat: 25, lon: 121.5, placeId: 'L1' }],
    ]),
    places: new Map([
      ['L2', { id: 'L2', name: '乙', normalized: '乙', lat: 25.1, lon: 121.6 }],
      ['L1', { id: 'L1', name: '甲', normalized: '甲', lat: 25, lon: 121.5 }],
    ]),
    patternStops: [
      { patternId: 'P1', stopUid: 'STOP2', placeId: 'L2', sequence: 2 },
      { patternId: 'P1', stopUid: 'STOP1', placeId: 'L1', sequence: 1 },
    ],
    schedules: new Map([['R1', [
      {
        SubRouteUID: 'S1', Direction: 0, OperatorID: 'unused',
        Timetables: [
          {
            ServiceDay: { Monday: 1, Sunday: 0 },
            StopTimes: [
              { StopUID: 'STOP2', StopSequence: 2, ArrivalTime: '08:20', DepartureTime: '08:21', Extra: 'ignored' },
              { StopUID: 'STOP1', StopSequence: 1, ArrivalTime: '08:00', DepartureTime: '08:01' },
            ],
          },
        ],
        Frequencys: [
          { StartTime: '09:00', EndTime: '10:00', MinHeadwayMins: 10, MaxHeadwayMins: 15, ServiceDay: { Monday: 1 } },
        ],
      },
    ]], ['R2', []]]),
  }
}

function cloneFixture() {
  const source = fixture()
  return structuredClone(source)
}

describe('snapshotSemanticContentHash', () => {
  it('ignores collection ordering, volatile publication metadata, and unused schedule fields', () => {
    const left = fixture()
    const right = cloneFixture()
    right.routes = new Map([...right.routes.entries()].reverse())
    right.stops = new Map([...right.stops.entries()].reverse())
    right.places = new Map([...right.places.entries()].reverse())
    right.patterns.reverse()
    right.patternStops.reverse()
    right.patterns[0].shapeKey = 'snapshots/another-version/shapes/P1.json'
    right.patterns[0].updatedAt = '2099-01-01T00:00:00Z'
    const schedule = right.schedules.get('R1')[0]
    schedule.OperatorID = 'changed-but-unused'
    schedule.Timetables[0].StopTimes.reverse()
    schedule.Timetables[0].ServiceDay = { Sunday: 0, Monday: 1 }

    expect(snapshotSemanticContentHash(left)).toBe(snapshotSemanticContentHash(right))
  })

  it('changes when a user-visible or routing semantic changes', () => {
    const baseline = snapshotSemanticContentHash(fixture())
    const changedStopTime = cloneFixture()
    changedStopTime.schedules.get('R1')[0].Timetables[0].StopTimes[0].ArrivalTime = '08:22'
    expect(snapshotSemanticContentHash(changedStopTime)).not.toBe(baseline)

    const changedShape = cloneFixture()
    changedShape.patterns[0].shapeFeature.geometry.coordinates[1][0] = 121.7
    expect(snapshotSemanticContentHash(changedShape)).not.toBe(baseline)
  })

  it('changes when the snapshot format contract changes', () => {
    const current = fixture()
    const next = cloneFixture()
    next.format = current.format + 1
    expect(snapshotSemanticContentHash(next)).not.toBe(snapshotSemanticContentHash(current))
  })
})
