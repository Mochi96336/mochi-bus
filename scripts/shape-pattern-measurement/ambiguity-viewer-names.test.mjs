import { describe, expect, it } from 'vitest'
import { buildAmbiguityViewerData } from './ambiguity-viewer.mjs'
import {
  buildAmbiguityCandidateNameIndex,
  enrichAmbiguityViewerCandidateNames,
} from './ambiguity-viewer-names.mjs'

const stop = (sequence, lon, lat, uid) => ({
  StopUID: uid,
  StopSequence: sequence,
  StopPosition: { PositionLon: lon, PositionLat: lat },
})

const pattern = (name, offset, overrides = {}) => ({
  RouteUID: 'R1',
  SubRouteUID: null,
  Direction: 0,
  RouteName: { Zh_tw: '測試幹線' },
  SubRouteName: { Zh_tw: name },
  Stops: [
    stop(1, 121 + offset, 25 + offset, `${name}-1`),
    stop(2, 121.01 + offset, 25.01 + offset, `${name}-2`),
  ],
  ...overrides,
})

const shape = (name, offset, overrides = {}) => ({
  RouteUID: 'R1',
  SubRouteUID: null,
  Direction: 0,
  RouteName: { Zh_tw: '測試幹線' },
  SubRouteName: { Zh_tw: name },
  Coordinates: [
    [121 + offset, 25 + offset],
    [121.01 + offset, 25.01 + offset],
  ],
  ...overrides,
})

const provenance = {
  fetchedAt: '2026-07-25T00:00:00.000Z',
  cities: ['Taipei'],
  includeIntercity: false,
  bundleContentHash: 'a'.repeat(64),
  sourceCommit: 'b'.repeat(40),
}

function build(stopOfRoute, shapes) {
  const rawBundle = {
    schemaVersion: 1,
    fetchedAt: provenance.fetchedAt,
    sources: [{ scope: 'city', city: 'Taipei', stopOfRoute, shapes }],
  }
  return enrichAmbiguityViewerCandidateNames(
    buildAmbiguityViewerData(rawBundle, provenance),
    buildAmbiguityCandidateNameIndex(rawBundle),
  )
}

describe('ambiguity viewer candidate names', () => {
  it('keeps distinct names for missing-identity candidates with different geometry', () => {
    const report = build(
      [pattern('缺少識別一', 0), pattern('缺少識別二', 0.02)],
      [shape('缺少識別一', 0), shape('缺少識別二', 0.02)],
    )

    const [partition] = report.partitions
    expect(new Set(partition.patterns.map((entry) => entry.subRouteName))).toEqual(new Set([
      '缺少識別一',
      '缺少識別二',
    ]))
    expect(new Set(partition.shapes.map((entry) => entry.subRouteName))).toEqual(new Set([
      '缺少識別一',
      '缺少識別二',
    ]))
    expect(partition.patterns.every((entry) => entry.subRouteNameConflict === false)).toBe(true)
    expect(partition.shapes.every((entry) => entry.subRouteNameConflict === false)).toBe(true)
  })

  it('reports multiple raw names attached to one normalized candidate instead of choosing silently', () => {
    const firstPattern = pattern('名稱甲', 0)
    const secondPattern = { ...firstPattern, SubRouteName: { Zh_tw: '名稱乙' } }
    const firstShape = shape('名稱甲', 0)
    const secondShape = { ...firstShape, SubRouteName: { Zh_tw: '名稱乙' } }
    const report = build(
      [firstPattern, secondPattern],
      [firstShape, secondShape],
    )

    const [partition] = report.partitions
    expect(partition.patterns).toHaveLength(2)
    expect(partition.shapes).toHaveLength(2)
    for (const entry of [...partition.patterns, ...partition.shapes]) {
      expect(new Set(entry.subRouteNameAlternatives)).toEqual(new Set(['名稱甲', '名稱乙']))
      expect(entry.subRouteName).toBe(entry.subRouteNameAlternatives.join('／'))
      expect(entry.subRouteNameConflict).toBe(true)
    }
  })
})
