import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('snapshot publisher source invariants', () => {
  it('awaits static cache promotion only after complete local validation', () => {
    const publisher = readFileSync(new URL('../sync-transit-snapshot-core.mjs', import.meta.url), 'utf8')
    const validation = readFileSync(new URL('./validate.mjs', import.meta.url), 'utf8')

    expect(validation).not.toContain('promotePendingTdxStaticSources')
    expect(validation).toContain('assertPublisherManifestBudget({')

    const validateIndex = publisher.indexOf('const validation = validateSnapshot({')
    const promoteIndex = publisher.indexOf('await promotePendingTdxStaticSources()')
    const routingIndex = publisher.indexOf('const routingPublication = buildPublisherRoutingArtifacts({')

    expect(validateIndex).toBeGreaterThanOrEqual(0)
    expect(promoteIndex).toBeGreaterThan(validateIndex)
    expect(routingIndex).toBeGreaterThan(promoteIndex)
  })

  it('rejects patterns with fewer than two valid stops before staging', () => {
    const source = readFileSync(new URL('../sync-transit-snapshot-core.mjs', import.meta.url), 'utf8')
    expect(source).toContain('if (validStops.length < 2) continue')
    expect(source).not.toContain('if (!validStops.length) continue')
  })
})
