import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./rollback.mjs', import.meta.url), 'utf8')

function functionBlock(name, nextName) {
  const start = source.indexOf(`function ${name}`)
  const end = source.indexOf(`\nfunction ${nextName}`, start)
  if (start < 0 || end < 0) throw new Error(`Missing rollback function ${name}`)
  return source.slice(start, end)
}

describe('rollback R2 D1 contract', () => {
  it('keeps high-cardinality D1 reads confined to the legacy validation path', () => {
    const legacy = functionBlock('validateLegacyD1', 'validateR2AuthorityD1')
    const r2 = functionBlock('validateR2AuthorityD1', 'assertValidationRows')

    expect(legacy).toContain('FROM stops')
    expect(legacy).toContain('pattern_stops')
    expect(r2).toContain('FROM routes')
    expect(r2).toContain('FROM patterns')
    expect(r2).toContain('FROM stop_places')
    expect(r2).not.toContain('FROM stops')
    expect(r2).not.toContain('pattern_stops')
  })
})
