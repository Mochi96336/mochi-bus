import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const workflow = readFileSync(new URL('../../.github/workflows/snapshot-d1-write-canary.yml', import.meta.url), 'utf8')

describe('snapshot D1 write canary workflow', () => {
  it('is manual-only, main-only, and requires an explicit Taichung confirmation', () => {
    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).toContain('confirmation:')
    expect(workflow).toContain("test \"${GITHUB_REF}\" = 'refs/heads/main'")
    expect(workflow).toContain("test \"${INPUT_CONFIRMATION}\" = 'RUN_TAICHUNG'")
    expect(workflow).not.toContain('schedule:')
    expect(workflow).not.toMatch(/\n\s+push:/)
  })

  it('serializes with normal snapshot publication and cannot force a source change', () => {
    expect(workflow).toContain('group: transit-snapshot')
    expect(workflow).toContain('npm run snapshot:window -- Taichung')
    expect(workflow).toContain("SNAPSHOT_D1_WRITE_BUDGET: '75000'")
    expect(workflow).not.toContain('SNAPSHOT_FORCE')
  })

  it('keeps bounded diagnostics and uploads the non-hidden raw telemetry', () => {
    expect(workflow).toContain('NODE_OPTIONS: --import=./scripts/transit-snapshot/install-d1-write-telemetry.mjs')
    expect(workflow).toContain("SNAPSHOT_D1_WRITE_TELEMETRY: '1'")
    expect(workflow).toContain('SNAPSHOT_D1_WRITE_TELEMETRY_FILE: snapshot-d1-write-telemetry.jsonl')
    expect(workflow).not.toContain('.transit-snapshot/d1-write-telemetry.jsonl')
    expect(workflow).toContain('summarize-d1-write-telemetry.mjs')
    expect(workflow).toContain('actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02')
    expect(workflow).toContain('retention-days: 14')
  })
})
