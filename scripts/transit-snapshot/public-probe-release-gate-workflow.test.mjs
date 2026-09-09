import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const workflow = readFileSync('.github/workflows/public-probe.yml', 'utf8')

describe('public probe push release gate workflow', () => {
  it('waits for the exact pushed Worker release before probing', () => {
    expect(workflow).toContain('- name: Wait for pushed Worker release')
    expect(workflow).toContain("if: github.event_name == 'push' && steps.operation.outputs.enabled == 'true'")
    expect(workflow).toContain('EXPECTED_RELEASE_SHA: ${{ github.sha }}')
    expect(workflow).toContain('node scripts/transit-snapshot/wait-public-release.mjs')
    expect(workflow).toContain(
      'SNAPSHOT_SMOKE_BASE_URL: ${{ steps.operation.outputs.public_origin || vars.SNAPSHOT_SMOKE_BASE_URL }}',
    )
  })

  it('keeps migration before the release gate and the probe after it', () => {
    const migration = workflow.indexOf('- name: Apply transit database migrations')
    const releaseGate = workflow.indexOf('- name: Wait for pushed Worker release')
    const probe = workflow.indexOf('- name: Probe the public surface for every enabled city')
    expect(migration).toBeGreaterThan(-1)
    expect(releaseGate).toBeGreaterThan(migration)
    expect(probe).toBeGreaterThan(releaseGate)
  })

  it('re-runs when the release gate implementation changes', () => {
    expect(workflow).toContain("- 'scripts/transit-snapshot/wait-public-release.mjs'")
  })
})
