import { describe, expect, it, vi } from 'vitest'
import {
  ACTIVE_ROUTE_CATALOG_SQL,
  ACTIVE_ROUTE_COUNTS_SQL,
  diagnoseRouteCatalogD1,
} from './diagnose-routes-d1.mjs'

describe('release routes D1 diagnostic', () => {
  it('uses only fixed SELECT statements', () => {
    for (const sql of [ACTIVE_ROUTE_CATALOG_SQL, ACTIVE_ROUTE_COUNTS_SQL]) {
      expect(sql.trim().toUpperCase().startsWith('SELECT')).toBe(true)
      expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE|PRAGMA)\b/i)
    }
  })

  it('reports active low-cardinality counts without exposing active version identity', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([{ active_version: 'secret-version-token' }])
      .mockResolvedValueOnce([{ routes: 321, patterns: 654, places: 987, route_without_pattern: 0 }])

    const reports = await diagnoseRouteCatalogD1({ cities: ['Taipei'], query })
    expect(reports).toEqual([{
      city: 'Taipei',
      result: 'ok',
      stage: 'reference_ok',
      activeVersionPresent: true,
      routes: 321,
      patterns: 654,
      places: 987,
      routeWithoutPattern: 0,
    }])
    expect(query).toHaveBeenNthCalledWith(1, ACTIVE_ROUTE_CATALOG_SQL, ['Taipei'])
    expect(query).toHaveBeenNthCalledWith(2, ACTIVE_ROUTE_COUNTS_SQL, [
      'secret-version-token', 'Taipei',
      'secret-version-token', 'Taipei',
      'secret-version-token', 'Taipei',
      'secret-version-token', 'Taipei',
    ])
    expect(JSON.stringify(reports)).not.toContain('secret-version-token')
  })

  it('distinguishes missing pointer, empty active rows and query failure with bounded metadata', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ active_version: 'v2' }])
      .mockResolvedValueOnce([{ routes: 0, patterns: 1, places: 1, route_without_pattern: 0 }])
      .mockRejectedValueOnce(new Error('token=https://secret.example'))

    const reports = await diagnoseRouteCatalogD1({
      cities: ['Taipei', 'Chiayi', 'Kaohsiung'],
      query,
    })
    expect(reports.map(({ city, result, stage, activeVersionPresent }) => ({
      city, result, stage, activeVersionPresent,
    }))).toEqual([
      { city: 'Taipei', result: 'error', stage: 'active_pointer_missing', activeVersionPresent: false },
      { city: 'Chiayi', result: 'error', stage: 'active_rows_empty', activeVersionPresent: true },
      { city: 'Kaohsiung', result: 'error', stage: 'd1_query_failed', activeVersionPresent: false },
    ])
    expect(JSON.stringify(reports)).not.toMatch(/token=|secret\.example|\bv2\b/)
  })
})
