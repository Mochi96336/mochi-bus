import { describe, expect, it } from 'vitest'
import { assertRootBoundRollbackWindow } from './assert-root-bound-rollback-window.mjs'

function report(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: 'snapshot-rollback-authority-window',
    city: 'Taichung',
    activeVersion: 'active-v2',
    previousVersion: 'previous-v1',
    activeAuthorityMode: 'root-bound',
    previousAuthorityMode: 'root-bound',
    rollbackTargetAuthorityMode: 'root-bound',
    rootBoundRollbackWindow: true,
    ...overrides,
  }
}

describe('root-bound rollback drill authority gate', () => {
  it('accepts only a fully root-bound Taichung rollback window', () => {
    expect(assertRootBoundRollbackWindow(report())).toMatchObject({
      activeAuthorityMode: 'root-bound',
      previousAuthorityMode: 'root-bound',
      rollbackTargetAuthorityMode: 'root-bound',
      rootBoundRollbackWindow: true,
    })
  })

  it('rejects legacy rollback targets before the drill can mutate production', () => {
    expect(() => assertRootBoundRollbackWindow(report({
      activeAuthorityMode: 'legacy-backfill',
      previousAuthorityMode: 'legacy-d1',
      rollbackTargetAuthorityMode: 'legacy-d1',
      rootBoundRollbackWindow: false,
    }))).toThrow('root_bound_window_required')
  })

  it('does not trust the summary boolean when the authority modes disagree', () => {
    expect(() => assertRootBoundRollbackWindow(report({
      previousAuthorityMode: 'legacy-d1',
      rollbackTargetAuthorityMode: 'legacy-d1',
      rootBoundRollbackWindow: true,
    }))).toThrow('root_bound_window_required')
  })

  it('rejects malformed or self-referential evidence', () => {
    expect(() => assertRootBoundRollbackWindow(null)).toThrow('invalid_evidence_report')
    expect(() => assertRootBoundRollbackWindow(report({ previousVersion: 'active-v2' }))).toThrow('invalid_evidence_report')
  })
})
