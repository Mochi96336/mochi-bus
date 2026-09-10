import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const workflow = readFileSync('.github/workflows/d1-read-insights.yml', 'utf8')
const reader = readFileSync('scripts/transit-snapshot/d1-read-insights.mjs', 'utf8')

describe('D1 read insights workflow', () => {
  it('uses Cloudflare analytics GraphQL only and cannot execute or provision D1 SQL', () => {
    expect(workflow).toContain('node scripts/transit-snapshot/d1-read-insights.mjs')
    expect(workflow).toContain('D1_DATABASE_ID: ${{ steps.operation.outputs.d1_database_id }}')
    expect(reader).toContain("https://api.cloudflare.com/client/v4/graphql")
    expect(reader).toContain('d1QueriesAdaptiveGroups')
    expect(reader).toContain('d1AnalyticsAdaptiveGroups')
    expect(workflow).not.toMatch(/wrangler d1|\/d1\/database\/[^\s]+\/query|SNAPSHOT_FORCE|snapshot:window|snapshot:city|migrations apply/)
    expect(reader).not.toMatch(/\/d1\/database\/[^\s]+\/query/)
  })

  it('uploads only the bounded sanitized report and never creates a raw analytics artifact', () => {
    expect(workflow).toContain('path: .transit-snapshot/d1-read-insights.json')
    expect(workflow).not.toMatch(/mktemp|D1_INSIGHTS_RAW_PATH|d1-read-insights\.raw/)
    expect(reader).not.toMatch(/rawQuery|originalQuery/)
    expect(reader).toContain('MAX_GRAPHQL_RESPONSE_BYTES = 512 * 1024')
    expect(reader).toContain('MAX_QUERY_SHAPE_LENGTH = 640')
  })

  it('is read-only, bounded, and re-runs when its production contract changes', () => {
    expect(workflow).toContain('permissions:\n  contents: read')
    expect(workflow).toContain("- cron: '45 23 * * *'")
    expect(workflow).toContain('retention-days: 7')
    expect(workflow).toContain("- '.github/workflows/d1-read-insights.yml'")
    expect(workflow).toContain("- 'scripts/transit-snapshot/d1-read-insights.mjs'")
    expect(reader).toContain('QUERY_LIMIT = 25')
    expect(reader).toContain("queryWindowUsed = '7d'")
  })
})
