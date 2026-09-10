import { describe, expect, it } from 'vitest'
import {
  buildD1ReadInsightsReport,
  MAX_QUERY_SHAPE_LENGTH,
  sanitizeQueryShape,
} from './d1-read-insights.mjs'

describe('D1 read insights sanitizer', () => {
  it('removes comments and string/numeric literals while keeping the SQL shape useful', () => {
    const shape = sanitizeQueryShape(`
      -- city-specific probe
      SELECT p.pattern_id, s.stop_uid
      FROM pattern_stops p
      JOIN stops s ON s.version = p.version AND s.stop_uid = p.stop_uid
      WHERE p.version = '20260830T215444914Z'
        AND p.city_code = "Taipei"
        AND p.pattern_id IN ('A', 'B')
        AND p.stop_sequence > 12
        /* hidden note */
      ORDER BY p.stop_sequence
    `)

    expect(shape).toContain('FROM pattern_stops p JOIN stops s')
    expect(shape).toContain('p.version = ?')
    expect(shape).toContain('p.city_code = ?')
    expect(shape).toContain('p.pattern_id IN (?, ?)')
    expect(shape).toContain('p.stop_sequence > ?')
    expect(shape).not.toContain('Taipei')
    expect(shape).not.toContain('20260830')
    expect(shape).not.toContain('hidden note')
  })

  it('bounds very large query shapes', () => {
    const shape = sanitizeQueryShape(`SELECT ${'column_name, '.repeat(200)} final_column FROM routes`)
    expect(shape.length).toBeLessThanOrEqual(MAX_QUERY_SHAPE_LENGTH)
    expect(shape.endsWith('…')).toBe(true)
  })

  it('normalizes and sorts metric-only evidence without preserving raw query text', () => {
    const report = buildD1ReadInsightsReport([
      {
        query: "SELECT * FROM routes WHERE city_code = 'Taipei'",
        totalRowsRead: 10,
        avgRowsRead: 5,
        numberOfTimesRun: 2,
        avgDurationMs: 1.25,
        queryEfficiency: 0.5,
      },
      {
        query: "SELECT * FROM pattern_stops WHERE version = 'secret-version'",
        totalRowsRead: 50_000,
        avgRowsRead: 25_000,
        numberOfTimesRun: 2,
        avgDurationMs: 4.5,
        queryEfficiency: 0.1,
      },
    ], {
      generatedAt: '2026-09-10T01:00:00.000Z',
      timePeriod: '1d',
    })

    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedAt: '2026-09-10T01:00:00.000Z',
      timePeriod: '1d',
      capturedQueryCount: 2,
      capturedTotalRowsRead: 50_010,
      capturedExecutions: 4,
    })
    expect(report.queries[0]).toMatchObject({
      totalRowsRead: 50_000,
      avgRowsRead: 25_000,
      numberOfTimesRun: 2,
    })
    expect(report.queries[0].queryFingerprint).toMatch(/^[0-9a-f]{16}$/)
    expect(report.queries[0].queryShape).toContain('FROM pattern_stops')
    expect(JSON.stringify(report)).not.toContain('secret-version')
    expect(JSON.stringify(report)).not.toContain('Taipei')
  })

  it('fails closed on unbounded or invalid metric payloads', () => {
    expect(() => buildD1ReadInsightsReport(new Array(101).fill({})))
      .toThrow('bounded array')
    expect(() => buildD1ReadInsightsReport([{
      query: 'SELECT 1',
      totalRowsRead: -1,
      avgRowsRead: 0,
      numberOfTimesRun: 1,
      avgDurationMs: 0,
    }])).toThrow('totalRowsRead')
    expect(() => buildD1ReadInsightsReport([{
      query: 'SELECT 1',
      totalRowsRead: 1,
      avgRowsRead: Number.NaN,
      numberOfTimesRun: 1,
      avgDurationMs: 0,
    }])).toThrow('avgRowsRead')
  })
})
