import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../sync-transit-snapshot.mjs', import.meta.url), 'utf8')

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
  it('keeps high-cardinality D1 validation out of the R2 publisher path', () => {
    const r2 = functionBlock('validateRemoteR2Snapshot', 'validateRemoteLegacyD1')
    const legacy = functionBlock('validateRemoteLegacyD1', 'readPublisherRoutingManifestBodies')

    expect(r2).toContain('FROM routes')
    expect(r2).toContain('FROM patterns')
    expect(r2).toContain('FROM stop_places')
    expect(r2).not.toContain('FROM stops')
    expect(r2).not.toContain('pattern_stops')

    expect(legacy).toContain('FROM stops')
    expect(legacy).toContain('pattern_stops')
  })
})
