import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertRollbackSequence,
  parseRollbackRecord,
  readHighCardCounts,
  runRollbackDrill,
  sameHighCardCounts,
} from './run-rollback-drill.mjs'

const source = readFileSync('scripts/transit-snapshot/run-rollback-drill.mjs', 'utf8')

function highCard(overrides = {}) {
  return {
    globalStops: 10,
    globalPatternStops: 20,
    cityStops: 3,
    cityPatternStops: 6,
    stopVersions: [
      { version: 'v1', count: 1 },
      { version: 'v2', count: 2 },
    ],
    patternStopVersions: [
      { version: 'v1', count: 2 },
      { version: 'v2', count: 4 },
    ],
    ...overrides,
  }
}

function snapshot(activeVersion = 'active-v2', previousVersion = 'previous-v1') {
  return {
    authority: { activeVersion, importedAt: '2026-09-10T00:00:00.000Z' },
    state: { activeVersion, previousVersion },
    highCard: highCard(),
  }
}

function authorityWindow(overrides = {}) {
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

describe('snapshot rollback drill evidence helpers', () => {
  it('parses the final rollback operation record without depending on surrounding output', () => {
    const record = parseRollbackRecord([
      'npm noise',
      JSON.stringify({ event: 'snapshot_authority_operation', operation: 'rollback', outcome: 'rolled_back', activeVersion: 'v1' }),
      '',
    ].join('\n'))
    expect(record).toMatchObject({ operation: 'rollback', outcome: 'rolled_back', activeVersion: 'v1' })
  })

  it('compares normalized high-card evidence independent of version row order', () => {
    expect(sameHighCardCounts(
      highCard(),
      highCard({
        stopVersions: [
          { version: 'v2', count: 2 },
          { version: 'v1', count: 1 },
        ],
        patternStopVersions: [
          { version: 'v2', count: 4 },
          { version: 'v1', count: 2 },
        ],
      }),
    )).toBe(true)
    expect(sameHighCardCounts(highCard(), highCard({ globalPatternStops: 21 }))).toBe(false)
  })

  it('treats fully retired high-card tables as stable absence without querying them', async () => {
    const queries = []
    const retired = await readHighCardCounts(async (sql) => {
      queries.push(sql)
      return []
    }, 'Taichung')

    expect(queries).toHaveLength(1)
    expect(queries[0]).toContain('sqlite_schema')
    expect(retired).toEqual({
      schemaState: 'retired',
      globalStops: null,
      globalPatternStops: null,
      cityStops: null,
      cityPatternStops: null,
      stopVersions: [],
      patternStopVersions: [],
    })
    expect(sameHighCardCounts(retired, retired)).toBe(true)
    expect(sameHighCardCounts(retired, highCard())).toBe(false)
  })

  it('fails closed when only one legacy high-card table remains', async () => {
    let queryCount = 0
    await expect(readHighCardCounts(async () => {
      queryCount += 1
      return [{ name: 'stops' }]
    }, 'Taichung')).rejects.toMatchObject({ code: 'partial_high_card_schema' })
    expect(queryCount).toBe(1)
  })

  it('preserves legacy row-count evidence while both high-card tables exist', async () => {
    const responses = [
      [{ name: 'pattern_stops' }, { name: 'stops' }],
      [{ count: 10 }],
      [{ count: 20 }],
      [{ count: 3 }],
      [{ count: 6 }],
      [{ version: 'v2', count: 2 }, { version: 'v1', count: 1 }],
      [{ version: 'v2', count: 4 }, { version: 'v1', count: 2 }],
    ]
    const evidence = await readHighCardCounts(async () => responses.shift(), 'Taichung')
    expect(evidence).toEqual({
      schemaState: 'legacy-present',
      ...highCard(),
    })
    expect(responses).toHaveLength(0)
  })

  it('records the schema-aware rollback report as v2 evidence', () => {
    expect(source).toContain('schemaVersion: 2')
  })

  it('reads the canonical schema-v2 R2 state active pointer from version', () => {
    expect(source).toContain('const activeVersion = safeId(value?.version) ? value.version : null')
    expect(source).not.toContain('const activeVersion = safeId(value?.activeVersion)')
  })

  it('rechecks a fresh root-bound authority window inside the drill process before rollback', () => {
    const authorityGate = source.indexOf('report.authorityWindow = assertRootBoundRollbackWindow')
    const firstRollback = source.indexOf('report.firstRollback = await runRollback(undefined)')
    expect(source).toContain('captureRollbackAuthorityEvidence')
    expect(authorityGate).toBeGreaterThan(-1)
    expect(firstRollback).toBeGreaterThan(authorityGate)
  })

  it('rejects a legacy authority window without invoking rollback', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rollback-drill-legacy-gate-'))
    const reportPath = join(directory, 'report.json')
    let rollbackCalls = 0
    try {
      await expect(runRollbackDrill({
        reportPath,
        captureAuthorityWindow: async () => authorityWindow({
          activeAuthorityMode: 'legacy-backfill',
          previousAuthorityMode: 'legacy-d1',
          rollbackTargetAuthorityMode: 'legacy-d1',
          rootBoundRollbackWindow: false,
        }),
        readSnapshot: async () => snapshot(),
        runRollback: async () => {
          rollbackCalls += 1
          throw new Error('rollback must not run')
        },
      })).rejects.toMatchObject({ code: 'root_bound_window_required' })
      expect(rollbackCalls).toBe(0)
      const report = JSON.parse(await readFile(reportPath, 'utf8'))
      expect(report.errorCode).toBe('root_bound_window_required')
      expect(report.firstRollback).toBeNull()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects an authority pair that changed after the root-bound capture without invoking rollback', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rollback-drill-authority-race-'))
    const reportPath = join(directory, 'report.json')
    let rollbackCalls = 0
    try {
      await expect(runRollbackDrill({
        reportPath,
        captureAuthorityWindow: async () => authorityWindow(),
        readSnapshot: async () => snapshot('new-active-v3', 'active-v2'),
        runRollback: async () => {
          rollbackCalls += 1
          throw new Error('rollback must not run')
        },
      })).rejects.toMatchObject({ code: 'authority_window_changed' })
      expect(rollbackCalls).toBe(0)
      const report = JSON.parse(await readFile(reportPath, 'utf8'))
      expect(report.errorCode).toBe('authority_window_changed')
      expect(report.firstRollback).toBeNull()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('requires a real active-to-previous swap and restoration to the original pair', () => {
    const evidence = {
      before: {
        authority: { activeVersion: 'active-v2' },
        state: { activeVersion: 'active-v2', previousVersion: 'previous-v1' },
      },
      firstRollback: {
        outcome: 'rolled_back', activeVersion: 'previous-v1', previousVersion: 'active-v2',
      },
      afterRollback: {
        authority: { activeVersion: 'previous-v1' },
        state: { activeVersion: 'previous-v1', previousVersion: 'active-v2' },
      },
      restoreRollback: {
        outcome: 'rolled_back', activeVersion: 'active-v2', previousVersion: 'previous-v1',
      },
      afterRestore: {
        authority: { activeVersion: 'active-v2' },
        state: { activeVersion: 'active-v2', previousVersion: 'previous-v1' },
      },
    }
    expect(assertRollbackSequence(evidence)).toBe(true)
    expect(() => assertRollbackSequence({
      ...evidence,
      afterRollback: {
        authority: { activeVersion: 'active-v2' },
        state: { activeVersion: 'active-v2', previousVersion: 'previous-v1' },
      },
    })).toThrow(/did not reflect/)
  })
})
