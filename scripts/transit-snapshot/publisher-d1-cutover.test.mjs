import { describe, expect, it } from 'vitest'
import {
  assertPublisherD1Validation,
  assertPublisherRoutingAuthorityCounts,
  buildPublisherD1CleanupSql,
  buildPublisherD1ImportSql,
  publisherD1ValidationSql,
} from './publisher-d1-cutover.mjs'

const version = '20260906T010203000Z'
const city = 'Taichung'

function snapshot() {
  return {
    routes: new Map([['R1', {
      uid: 'R1', name: "1'號", departure: '甲', destination: '乙',
    }]]),
    patterns: [{
      id: 'P1', routeUid: 'R1', subrouteUid: null, subrouteName: '1', direction: 0,
      departure: '甲', destination: '乙', shapeKey: `snapshots/${version}/cities/${city}/shapes/P1.json`,
      updatedAt: '2026-09-06T00:00:00+08:00',
    }],
    places: new Map([['L1', { id: 'L1', name: '甲站', lat: 24.1, lon: 120.6 }]]),
  }
}

describe('publisher D1 cutover', () => {
  it('publishes only routes, patterns, and stop_places to D1', () => {
    const statements = buildPublisherD1ImportSql({ version, city, ...snapshot() })
    const sql = statements.join('\n')
    expect(sql).toContain('INSERT OR REPLACE INTO routes')
    expect(sql).toContain('INSERT OR REPLACE INTO patterns')
    expect(sql).toContain('INSERT OR REPLACE INTO stop_places')
    expect(sql).not.toMatch(/INSERT\s+OR\s+REPLACE\s+INTO\s+stops\b/i)
    expect(sql).not.toContain('pattern_stops')
    expect(sql).toContain("1''號")
  })

  it('does not delete legacy high-cardinality rows during normal cleanup', () => {
    const sql = buildPublisherD1CleanupSql({ city, versions: ['v1', 'v2', 'v1'] }).join('\n')
    expect(sql).toContain('DELETE FROM stop_places')
    expect(sql).toContain('DELETE FROM patterns')
    expect(sql).toContain('DELETE FROM routes')
    expect(sql).not.toMatch(/DELETE\s+FROM\s+stops\b/i)
    expect(sql).not.toContain('pattern_stops')
  })

  it('keeps remote D1 validation low-cardinality only', () => {
    const sql = publisherD1ValidationSql({ version, city })
    expect(sql).toContain('FROM routes')
    expect(sql).toContain('FROM patterns')
    expect(sql).toContain('FROM stop_places')
    expect(sql).not.toMatch(/\bFROM\s+stops\b/i)
    expect(sql).not.toContain('pattern_stops')
  })

  it('validates low-cardinality D1 counts and route-pattern integrity', () => {
    const result = [
      { results: [{ count: 1 }] },
      { results: [{ count: 2 }] },
      { results: [{ count: 3 }] },
      { results: [{ count: 0 }] },
      { results: [{ count: 0 }] },
    ]
    expect(assertPublisherD1Validation(result, { routes: 1, patterns: 2, places: 3 }))
      .toEqual({ routes: 1, patterns: 2, places: 3 })
    expect(() => assertPublisherD1Validation(result, { routes: 2, patterns: 2, places: 3 }))
      .toThrow('Remote D1 routes count mismatch')
  })

  it('requires R2 routing authority to preserve the full high-cardinality counts', () => {
    const counts = { routes: 10, patterns: 20, stops: 30, places: 40, patternStops: 50 }
    expect(assertPublisherRoutingAuthorityCounts(
      { patterns: 20, stops: 30, places: 40, patternStops: 50 },
      counts,
    )).toBe(true)
    expect(() => assertPublisherRoutingAuthorityCounts(
      { patterns: 20, stops: 30, places: 40, patternStops: 49 },
      counts,
    )).toThrow('Remote R2 patternStops count mismatch')
  })
})
