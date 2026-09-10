import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  captureRollbackAuthorityEvidence,
  parseRollbackStatePointers,
  summarizeAuthorityWindow,
} from './capture-rollback-authority-evidence.mjs'

const workflow = readFileSync('.github/workflows/snapshot-rollback-drill.yml', 'utf8')
const source = readFileSync('scripts/transit-snapshot/capture-rollback-authority-evidence.mjs', 'utf8')

describe('rollback authority evidence', () => {
  it('marks the rollback window root-bound only when both active and previous are root-bound', () => {
    expect(summarizeAuthorityWindow({
      activeVersion: 'active-v2',
      previousVersion: 'previous-v1',
      activeMode: 'root-bound',
      previousMode: 'root-bound',
    })).toEqual({
      activeVersion: 'active-v2',
      previousVersion: 'previous-v1',
      activeAuthorityMode: 'root-bound',
      previousAuthorityMode: 'root-bound',
      rollbackTargetAuthorityMode: 'root-bound',
      rootBoundRollbackWindow: true,
    })

    expect(summarizeAuthorityWindow({
      activeVersion: 'active-v2',
      previousVersion: 'previous-v1',
      activeMode: 'root-bound',
      previousMode: 'legacy-backfill',
    })).toMatchObject({
      rollbackTargetAuthorityMode: 'legacy-backfill',
      rootBoundRollbackWindow: false,
    })
  })

  it('reads the canonical R2 state version field and rejects the obsolete activeVersion shape', () => {
    expect(parseRollbackStatePointers({
      version: 'active-v2',
      previousVersion: 'previous-v1',
      activeVersion: 'wrong-field',
    })).toEqual({
      activeVersion: 'active-v2',
      previousVersion: 'previous-v1',
    })

    expect(parseRollbackStatePointers({
      activeVersion: 'active-v2',
      previousVersion: 'previous-v1',
    })).toEqual({
      activeVersion: null,
      previousVersion: 'previous-v1',
    })
  })

  it('rejects unknown modes and invalid rollback pairs', () => {
    expect(() => summarizeAuthorityWindow({
      activeVersion: 'v2', previousVersion: 'v1', activeMode: 'r2', previousMode: 'root-bound',
    })).toThrow(/unknown authority mode/)
    expect(() => summarizeAuthorityWindow({
      activeVersion: 'v1', previousVersion: 'v1', activeMode: 'root-bound', previousMode: 'root-bound',
    })).toThrow(/distinct safe active and previous/)
  })

  it('writes bounded, explicit evidence from an injected production window observation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rollback-authority-evidence-'))
    const reportPath = join(directory, 'authority-window.json')
    try {
      const report = await captureRollbackAuthorityEvidence({
        reportPath,
        env: { GITHUB_SHA: 'abc123', GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1' },
        now: () => new Date('2026-09-09T00:00:00.000Z'),
        readWindow: async () => ({
          activeVersion: 'active-v2',
          previousVersion: 'previous-v1',
          activeMode: 'root-bound',
          previousMode: 'legacy-d1',
        }),
      })
      expect(report).toMatchObject({
        kind: 'snapshot-rollback-authority-window',
        rollbackTargetAuthorityMode: 'legacy-d1',
        rootBoundRollbackWindow: false,
        sourceCommit: 'abc123',
      })
      await expect(readFile(reportPath, 'utf8')).resolves.toContain('"previousAuthorityMode": "legacy-d1"')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('reuses the production rollback authority contract and stays observation-only', () => {
    expect(source).toContain('readRollbackRoutingAuthority')
    expect(source).toContain('bindRollbackRoutingAuthority')
    expect(source).toContain('readManifestJson')
    expect(source).toContain('safeId(state?.version)')
    expect(source).not.toContain('safeId(state?.activeVersion)')
    expect(source).not.toMatch(/(?:INSERT\s+INTO|DELETE\s+FROM|UPDATE)\s+(?:stops|pattern_stops)\b/i)
    expect(source).not.toContain('sync-transit-snapshot')
    expect(source).not.toContain('run-snapshot-window')
  })

  it('is captured by the existing manual rollback workflow before mutation', () => {
    const capture = workflow.indexOf('capture-rollback-authority-evidence.mjs Taichung')
    const rollback = workflow.indexOf('run-rollback-drill.mjs Taichung')
    expect(capture).toBeGreaterThan(-1)
    expect(rollback).toBeGreaterThan(capture)
    expect(workflow).toContain('authority-window.json')
  })
})
