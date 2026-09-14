import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { summarizeScheduledD1WriteEvidence } from './summarize-scheduled-d1-write-evidence.mjs'

const sha = 'a'.repeat(40)
const date = '2026-09-18' // Friday: the production shard contains Taichung only.
const windowId = `v1:Taichung:${date}:0317`
const env = {
  GITHUB_RUN_ID: '123456789',
  GITHUB_RUN_ATTEMPT: '1',
  GITHUB_SHA: sha,
  SNAPSHOT_D1_WRITE_BUDGET: '75000',
}

function summary(result = 'published') {
  return {
    schemaVersion: 2,
    city: 'Taichung',
    windowId,
    result,
    activeVersion: '20260918T031700000Z',
    previousVersion: '20260911T031700000Z',
    lastSourceCheckAt: '2026-09-18T03:20:00.000Z',
    lastPublishedAt: result === 'published' ? '2026-09-18T03:25:00.000Z' : '2026-09-11T03:25:00.000Z',
    failureClass: 'none',
    durableRecordWrite: 'success',
    activeProbeResult: 'success',
    rollbackAvailable: true,
    probeFailureClass: 'none',
    diagnosticWarnings: [],
  }
}

function record(rowsWritten = 1200, overrides = {}) {
  return {
    schemaVersion: 1,
    event: 'snapshot_d1_observed_write',
    city: 'Taichung',
    windowId,
    workflowRunId: env.GITHUB_RUN_ID,
    workflowRunAttempt: 1,
    scriptGitSha: sha,
    recordedAt: '2026-09-18T03:23:00.000Z',
    phase: 'stage',
    sourceFile: 'import-0.sql',
    rowsWritten,
    rowsRead: 10,
    queryCount: 4,
    durationMs: 12.5,
    ...overrides,
  }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'scheduled-d1-evidence-'))
  const summaries = join(root, 'window-results')
  mkdirSync(summaries)
  return { root, summaries, observed: join(root, 'observed.jsonl') }
}

describe('scheduled D1 write shard evidence', () => {
  it('accepts a complete real published shard with observed committed rows', async () => {
    const files = fixture()
    try {
      writeFileSync(join(files.summaries, 'Taichung.json'), JSON.stringify(summary()))
      writeFileSync(files.observed, `${JSON.stringify(record(1200))}\n${JSON.stringify(record(50, {
        phase: 'cleanup', sourceFile: 'cleanup.sql', recordedAt: '2026-09-18T03:24:00.000Z',
      }))}\n`)
      const evidence = await summarizeScheduledD1WriteEvidence({
        summaryRoot: files.summaries,
        observedFile: files.observed,
        env,
      })
      expect(evidence).toMatchObject({
        scheduleDate: date,
        workflowRunId: '123456789',
        scriptGitSha: sha,
        expectedCities: ['Taichung'],
        actualCities: ['Taichung'],
        totalRowsWritten: 1250,
        headroom: 73750,
        publishedCount: 1,
        unchangedCount: 0,
        exactCitySet: true,
        shardAcceptanceEvidence: true,
      })
      expect(evidence.cities[0]).toMatchObject({
        city: 'Taichung',
        stageRowsWritten: 1200,
        cleanupRowsWritten: 50,
        rowsWritten: 1250,
        observedExecutions: 2,
        successfulWindow: true,
        metricsComplete: true,
      })
    } finally {
      rmSync(files.root, { recursive: true, force: true })
    }
  })

  it('treats a healthy unchanged scheduled window as zero publisher writes', async () => {
    const files = fixture()
    try {
      writeFileSync(join(files.summaries, 'Taichung.json'), JSON.stringify(summary('unchanged')))
      const evidence = await summarizeScheduledD1WriteEvidence({
        summaryRoot: files.summaries,
        observedFile: files.observed,
        env,
      })
      expect(evidence.totalRowsWritten).toBe(0)
      expect(evidence.unchangedCount).toBe(1)
      expect(evidence.shardAcceptanceEvidence).toBe(true)
    } finally {
      rmSync(files.root, { recursive: true, force: true })
    }
  })

  it('does not accept a published window without observed D1 execution metrics', async () => {
    const files = fixture()
    try {
      writeFileSync(join(files.summaries, 'Taichung.json'), JSON.stringify(summary()))
      const evidence = await summarizeScheduledD1WriteEvidence({
        summaryRoot: files.summaries,
        observedFile: files.observed,
        env,
      })
      expect(evidence.cities[0].metricsComplete).toBe(false)
      expect(evidence.shardAcceptanceEvidence).toBe(false)
    } finally {
      rmSync(files.root, { recursive: true, force: true })
    }
  })

  it('rejects observed metrics from another workflow run', async () => {
    const files = fixture()
    try {
      writeFileSync(join(files.summaries, 'Taichung.json'), JSON.stringify(summary()))
      writeFileSync(files.observed, `${JSON.stringify(record(10, { workflowRunId: '987654321' }))}\n`)
      await expect(summarizeScheduledD1WriteEvidence({
        summaryRoot: files.summaries,
        observedFile: files.observed,
        env,
      })).rejects.toThrow(/provenance/)
    } finally {
      rmSync(files.root, { recursive: true, force: true })
    }
  })

  it('keeps a completed shard non-acceptable when observed writes exceed the publisher ledger', async () => {
    const files = fixture()
    try {
      writeFileSync(join(files.summaries, 'Taichung.json'), JSON.stringify(summary()))
      writeFileSync(files.observed, `${JSON.stringify(record(75001))}\n`)
      const evidence = await summarizeScheduledD1WriteEvidence({
        summaryRoot: files.summaries,
        observedFile: files.observed,
        env,
      })
      expect(evidence.totalRowsWritten).toBe(75001)
      expect(evidence.headroom).toBe(-1)
      expect(evidence.shardAcceptanceEvidence).toBe(false)
    } finally {
      rmSync(files.root, { recursive: true, force: true })
    }
  })
})
