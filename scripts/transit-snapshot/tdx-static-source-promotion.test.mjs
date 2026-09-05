import { describe, expect, it, vi } from 'vitest'
import {
  pendingTdxStaticSourceCandidates,
  promotePendingTdxStaticSources,
  registerTdxStaticSourceCandidate,
} from './tdx-static-source-promotion.mjs'

describe('TDX static source promotion registry', () => {
  it('promotes registered candidates after a validation boundary', async () => {
    const cache = { promote: vi.fn(async () => true) }
    const candidate = { resource: 'Route', sourceVersion: 'v1' }

    expect(registerTdxStaticSourceCandidate({ cache, candidate, city: 'Taipei', resource: 'Route' }))
      .toBe(true)
    expect(pendingTdxStaticSourceCandidates()).toBeGreaterThan(0)

    const result = await promotePendingTdxStaticSources({ logger: { log: vi.fn(), warn: vi.fn() } })
    expect(cache.promote).toHaveBeenCalledWith(candidate)
    expect(result.promoted).toBeGreaterThanOrEqual(1)
  })

  it('rejects entries that cannot promote', () => {
    expect(registerTdxStaticSourceCandidate({ cache: {}, candidate: { resource: 'Shape' } })).toBe(false)
  })
})
