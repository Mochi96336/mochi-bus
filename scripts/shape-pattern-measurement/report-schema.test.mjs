import { describe, expect, it } from 'vitest'
import { HARNESS_VERSION, REPORT_FILES, REPORT_SCHEMA_VERSION } from './constants.mjs'
import { SUMMARY_METRIC_FIELDS } from './report-analysis.mjs'
import { validateCompletionManifest, validateDistributionTree } from './report-schema.mjs'

const zeroDistribution = () => ({
  count: 0, min: null, median: null, p75: null, p90: null, p95: null, p99: null, max: null,
})

function validSummary() {
  return Object.fromEntries(SUMMARY_METRIC_FIELDS.map((key) => [key, zeroDistribution()]))
}

function validCompletion() {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    runId: 'instrumented-test-run',
    mode: 'instrumented',
    matcherSourceSha256: '2'.repeat(64),
    matcherSourceGitBlobSha1: '3'.repeat(40),
    bundleContentHash: '4'.repeat(64),
    selectedCities: ['Taipei'],
    includeIntercity: false,
    harnessVersion: HARNESS_VERSION,
    reportFiles: Object.fromEntries(REPORT_FILES.map((file, index) => [file, String(index + 1).repeat(64)])),
    publishedAt: '2026-07-23T00:00:00.000Z',
  }
}

describe('measurement report schema v3', () => {
  it('requires the exact formal summary field set', () => {
    expect(() => validateDistributionTree(validSummary())).not.toThrow()

    const missing = validSummary()
    delete missing.patternCount
    expect(() => validateDistributionTree(missing)).toThrow(/fields mismatch/)

    const extra = validSummary()
    extra.unknown = zeroDistribution()
    expect(() => validateDistributionTree(extra)).toThrow(/fields mismatch/)
  })

  it('rejects invented zero values for unavailable distributions', () => {
    const summary = validSummary()
    summary.pairLatencyMs.min = 0
    expect(() => validateDistributionTree(summary)).toThrow(/null metrics/)
  })

  it('requires every completion identity and report hash', () => {
    expect(() => validateCompletionManifest(validCompletion())).not.toThrow()
    for (const field of ['matcherSourceGitBlobSha1', 'selectedCities', 'includeIntercity', 'harnessVersion']) {
      const completion = validCompletion()
      delete completion[field]
      expect(() => validateCompletionManifest(completion)).toThrow(/fields mismatch/)
    }
    const missingHash = validCompletion()
    delete missingHash.reportFiles['summary.json']
    expect(() => validateCompletionManifest(missingHash)).toThrow(/reportFiles/)
  })

  it.each(['../outside', 'x/../../outside', 'C:\\outside', '.', '..', ' spaced '])('rejects unsafe completion runId %s', (runId) => {
    const completion = validCompletion()
    completion.runId = runId
    expect(() => validateCompletionManifest(completion)).toThrow(/runId/)
  })
})
