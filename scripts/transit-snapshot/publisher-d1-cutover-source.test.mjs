import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../sync-transit-snapshot-core.mjs', import.meta.url), 'utf8')

describe('snapshot publisher D1 cutover source contract', () => {
  it('does not stage or clean stops/pattern_stops in the normal publisher', () => {
    expect(source).not.toMatch(/INSERT\s+OR\s+REPLACE\s+INTO\s+stops\b/i)
    expect(source).not.toMatch(/INSERT\s+OR\s+REPLACE\s+INTO\s+pattern_stops\b/i)
    expect(source).not.toMatch(/DELETE\s+FROM\s+stops\b/i)
    expect(source).not.toMatch(/DELETE\s+FROM\s+pattern_stops\b/i)
  })

  it('uses the low-card D1 and routing-manifest validation contracts', () => {
    expect(source).toContain('buildPublisherD1ImportSql')
    expect(source).toContain('buildPublisherD1CleanupSql')
    expect(source).toContain('publisherD1ValidationSql')
    expect(source).toContain('readRollbackRoutingAuthority')
    expect(source).toContain('assertPublisherRoutingAuthorityCounts')
  })
})
