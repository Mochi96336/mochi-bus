import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const reader = readFileSync('scripts/transit-snapshot/d1-read-insights.mjs', 'utf8')

describe('D1 GraphQL query attribution contract', () => {
  it('uses the D1 query dataset filter type rather than an unrelated zone filter', () => {
    expect(reader).toContain('$filter: AccountD1QueriesAdaptiveGroupsFilter_InputObject')
    expect(reader).not.toContain('ZoneWorkersRequestsFilter_InputObject')
  })
})
