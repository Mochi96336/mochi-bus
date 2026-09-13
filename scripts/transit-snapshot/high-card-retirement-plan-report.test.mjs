import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  collectHighCardRetirementPlanEvidence,
  normalizeProvenance,
} from './high-card-retirement-plan-report.mjs'

const sha = 'a'.repeat(40)
const env = Object.freeze({
  GITHUB_SHA: sha,
  GITHUB_RUN_ID: '34762456795',
  GITHUB_RUN_ATTEMPT: '1',
})

function provenance(overrides = {}) {
  return {
    sourceCommit: sha,
    workflowRunId: '34762456795',
    workflowRunAttempt: '1',
    generatedAt: '2026-09-13T14:23:00.000Z',
    ...overrides,
  }
}

function schemaInventory(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: 'snapshot-high-card-d1-schema-inventory',
    ...provenance(),
    schemaState: 'legacy-present',
    tablesPresent: ['pattern_stops', 'stops'],
    ownedObjects: [
      { type: 'table', name: 'pattern_stops', table: 'pattern_stops' },
      { type: 'index', name: 'pattern_stops_place_idx', table: 'pattern_stops' },
      { type: 'table', name: 'stops', table: 'stops' },
      { type: 'index', name: 'stops_name_idx', table: 'stops' },
      { type: 'index', name: 'stops_place_idx', table: 'stops' },
    ],
    missingExpectedObjects: [],
    unexpectedOwnedObjects: [],
    externalDependencies: [],
    schemaMatchesExpectedLegacyShape: true,
    dependencyClear: true,
    ...overrides,
  }
}

function authorityReadiness(overrides = {}) {
  return {
    schemaVersion: 2,
    kind: 'snapshot-high-card-d1-retirement-readiness',
    ...provenance({ generatedAt: '2026-09-13T14:23:05.000Z' }),
    cityCount: 2,
    rootBoundCityCount: 0,
    rootBoundAuthorityReady: false,
    blockingCities: [{ city: 'Taichung' }, { city: 'Taipei' }],
    cities: [
      { city: 'Taichung', rootBoundRollbackWindow: false },
      { city: 'Taipei', rootBoundRollbackWindow: false },
    ],
    ...overrides,
  }
}

describe('high-card retirement plan evidence', () => {
  it('binds the combined plan to one exact workflow attempt', () => {
    const evidence = collectHighCardRetirementPlanEvidence({
      schemaInventory: schemaInventory(),
      authorityReadiness: authorityReadiness(),
      env,
      now: () => new Date('2026-09-13T14:23:10.000Z'),
    })

    expect(evidence).toMatchObject({
      schemaVersion: 1,
      kind: 'snapshot-high-card-d1-retirement-plan-evidence',
      sourceCommit: sha,
      workflowRunId: '34762456795',
      workflowRunAttempt: '1',
      generatedAt: '2026-09-13T14:23:10.000Z',
      inputEvidence: {
        schemaInventoryGeneratedAt: '2026-09-13T14:23:00.000Z',
        authorityReadinessGeneratedAt: '2026-09-13T14:23:05.000Z',
      },
      plan: {
        planningState: 'blocked',
        destructiveExecutionAuthorized: false,
        blockers: ['root_bound_authority_not_ready'],
      },
    })
  })

  it('rejects a report from another commit, run, or retry attempt', () => {
    expect(() => collectHighCardRetirementPlanEvidence({
      schemaInventory: schemaInventory({ sourceCommit: 'b'.repeat(40) }),
      authorityReadiness: authorityReadiness(),
      env,
    })).toThrow('schema inventory provenance does not match the current workflow')

    expect(() => collectHighCardRetirementPlanEvidence({
      schemaInventory: schemaInventory(),
      authorityReadiness: authorityReadiness({ workflowRunId: '34762456794' }),
      env,
    })).toThrow('authority readiness provenance does not match the current workflow')

    expect(() => collectHighCardRetirementPlanEvidence({
      schemaInventory: schemaInventory(),
      authorityReadiness: authorityReadiness({ workflowRunAttempt: '2' }),
      env,
    })).toThrow('authority readiness provenance does not match the current workflow')
  })

  it('rejects missing or non-canonical provenance instead of accepting stale evidence', () => {
    expect(() => normalizeProvenance({
      ...provenance(),
      generatedAt: '2026-09-13 14:23:00Z',
    }, 'test report')).toThrow('test report provenance is invalid')

    expect(() => collectHighCardRetirementPlanEvidence({
      schemaInventory: schemaInventory(),
      authorityReadiness: authorityReadiness(),
      env: { ...env, GITHUB_RUN_ID: '' },
    })).toThrow('requires GitHub workflow provenance')
  })

  it('keeps the evidence wrapper free of production credentials, network access, and mutation SQL', async () => {
    const source = await readFile(new URL('./high-card-retirement-plan-report.mjs', import.meta.url), 'utf8')
    expect(source).not.toContain('CLOUDFLARE_API_TOKEN')
    expect(source).not.toContain('R2_ACCESS_KEY_ID')
    expect(source).not.toContain('R2_SECRET_ACCESS_KEY')
    expect(source).not.toContain('queryD1')
    expect(source).not.toContain('fetch(')
    expect(source).not.toMatch(/\bDROP\s+(?:TABLE|INDEX)\b/i)
    expect(source).not.toMatch(/\bDELETE\s+FROM\b/i)
  })

  it('wires the combined plan after both read-only evidence producers and uploads it', async () => {
    const workflow = await readFile(new URL('../../.github/workflows/snapshot-high-card-retirement-readiness.yml', import.meta.url), 'utf8')
    const inventory = workflow.indexOf('run: node scripts/transit-snapshot/high-card-retirement-schema-inventory.mjs')
    const readiness = workflow.indexOf('run: node scripts/transit-snapshot/high-card-retirement-readiness.mjs')
    const plan = workflow.indexOf('run: node scripts/transit-snapshot/high-card-retirement-plan-report.mjs')
    const upload = workflow.indexOf('Upload retirement readiness evidence')

    expect(inventory).toBeGreaterThan(-1)
    expect(readiness).toBeGreaterThan(inventory)
    expect(plan).toBeGreaterThan(readiness)
    expect(upload).toBeGreaterThan(plan)
    expect(workflow).toContain('.transit-snapshot/high-card-retirement-plan.json')
    expect(workflow).toContain("scripts/transit-snapshot/high-card-retirement-plan-report.mjs")
    expect(workflow).toContain("scripts/transit-snapshot/high-card-retirement-plan-report.test.mjs")
    expect(workflow).not.toContain('RUN_TAICHUNG')
    expect(workflow).not.toContain('MEASURE_RESOURCES')
    expect(workflow).not.toContain('ROLLBACK_TAICHUNG')
  })
})
