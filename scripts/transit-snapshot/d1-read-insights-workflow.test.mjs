import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const workflow = readFileSync('.github/workflows/d1-read-insights.yml', 'utf8')
const sanitizer = readFileSync('scripts/transit-snapshot/d1-read-insights.mjs', 'utf8')

describe('D1 read insights workflow', () => {
  it('uses analytics insights only and cannot provision or execute D1 SQL', () => {
    expect(workflow).toContain('wrangler d1 insights')
    expect(workflow).toContain('--sort-by reads')
    expect(workflow).toContain('--sort-type sum')
    expect(workflow).toContain('--time-period "$D1_INSIGHTS_TIME_PERIOD"')
    expect(workflow).toContain('--experimental-provision=false')
    expect(workflow).toContain('--experimental-auto-create=false')
    expect(workflow).not.toMatch(/wrangler d1 (?:execute|migrations|time-travel)|\/d1\/database\/[^\s]+\/query|SNAPSHOT_FORCE|snapshot:window|snapshot:city/)
  })

  it('keeps raw query analytics ephemeral and uploads only the sanitized report', () => {
    expect(workflow).toContain('raw="$(mktemp)"')
    expect(workflow).toContain("trap 'rm -f \"$raw\"' EXIT")
    expect(workflow).toContain('> "$raw"')
    expect(workflow).toContain('D1_INSIGHTS_RAW_PATH="$raw" node scripts/transit-snapshot/d1-read-insights.mjs')
    expect(workflow).toContain('path: .transit-snapshot/d1-read-insights.json')
    expect(workflow).not.toContain('d1-read-insights.raw.json')
    expect(sanitizer).not.toMatch(/rawQuery|originalQuery/)
  })

  it('is read-only, bounded, and re-runs when its production contract changes', () => {
    expect(workflow).toContain('permissions:\n  contents: read')
    expect(workflow).toContain('--limit 25')
    expect(workflow).toContain('retention-days: 7')
    expect(workflow).toContain("- '.github/workflows/d1-read-insights.yml'")
    expect(workflow).toContain("- 'scripts/transit-snapshot/d1-read-insights.mjs'")
  })
})
