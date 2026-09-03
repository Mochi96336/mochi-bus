import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const workflow = readFileSync(new URL('../../.github/workflows/backfill-pattern-stops.yml', import.meta.url), 'utf8')

describe('pattern-stop R2 backfill workflow', () => {
  it('is a one-shot Taichung active canary plus manual operator workflow', () => {
    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).toContain('push:')
    expect(workflow).toContain('- .github/workflows/backfill-pattern-stops.yml')
    expect(workflow).toContain("inputs.city || 'Taichung'")
    expect(workflow).toContain("inputs.target || 'active'")
    expect(workflow).not.toContain('schedule:')
  })

  it('runs only the read-only exporter with the provisioned D1 and R2 resources', () => {
    expect(workflow).toContain('node scripts/transit-snapshot/export-pattern-stops.mjs "$CITY" "$TARGET"')
    expect(workflow).toContain('TRANSIT_DATABASE_ID: ${{ steps.operation.outputs.d1_database_id }}')
    expect(workflow).toContain('TRANSIT_R2_BUCKET_NAME: ${{ steps.operation.outputs.r2_bucket_name }}')
    expect(workflow).toContain('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}')
    expect(workflow).toContain('R2_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}')
    expect(workflow).toContain('R2_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}')
  })

  it('cannot accidentally publish a snapshot or mutate the D1 schema', () => {
    expect(workflow).not.toContain('snapshot:window')
    expect(workflow).not.toContain('sync-transit-snapshot')
    expect(workflow).not.toContain('wrangler d1')
    expect(workflow).not.toContain('migrations apply')
    expect(workflow).not.toContain('TDX_CLIENT')
    expect(workflow).toContain('contents: read')
  })
})
