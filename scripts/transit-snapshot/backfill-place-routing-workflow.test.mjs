import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const workflow = readFileSync(new URL('../../.github/workflows/backfill-place-routing.yml', import.meta.url), 'utf8')

describe('place-routing R2 backfill workflow', () => {
  it('is manual-only and serializes runs per city', () => {
    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).not.toContain('push:')
    expect(workflow).not.toContain('schedule:')
    expect(workflow).toContain('CITY: ${{ inputs.city }}')
    expect(workflow).toContain('TARGET: ${{ inputs.target }}')
    expect(workflow).toContain('group: place-routing-backfill-${{ inputs.city }}')
    expect(workflow).toContain('cancel-in-progress: false')
  })

  it('runs only the R2 exporter with provisioned snapshot resources', () => {
    expect(workflow).toContain('node scripts/transit-snapshot/export-place-routing.mjs "$CITY" "$TARGET"')
    expect(workflow).toContain('TRANSIT_DATABASE_ID: ${{ steps.operation.outputs.d1_database_id }}')
    expect(workflow).toContain('TRANSIT_R2_BUCKET_NAME: ${{ steps.operation.outputs.r2_bucket_name }}')
    expect(workflow).toContain('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}')
    expect(workflow).toContain('R2_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}')
    expect(workflow).toContain('R2_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}')
    expect(workflow).toContain('node scripts/instance/assert-operation-city.mjs "$CITY"')
    expect(workflow).toContain('place_routing_export_completed')
  })

  it('cannot publish snapshots or mutate the D1 schema', () => {
    expect(workflow).not.toContain('snapshot:window')
    expect(workflow).not.toContain('sync-transit-snapshot')
    expect(workflow).not.toContain('wrangler d1')
    expect(workflow).not.toContain('migrations apply')
    expect(workflow).not.toContain('TDX_CLIENT')
    expect(workflow).not.toContain('wrangler deploy')
    expect(workflow).toContain('contents: read')
  })
})
