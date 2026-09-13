import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  buildHighCardRetirementPlan,
  remainingHighCardRetirementGates,
} from './high-card-retirement-plan.mjs'

function legacyOwnedObjects() {
  return [
    { type: 'table', name: 'pattern_stops', table: 'pattern_stops' },
    { type: 'index', name: 'sqlite_autoindex_pattern_stops_1', table: 'pattern_stops' },
    { type: 'index', name: 'pattern_stops_place_idx', table: 'pattern_stops' },
    { type: 'table', name: 'stops', table: 'stops' },
    { type: 'index', name: 'sqlite_autoindex_stops_1', table: 'stops' },
    { type: 'index', name: 'stops_name_idx', table: 'stops' },
    { type: 'index', name: 'stops_place_idx', table: 'stops' },
  ]
}

function schemaInventory(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: 'snapshot-high-card-d1-schema-inventory',
    schemaState: 'legacy-present',
    tablesPresent: ['pattern_stops', 'stops'],
    ownedObjects: legacyOwnedObjects(),
    missingExpectedObjects: [],
    unexpectedOwnedObjects: [],
    externalDependencies: [],
    schemaMatchesExpectedLegacyShape: true,
    dependencyClear: true,
    ...overrides,
  }
}

function authorityCount(mode) {
  if (mode === 'legacy-d1') return 0
  if (mode === 'legacy-partial') return 2
  return 4
}

function authorityCity(city, {
  activeMode = 'legacy-backfill',
  previousMode = 'legacy-d1',
} = {}) {
  const rootBoundRollbackWindow = activeMode === 'root-bound' && previousMode === 'root-bound'
  const nativeRootBoundPublicationsRequired = activeMode === 'root-bound'
    ? (previousMode === 'root-bound' ? 0 : 1)
    : 2
  return {
    city,
    activeVersion: `${city}-active`,
    previousVersion: `${city}-previous`,
    activeAuthorityMode: activeMode,
    previousAuthorityMode: previousMode,
    rollbackTargetAuthorityMode: previousMode,
    activeRoutingManifestCount: authorityCount(activeMode),
    previousRoutingManifestCount: authorityCount(previousMode),
    rootBoundRollbackWindow,
    nativeRootBoundPublicationsRequired,
  }
}

function blockingCity(city) {
  return {
    city: city.city,
    activeVersion: city.activeVersion,
    previousVersion: city.previousVersion,
    activeAuthorityMode: city.activeAuthorityMode,
    previousAuthorityMode: city.previousAuthorityMode,
    activeRoutingManifestCount: city.activeRoutingManifestCount,
    previousRoutingManifestCount: city.previousRoutingManifestCount,
    nativeRootBoundPublicationsRequired: city.nativeRootBoundPublicationsRequired,
  }
}

function authorityReadiness(overrides = {}) {
  const cities = [authorityCity('Taichung'), authorityCity('Taipei')]
  return {
    schemaVersion: 2,
    kind: 'snapshot-high-card-d1-retirement-readiness',
    cityCount: cities.length,
    rootBoundCityCount: 0,
    rootBoundAuthorityReady: false,
    blockingCities: cities.map(blockingCity),
    cities,
    ...overrides,
  }
}

function allRootBoundAuthority() {
  const cities = [
    authorityCity('Taichung', { activeMode: 'root-bound', previousMode: 'root-bound' }),
    authorityCity('Taipei', { activeMode: 'root-bound', previousMode: 'root-bound' }),
  ]
  return authorityReadiness({
    rootBoundCityCount: cities.length,
    rootBoundAuthorityReady: true,
    blockingCities: [],
    cities,
  })
}

describe('high-card retirement plan gate', () => {
  it('blocks the current clean-schema state while retained authority is incomplete', () => {
    const plan = buildHighCardRetirementPlan({
      schemaInventory: schemaInventory(),
      authorityReadiness: authorityReadiness(),
      now: () => new Date('2026-09-13T10:00:00.000Z'),
    })

    expect(plan).toMatchObject({
      schemaVersion: 1,
      kind: 'snapshot-high-card-d1-retirement-plan',
      generatedAt: '2026-09-13T10:00:00.000Z',
      planningState: 'blocked',
      destructiveExecutionAuthorized: false,
      blockers: ['root_bound_authority_not_ready'],
      schema: {
        state: 'legacy-present',
        dependencyClear: true,
        matchesExpectedLegacyShape: true,
        externalDependencyCount: 0,
      },
      authority: {
        cityCount: 2,
        rootBoundCityCount: 0,
        rootBoundAuthorityReady: false,
        blockingCities: [{ city: 'Taichung' }, { city: 'Taipei' }],
      },
    })
    expect(plan.candidateObjects.map((entry) => entry.name)).toEqual([
      'pattern_stops_place_idx',
      'sqlite_autoindex_pattern_stops_1',
      'pattern_stops',
      'sqlite_autoindex_stops_1',
      'stops_name_idx',
      'stops_place_idx',
      'stops',
    ])
    expect(plan.remainingAcceptanceGates).toEqual(remainingHighCardRetirementGates)
  })

  it('never turns schema plus root-bound authority into destructive authorization', () => {
    const plan = buildHighCardRetirementPlan({
      schemaInventory: schemaInventory(),
      authorityReadiness: allRootBoundAuthority(),
    })

    expect(plan.planningState).toBe('authority-and-schema-ready')
    expect(plan.blockers).toEqual([])
    expect(plan.destructiveExecutionAuthorized).toBe(false)
    expect(plan.remainingAcceptanceGates).toEqual([
      'changed_large_city_rows_written_acceptance',
      'worker_resource_measurement_acceptance',
      'taichung_rollback_drill_acceptance',
      'full_weekly_shard_acceptance',
      'explicit_mutation_authorization',
    ])
  })

  it('fails closed on partial schema and external dependencies', () => {
    const plan = buildHighCardRetirementPlan({
      schemaInventory: schemaInventory({
        schemaState: 'partial',
        tablesPresent: ['stops'],
        ownedObjects: legacyOwnedObjects().filter((entry) => entry.table === 'stops'),
        schemaMatchesExpectedLegacyShape: false,
        dependencyClear: false,
        externalDependencies: [{ type: 'view', name: 'legacy_view', table: 'legacy_view' }],
      }),
      authorityReadiness: allRootBoundAuthority(),
    })

    expect(plan.planningState).toBe('blocked')
    expect(plan.blockers).toEqual(['schema_partial', 'schema_dependency_not_clear'])
    expect(plan.candidateObjects).toEqual([])
    expect(plan.destructiveExecutionAuthorized).toBe(false)
  })

  it('blocks schema drift even when dependencies and authority are otherwise clear', () => {
    const plan = buildHighCardRetirementPlan({
      schemaInventory: schemaInventory({
        ownedObjects: legacyOwnedObjects().filter((entry) => entry.name !== 'stops_name_idx'),
        missingExpectedObjects: ['stops_name_idx'],
        schemaMatchesExpectedLegacyShape: false,
      }),
      authorityReadiness: allRootBoundAuthority(),
    })

    expect(plan.planningState).toBe('blocked')
    expect(plan.blockers).toEqual(['schema_drift'])
    expect(plan.destructiveExecutionAuthorized).toBe(false)
  })

  it('recognizes an already-retired clean schema without creating candidates', () => {
    const plan = buildHighCardRetirementPlan({
      schemaInventory: schemaInventory({
        schemaState: 'retired',
        tablesPresent: [],
        ownedObjects: [],
        schemaMatchesExpectedLegacyShape: false,
        dependencyClear: true,
      }),
      authorityReadiness: authorityReadiness(),
    })

    expect(plan.planningState).toBe('already-retired')
    expect(plan.blockers).toEqual([])
    expect(plan.candidateObjects).toEqual([])
    expect(plan.remainingAcceptanceGates).toEqual([])
    expect(plan.destructiveExecutionAuthorized).toBe(false)
  })

  it('rejects forged schema summaries instead of trusting table and object claims', () => {
    expect(() => buildHighCardRetirementPlan({
      schemaInventory: schemaInventory({
        ownedObjects: [
          { type: 'table', name: 'pattern_stops', table: 'pattern_stops' },
          { type: 'table', name: 'stops', table: 'stops' },
        ],
      }),
      authorityReadiness: authorityReadiness(),
    })).toThrow('missing schema objects do not match owned objects')

    expect(() => buildHighCardRetirementPlan({
      schemaInventory: schemaInventory({
        schemaState: 'retired',
        tablesPresent: [],
        ownedObjects: [{ type: 'index', name: 'stops_name_idx', table: 'stops' }],
        schemaMatchesExpectedLegacyShape: false,
      }),
      authorityReadiness: authorityReadiness(),
    })).toThrow('schema owned objects outlive their target table')
  })

  it('rejects unexpected-object summaries that do not match owned schema objects', () => {
    const ownedObjects = [
      ...legacyOwnedObjects(),
      { type: 'index', name: 'unexpected_idx', table: 'stops' },
    ]
    expect(() => buildHighCardRetirementPlan({
      schemaInventory: schemaInventory({ ownedObjects }),
      authorityReadiness: authorityReadiness(),
    })).toThrow('unexpected schema objects do not match owned objects')

    const plan = buildHighCardRetirementPlan({
      schemaInventory: schemaInventory({
        ownedObjects,
        unexpectedOwnedObjects: [{ type: 'index', name: 'unexpected_idx', table: 'stops' }],
        schemaMatchesExpectedLegacyShape: false,
      }),
      authorityReadiness: allRootBoundAuthority(),
    })
    expect(plan.planningState).toBe('blocked')
    expect(plan.blockers).toEqual(['schema_drift'])
  })

  it('rejects inconsistent authority summaries instead of trusting a ready flag', () => {
    expect(() => buildHighCardRetirementPlan({
      schemaInventory: schemaInventory(),
      authorityReadiness: authorityReadiness({ rootBoundAuthorityReady: true }),
    })).toThrow('authority summary is inconsistent')

    const taichung = authorityCity('Taichung')
    expect(() => buildHighCardRetirementPlan({
      schemaInventory: schemaInventory(),
      authorityReadiness: authorityReadiness({ blockingCities: [blockingCity(taichung)] }),
    })).toThrow('blocking cities do not match authority windows')
  })

  it('rejects a forged root-bound window that disagrees with authority modes', () => {
    const taichung = authorityCity('Taichung')
    const taipei = authorityCity('Taipei')
    expect(() => buildHighCardRetirementPlan({
      schemaInventory: schemaInventory(),
      authorityReadiness: authorityReadiness({
        cities: [{ ...taichung, rootBoundRollbackWindow: true }, taipei],
      }),
    })).toThrow('authority city evidence is inconsistent')
  })

  it('rejects inconsistent per-city authority mode, rollback, and publication evidence', () => {
    const taichung = authorityCity('Taichung')
    const taipei = authorityCity('Taipei')

    expect(() => buildHighCardRetirementPlan({
      schemaInventory: schemaInventory(),
      authorityReadiness: authorityReadiness({
        cities: [{ ...taichung, activeRoutingManifestCount: 0 }, taipei],
      }),
    })).toThrow('authority city evidence is inconsistent')

    expect(() => buildHighCardRetirementPlan({
      schemaInventory: schemaInventory(),
      authorityReadiness: authorityReadiness({
        cities: [{ ...taichung, rollbackTargetAuthorityMode: 'legacy-backfill' }, taipei],
      }),
    })).toThrow('authority city evidence is inconsistent')

    expect(() => buildHighCardRetirementPlan({
      schemaInventory: schemaInventory(),
      authorityReadiness: authorityReadiness({
        cities: [{ ...taichung, nativeRootBoundPublicationsRequired: 1 }, taipei],
      }),
    })).toThrow('authority city evidence is inconsistent')
  })

  it('rejects stale blocking-city metadata even when the city set is correct', () => {
    const report = authorityReadiness()
    expect(() => buildHighCardRetirementPlan({
      schemaInventory: schemaInventory(),
      authorityReadiness: {
        ...report,
        blockingCities: [
          { ...report.blockingCities[0], activeVersion: 'stale-version' },
          report.blockingCities[1],
        ],
      },
    })).toThrow('blocking city evidence does not match authority windows')
  })

  it('rejects inconsistent schema summaries instead of inferring around them', () => {
    expect(() => buildHighCardRetirementPlan({
      schemaInventory: schemaInventory({ dependencyClear: false }),
      authorityReadiness: authorityReadiness(),
    })).toThrow('schema inventory summary is inconsistent')

    expect(() => buildHighCardRetirementPlan({
      schemaInventory: schemaInventory({ schemaState: 'partial' }),
      authorityReadiness: authorityReadiness(),
    })).toThrow('schema state is inconsistent with target tables')
  })

  it('contains no mutation SQL or production credential surface', async () => {
    const source = await readFile(new URL('./high-card-retirement-plan.mjs', import.meta.url), 'utf8')
    expect(source).not.toMatch(/\bDROP\s+(?:TABLE|INDEX)\b/i)
    expect(source).not.toMatch(/\bDELETE\s+FROM\b/i)
    expect(source).not.toContain('CLOUDFLARE_API_TOKEN')
    expect(source).not.toContain('R2_ACCESS_KEY_ID')
    expect(source).not.toContain('R2_SECRET_ACCESS_KEY')
    expect(source).not.toContain('queryD1')
    expect(source).not.toContain('fetch(')
  })
})
