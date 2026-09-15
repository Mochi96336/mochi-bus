import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const workflow = readFileSync(new URL('../../.github/workflows/sync-transit.yml', import.meta.url), 'utf8')

describe('scheduled D1 write evidence workflow contract', () => {
  it('observes whole-file D1 writes only on scheduled runs', () => {
    expect(workflow).toContain("NODE_OPTIONS: ${{ github.event_name == 'schedule' && '--import=./scripts/transit-snapshot/install-observed-d1-write.mjs' || '' }}")
    expect(workflow).toContain("SNAPSHOT_D1_OBSERVED_WRITE: ${{ github.event_name == 'schedule' && '1' || '' }}")
    expect(workflow).toContain('SNAPSHOT_D1_OBSERVED_WRITE_FILE: snapshot-scheduled-d1-write-observed.jsonl')
    expect(workflow).toContain('export SNAPSHOT_D1_OBSERVED_WRITE_CITY="$city"')
    expect(workflow).not.toContain('SNAPSHOT_D1_WRITE_TELEMETRY:')
    expect(workflow).not.toContain('install-d1-write-telemetry.mjs')
  })

  it('builds and uploads bounded evidence after publication without enforcing it on production', () => {
    const publish = workflow.indexOf('name: Build and publish snapshot')
    const summarize = workflow.indexOf('name: Build scheduled D1 write evidence')
    const upload = workflow.indexOf('name: Upload scheduled D1 write evidence')
    const cleanup = workflow.indexOf('name: Cleanup shared TDX snapshot token')
    expect(publish).toBeGreaterThan(-1)
    expect(summarize).toBeGreaterThan(publish)
    expect(upload).toBeGreaterThan(summarize)
    expect(cleanup).toBeGreaterThan(upload)
    expect(workflow).toContain("if: always() && github.event_name == 'schedule' && steps.operation.outputs.enabled == 'true'")
    expect(workflow).toContain('summarize-scheduled-d1-write-evidence.mjs')
    expect(workflow).toContain('snapshot-scheduled-d1-write-${{ github.run_id }}-${{ github.run_attempt }}')
    expect(workflow).toContain('actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02')
    expect(workflow).toContain('retention-days: 14')

    const summaryBlock = workflow.slice(summarize, upload)
    const uploadBlock = workflow.slice(upload, cleanup)
    expect(summaryBlock).toContain('continue-on-error: true')
    expect(uploadBlock).toContain('continue-on-error: true')
  })
})
