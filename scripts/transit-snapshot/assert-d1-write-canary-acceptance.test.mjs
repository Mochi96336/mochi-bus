import { describe, expect, it } from 'vitest'
import { assertD1WriteCanaryAcceptance } from './assert-d1-write-canary-acceptance.mjs'

const sourceCommit = 'a'.repeat(40)
const workflowRunId = '123456789'

function publishedEvidence(overrides = {}) {
  return {
    schemaVersion: 1,
    event: 'snapshot_d1_write_evidence',
    sourceCommit,
    workflowRunId,
    city: 'Taichung',
    result: 'published',
    acceptanceEvidence: true,
    stage: {
      routes: { logicalRows: 10, rowsWritten: 30, rowsRead: 1, queries: 1, segments: 1 },
      patterns: { logicalRows: 20, rowsWritten: 60, rowsRead: 1, queries: 1, segments: 1 },
      stop_places: { logicalRows: 30, rowsWritten: 90, rowsRead: 1, queries: 1, segments: 1 },
    },
    ...overrides,
  }
}

const options = {
  expectedCity: 'Taichung',
  expectedSourceCommit: sourceCommit,
  expectedWorkflowRunId: workflowRunId,
}

describe('D1 write canary acceptance gate', () => {
  it('accepts a current-run published Taichung report with complete low-cardinality telemetry', () => {
    const report = publishedEvidence()
    expect(assertD1WriteCanaryAcceptance(report, options)).toBe(report)
  })

  it('rejects a successful but unchanged publication window', () => {
    expect(() => assertD1WriteCanaryAcceptance(publishedEvidence({
      result: 'unchanged',
      acceptanceEvidence: false,
    }), options)).toThrow(/published acceptance evidence/)
  })

  it('rejects stale or cross-run evidence', () => {
    expect(() => assertD1WriteCanaryAcceptance(publishedEvidence({ sourceCommit: 'b'.repeat(40) }), options))
      .toThrow(/source commit/)
    expect(() => assertD1WriteCanaryAcceptance(publishedEvidence({ workflowRunId: '987654321' }), options))
      .toThrow(/workflow run/)
  })

  it('rejects the wrong city and incomplete published table telemetry', () => {
    expect(() => assertD1WriteCanaryAcceptance(publishedEvidence({ city: 'Taipei' }), options))
      .toThrow(/city/)
    expect(() => assertD1WriteCanaryAcceptance(publishedEvidence({
      stage: {
        ...publishedEvidence().stage,
        stop_places: { logicalRows: 30, rowsWritten: 0, rowsRead: 1, queries: 1, segments: 1 },
      },
    }), options)).toThrow(/stop_places/)
  })
})
