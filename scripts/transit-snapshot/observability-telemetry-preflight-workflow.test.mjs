import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const workflow = readFileSync('.github/workflows/observability-telemetry-preflight.yml', 'utf8')
const probe = readFileSync('scripts/transit-snapshot/observability-telemetry-preflight.mjs', 'utf8')

describe('Workers Observability telemetry preflight workflow', () => {
  it('is a bounded telemetry-key read and cannot execute D1 or query telemetry events', () => {
    expect(probe).toContain('/workers/observability/telemetry/keys')
    expect(probe).not.toContain('/workers/observability/telemetry/query')
    expect(probe).not.toContain('/workers/observability/telemetry/values')
    expect(probe).not.toMatch(/\/d1\/database\/[^\s]+\/query|wrangler d1|snapshot:window|snapshot:city|migrations apply/)
    expect(probe).toContain('MAX_RESPONSE_BYTES = 512 * 1024')
    expect(probe).toContain('REQUEST_TIMEOUT_MS = 15_000')
    expect(probe).toContain('MAX_TELEMETRY_KEYS = 512')
  })

  it('uses only the existing Cloudflare credential and uploads bounded evidence', () => {
    expect(workflow).toContain('permissions:\n  contents: read')
    expect(workflow).toContain('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}')
    expect(workflow).toContain('CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}')
    expect(workflow).not.toContain('CLOUDFLARE_ANALYTICS_API_TOKEN')
    expect(workflow).not.toContain('CLOUDFLARE_OBSERVABILITY_API_TOKEN')
    expect(workflow).not.toContain('schedule:')
    expect(workflow).toContain('retention-days: 7')
    expect(workflow).toContain('path: .transit-snapshot/observability-telemetry-preflight.json')
  })

  it('does not mutate production resources or trigger manual acceptance paths', () => {
    expect(workflow).not.toMatch(/wrangler deploy|wrangler d1|migrations|RUN_TAICHUNG|MEASURE_RESOURCES|ROLLBACK_TAICHUNG|TDX_|R2_/)
    expect(workflow).toContain("- '.github/workflows/observability-telemetry-preflight.yml'")
    expect(workflow).toContain("- 'scripts/transit-snapshot/observability-telemetry-preflight.mjs'")
  })
})
