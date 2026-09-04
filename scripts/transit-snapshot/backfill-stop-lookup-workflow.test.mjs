import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const workflow = readFileSync(new URL('../../.github/workflows/backfill-stop-lookup.yml', import.meta.url), 'utf8')

describe('stop-lookup R2 backfill workflow', () => {
  it('is manual-only after the production canary', () => {
    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).not.toContain('push:')
    expect(workflow).not.toContain('schedule:')
    expect(workflow).toContain('CITY: ${{ inputs.city }}')
    expect(workflow).toContain('TARGET: ${{ inputs.target }}')
    expect(workflow).toContain('group: stop-lookup-backfill-${{ inputs.city }}')
    expect(workflow).not.toContain("|| 'Taichung'")
    expect(workflow).not.toContain("|| 'active'")
    expect(workflow).toContain('cancel-in-progress: false')
  })

  it('runs only the stop-lookup R2 exporter with provisioned snapshot resources', () => {
    expect(workflow).toContain('node scripts/transit-snapshot/export-stop-lookup.mjs "$CITY" "$TARGET"')
    expect(workflow).toContain('TRANSIT_DATABASE_ID: ${{ steps.operation.outputs.d1_database_id }}')
    expect(workflow).toContain('TRANSIT_R2_BUCKET_NAME: ${{ steps.operation.outputs.r2_bucket_name }}')
    expect(workflow).toContain('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}')
    expect(workflow).toContain('R2_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}')
    expect(workflow).toContain('R2_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}')
    expect(workflow).toContain('node scripts/instance/assert-operation-city.mjs "$CITY"')
    expect(workflow).toContain('stop_lookup_export_completed')
    expect(workflow).toContain('result.shardBytes.length !== result.shardCount')
    expect(workflow).toContain('result.shardStops.length !== result.shardCount')
    expect(workflow).toContain('shard stop parity mismatch')
    expect(workflow).toContain('Shard bytes min/max/total')
  })

  it('cannot publish snapshots, mutate D1, acquire TDX, or deploy the Worker', () => {
    expect(workflow).not.toContain('snapshot:window')
    expect(workflow).not.toContain('sync-transit-snapshot')
    expect(workflow).not.toContain('wrangler d1')
    expect(workflow).not.toContain('migrations apply')
    expect(workflow).not.toContain('TDX_CLIENT')
    expect(workflow).not.toContain('wrangler deploy')
    expect(workflow).toContain('contents: read')
  })
})
