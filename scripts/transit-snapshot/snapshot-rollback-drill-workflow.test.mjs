import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const workflow = readFileSync('.github/workflows/snapshot-rollback-drill.yml', 'utf8')
const rollbackSource = readFileSync('scripts/transit-snapshot/rollback.mjs', 'utf8')
const drillSource = readFileSync('scripts/transit-snapshot/run-rollback-drill.mjs', 'utf8')
const authorityGateSource = readFileSync('scripts/transit-snapshot/assert-root-bound-rollback-window.mjs', 'utf8')

describe('snapshot rollback drill workflow', () => {
  it('is manual-only, main-only, Taichung-only, and explicitly confirmed', () => {
    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).toContain('confirmation:')
    expect(workflow).toContain("test \"${GITHUB_REF}\" = 'refs/heads/main'")
    expect(workflow).toContain("test \"${INPUT_CONFIRMATION}\" = 'ROLLBACK_TAICHUNG'")
    expect(workflow).toContain('run-rollback-drill.mjs Taichung')
    expect(workflow).not.toMatch(/\n\s+push:/)
    expect(workflow).not.toContain('schedule:')
  })

  it('serializes with publication and does not require TDX, force publishing, or publisher execution', () => {
    expect(workflow).toMatch(/concurrency:\s*\n\s*group: transit-snapshot/)
    expect(workflow).toContain('cancel-in-progress: false')
    expect(workflow).not.toContain('TDX_CLIENT_ID')
    expect(workflow).not.toContain('TDX_CLIENT_SECRET')
    expect(workflow).not.toContain('SNAPSHOT_FORCE')
    expect(workflow).not.toContain('snapshot:city')
    expect(workflow).not.toContain('snapshot:window')
    expect(drillSource).not.toContain('sync-transit-snapshot')
    expect(drillSource).not.toContain('run-snapshot-window')
    expect(drillSource).not.toContain('snapshot:city')
    expect(drillSource).not.toContain('snapshot:window')
  })

  it('fails closed unless the captured production window is fully root-bound before mutation', () => {
    const capture = workflow.indexOf('capture-rollback-authority-evidence.mjs Taichung')
    const gate = workflow.indexOf('assert-root-bound-rollback-window.mjs')
    const rollback = workflow.indexOf('run-rollback-drill.mjs Taichung')
    expect(capture).toBeGreaterThan(-1)
    expect(gate).toBeGreaterThan(capture)
    expect(rollback).toBeGreaterThan(gate)
    expect(authorityGateSource).toContain('report.rootBoundRollbackWindow !== true')
    expect(authorityGateSource).toContain("report.activeAuthorityMode !== 'root-bound'")
    expect(authorityGateSource).toContain("report.previousAuthorityMode !== 'root-bound'")
    expect(authorityGateSource).toContain("report.rollbackTargetAuthorityMode !== 'root-bound'")
  })

  it('uploads bounded evidence even when the drill fails', () => {
    expect(workflow).toContain('if: always()')
    expect(workflow).toContain('snapshot-rollback-drill/report.json')
    expect(workflow).toContain('if-no-files-found: error')
    expect(workflow).toContain('retention-days: 14')
  })

  it('keeps high-cardinality tables read-only in both rollback and drill code', () => {
    const forbidden = /(?:INSERT\s+INTO|DELETE\s+FROM|UPDATE)\s+(?:stops|pattern_stops)\b/i
    expect(rollbackSource).not.toMatch(forbidden)
    expect(drillSource).not.toMatch(forbidden)
    expect(drillSource).toContain('SELECT COUNT(*) AS count FROM stops')
    expect(drillSource).toContain('SELECT COUNT(*) AS count FROM pattern_stops')
  })
})
