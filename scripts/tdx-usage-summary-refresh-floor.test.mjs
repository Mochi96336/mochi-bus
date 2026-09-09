import { describe, expect, it } from 'vitest'
import { parseTdxUsageText, summarizeTdxUsage } from './tdx-usage-summary.mjs'

describe('TDX usage accounting for local freshness hits', () => {
  it('does not count a persistent freshness hit as an upstream attempt or response', () => {
    const parsed = parseTdxUsageText(JSON.stringify({
      event: 'tdx_intercity_persistent_cache',
      resource: 'Shape',
      resolution: 'freshness-hit',
      sourceVersion: 'v1',
      bytes: 42_000_000,
      ageMs: 86_400_000,
      minimumRefreshMs: 4_838_400_000,
    }))

    expect(parsed.events).toEqual([])
    expect(parsed.input).toMatchObject({
      nonEmptyLines: 1,
      parsedLines: 1,
      malformedLines: 0,
      unrelatedRecords: 1,
    })
    expect(summarizeTdxUsage(parsed.events, parsed.input).scopes.all).toMatchObject({
      attempts: 0,
      httpResponses: 0,
      successResponses: 0,
      exactReceivedBytes: 0,
    })
  })
})
