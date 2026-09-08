import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../sync-transit-snapshot-core.mjs', import.meta.url), 'utf8')

function functionBlock(name, nextName) {
  const asyncStart = source.indexOf(`async function ${name}`)
  const syncStart = source.indexOf(`function ${name}`)
  const start = asyncStart >= 0 ? asyncStart : syncStart
  const asyncEnd = source.indexOf(`\nasync function ${nextName}`, start)
  const syncEnd = source.indexOf(`\nfunction ${nextName}`, start)
  const candidates = [asyncEnd, syncEnd].filter((value) => value > start)
  const end = candidates.length ? Math.min(...candidates) : -1
  if (start < 0 || end < 0) throw new Error(`Missing publisher function ${name}`)
  return source.slice(start, end)
}

describe('publisher remote D1 contract', () => {
  it('keeps high-cardinality authority in root-bound R2 rather than D1 validation', () => {
    const publish = functionBlock('validateRemoteSnapshot', 'smokePublishedSnapshot')

    expect(publish).toContain('publisherD1ValidationSql')
    expect(publish).toContain('readRollbackRoutingAuthority')
    expect(publish).toContain('assertPublisherRoutingAuthorityCounts')
    expect(publish).toContain('bindRollbackRoutingAuthority')
    expect(publish).toContain("binding !== 'root-bound'")
    expect(publish).not.toMatch(/\bFROM\s+stops\b/i)
    expect(publish).not.toContain('pattern_stops')
  })
})
