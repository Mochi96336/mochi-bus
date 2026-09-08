import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('snapshot publisher source invariants', () => {
  it('rejects patterns with fewer than two valid stops before staging', () => {
    const source = readFileSync(new URL('../sync-transit-snapshot-core.mjs', import.meta.url), 'utf8')
    expect(source).toContain('if (validStops.length < 2) continue')
    expect(source).not.toContain('if (!validStops.length) continue')
  })
})
