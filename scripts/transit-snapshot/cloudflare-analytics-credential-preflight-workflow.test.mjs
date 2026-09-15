import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const workflow = readFileSync('.github/workflows/cloudflare-analytics-credential-preflight.yml', 'utf8')
const probe = readFileSync('scripts/transit-snapshot/cloudflare-analytics-credential-preflight.mjs', 'utf8')
const measurement = readFileSync('scripts/transit-snapshot/measure-worker-resources.mjs', 'utf8')

describe('Cloudflare Account Analytics credential preflight workflow', () => {
  it('is manual-only, main-only and read-only', () => {
    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).not.toContain('\n  schedule:')
    expect(workflow).not.toContain('\n  push:')
    expect(workflow).not.toContain('\n  pull_request:')
    expect(workflow).toContain('contents: read')
    expect(workflow).not.toMatch(/(?:actions|contents|deployments|id-token|issues|packages|pull-requests|security-events|statuses): write/)
    expect(workflow).toContain("test \"${GITHUB_REF}\" = 'refs/heads/main'")
  })

  it('uses only the dedicated Account Analytics credential and bounded evidence path', () => {
    expect(workflow).toContain('CLOUDFLARE_ANALYTICS_API_TOKEN: ${{ secrets.CLOUDFLARE_ANALYTICS_API_TOKEN }}')
    expect(workflow).toContain('CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}')
    expect(workflow).toContain('cloudflare-analytics-credential-preflight.mjs')
    expect(workflow).toContain('cloudflare-analytics-credential-preflight-${{ github.run_id }}-${{ github.run_attempt }}')
    expect(workflow).toContain('retention-days: 14')
    expect(probe).toContain('MAX_GRAPHQL_RESPONSE_BYTES = 512 * 1024')
    expect(probe).toContain('REQUEST_TIMEOUT_MS = 15_000')
    expect(probe).toContain('MAX_ERROR_DETAIL = 360')
  })

  it('uploads evidence before failing closed on NOT READY', () => {
    const upload = workflow.indexOf('Upload bounded Account Analytics preflight evidence')
    const requireReady = workflow.indexOf('Require Cloudflare Account Analytics READY')
    expect(upload).toBeGreaterThan(0)
    expect(requireReady).toBeGreaterThan(upload)
    expect(workflow).toContain("report?.outcome === 'ready'")
    expect(workflow).toContain('report?.ready === true')
    expect(workflow).toContain("console.log('Cloudflare Account Analytics preflight: READY')")
    expect(workflow).toContain("console.error('Cloudflare Account Analytics preflight: NOT READY')")
  })

  it('tracks the exact Worker measurement GraphQL contract', () => {
    for (const needle of [
      'query WorkerResourceMeasurement',
      'workersInvocationsAdaptive(',
      'memoryUsageBytesP50',
      'memoryUsageBytesP90',
      'memoryUsageBytesP99',
      'memoryUsageBytesP999',
      'errors',
      'requests',
      'subrequests',
    ]) {
      expect(probe).toContain(needle)
      expect(measurement).toContain(needle)
    }
  })

  it('cannot mutate or execute the production resource measurement path', () => {
    for (const forbidden of [
      'CLOUDFLARE_API_TOKEN',
      'CLOUDFLARE_DEPLOY_API_TOKEN',
      'R2_ACCESS_KEY_ID',
      'R2_SECRET_ACCESS_KEY',
      'TDX_CLIENT_ID',
      'TDX_CLIENT_SECRET',
      'wrangler',
      'MEASURE_RESOURCES',
      'snapshot:window',
      'measure-worker-resources.mjs',
      'aws4fetch',
    ]) expect(workflow).not.toContain(forbidden)
  })
})
