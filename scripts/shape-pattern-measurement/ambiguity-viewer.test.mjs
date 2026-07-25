import { describe, expect, it } from 'vitest'
import {
  buildAmbiguityViewerData,
  renderAmbiguityViewerHtml,
} from './ambiguity-viewer.mjs'

const stop = (sequence, lon, lat, uid = `S${sequence}`) => ({
  StopUID: uid,
  StopSequence: sequence,
  StopPosition: { PositionLon: lon, PositionLat: lat },
})

const pattern = ({
  routeUid = 'R1',
  subRouteUid = 'SR1',
  direction = 0,
  routeName = '測試幹線',
  subRouteName = '主線',
  offset = 0,
} = {}) => ({
  RouteUID: routeUid,
  SubRouteUID: subRouteUid,
  Direction: direction,
  RouteName: { Zh_tw: routeName },
  SubRouteName: { Zh_tw: subRouteName },
  Stops: [
    stop(1, 121 + offset, 25 + offset, `${routeUid}-${subRouteUid ?? 'missing'}-1`),
    stop(2, 121.01 + offset, 25.01 + offset, `${routeUid}-${subRouteUid ?? 'missing'}-2`),
  ],
})

const shape = ({
  routeUid = 'R1',
  subRouteUid = 'SR1',
  direction = 0,
  routeName = '測試幹線',
  subRouteName = '主線',
  coordinateCount = 2,
  offset = 0,
} = {}) => ({
  RouteUID: routeUid,
  SubRouteUID: subRouteUid,
  Direction: direction,
  RouteName: { Zh_tw: routeName },
  SubRouteName: { Zh_tw: subRouteName },
  Coordinates: Array.from({ length: coordinateCount }, (_value, index) => [
    121 + offset + index * 0.001,
    25 + offset + index * 0.001,
  ]),
})

const bundle = (stopOfRoute, shapes) => ({
  schemaVersion: 1,
  fetchedAt: '2026-07-25T00:00:00.000Z',
  sources: [{ scope: 'city', city: 'Taipei', stopOfRoute, shapes }],
})

const provenance = {
  fetchedAt: '2026-07-25T00:00:00.000Z',
  cities: ['Taipei'],
  includeIntercity: false,
  bundleContentHash: 'a'.repeat(64),
  sourceCommit: 'b'.repeat(40),
}

describe('Shape-to-pattern ambiguity viewer', () => {
  it('omits partitions resolved entirely by unique complete identities', () => {
    const report = buildAmbiguityViewerData(bundle(
      [pattern({ subRouteUid: 'A' }), pattern({ subRouteUid: 'B', offset: 0.1 })],
      [shape({ subRouteUid: 'A' }), shape({ subRouteUid: 'B', offset: 0.1 })],
    ), provenance)

    expect(report.summary.candidatePartitionCount).toBe(1)
    expect(report.summary.riskyPartitionCount).toBe(0)
    expect(report.partitions).toEqual([])
  })

  it('shows only residual geometry candidates after unique identity elimination', () => {
    const report = buildAmbiguityViewerData(bundle(
      [
        pattern({ subRouteUid: 'A', subRouteName: '唯一線' }),
        pattern({ subRouteUid: null, subRouteName: '缺少識別一', offset: 0.02 }),
        pattern({ subRouteUid: null, subRouteName: '缺少識別二', offset: 0.04 }),
      ],
      [
        shape({ subRouteUid: 'A', subRouteName: '唯一線' }),
        shape({ subRouteUid: null, subRouteName: '缺少識別一', coordinateCount: 7, offset: 0.02 }),
        shape({ subRouteUid: null, subRouteName: '缺少識別二', coordinateCount: 6, offset: 0.04 }),
      ],
    ), provenance, {
      maxCoordinatesPerShape: 3,
    })

    expect(report.summary.riskyPartitionCount).toBe(1)
    const [partition] = report.partitions
    expect(partition.routeName).toBe('測試幹線')
    expect(partition.uniqueExactPairCount).toBe(1)
    expect(partition.remainingPatternCount).toBe(2)
    expect(partition.remainingShapeCount).toBe(2)
    expect(partition.compatiblePairCount).toBe(4)
    expect(partition.atRiskPatternCount).toBe(2)
    expect(partition.riskReasons).toEqual([
      'many-to-many-after-exact-identity',
      'missing-pattern-identity',
      'missing-shape-identity',
    ])
    expect(partition.patterns).toHaveLength(2)
    expect(partition.shapes).toHaveLength(2)
    expect(partition.shapes[0].coordinateCount).toBeGreaterThan(3)
    expect(partition.shapes[0].displayCoordinates).toHaveLength(3)
    expect(partition.shapes[0].displayCoordinates[0]).toEqual(partition.shapes[0].firstCoordinate)
    expect(partition.shapes[0].displayCoordinates.at(-1)).toEqual(partition.shapes[0].lastCoordinate)
  })

  it('flags duplicate complete identities that still require assignment', () => {
    const report = buildAmbiguityViewerData(bundle(
      [pattern({ subRouteUid: 'D' }), pattern({ subRouteUid: 'D', offset: 0.02 })],
      [shape({ subRouteUid: 'D' }), shape({ subRouteUid: 'D', offset: 0.02 })],
    ), provenance)

    const [partition] = report.partitions
    expect(partition.uniqueExactPairCount).toBe(0)
    expect(partition.compatiblePairCount).toBe(4)
    expect(partition.riskReasons).toEqual([
      'duplicate-pattern-identity',
      'duplicate-shape-identity',
      'many-to-many-after-exact-identity',
    ])
  })

  it('renders a self-contained HTML viewer without allowing TDX names to close the data script', () => {
    const report = buildAmbiguityViewerData(bundle(
      [
        pattern({ routeName: '</script><img src=x onerror=alert(1)>', subRouteUid: null }),
        pattern({ routeName: '</script><img src=x onerror=alert(1)>', subRouteUid: null, offset: 0.02 }),
      ],
      [
        shape({ routeName: '</script><img src=x onerror=alert(1)>', subRouteUid: null }),
        shape({ routeName: '</script><img src=x onerror=alert(1)>', subRouteUid: null, offset: 0.02 }),
      ],
    ), provenance)

    const html = renderAmbiguityViewerHtml(report)
    expect(html).toContain('<!doctype html>')
    expect(html).toContain('Shape／站序歧義檢視')
    expect(html).not.toContain('</script><img src=x onerror=alert(1)>')
    expect(html).toContain('\\u003c/script>')
    expect(html).not.toMatch(/<script\s+[^>]*src=/i)
    expect(html).not.toMatch(/<link\s+[^>]*href=/i)
    expect(html).not.toContain('fetch(')
  })
})
