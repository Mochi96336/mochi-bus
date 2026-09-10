import { describe, expect, it } from 'vitest'
import {
  renderScheduledNativeAuthorityRefreshFlag,
  scheduledNativeAuthorityRefreshDecision,
} from './scheduled-native-authority-refresh.mjs'

function city({
  city = 'Taichung',
  activeAuthorityMode = 'legacy-backfill',
  previousAuthorityMode = 'legacy-d1',
  rootBoundRollbackWindow = false,
  nativeRootBoundPublicationsRequired = 2,
} = {}) {
  return {
    city,
    activeVersion: `${city}-active`,
    previousVersion: `${city}-previous`,
    activeAuthorityMode,
    previousAuthorityMode,
    activeRoutingManifestCount: activeAuthorityMode === 'legacy-d1' ? 0 : 4,
    previousRoutingManifestCount: previousAuthorityMode === 'legacy-d1' ? 0 : 4,
    rootBoundRollbackWindow,
    nativeRootBoundPublicationsRequired,
  }
}

function report(cities) {
  const blockingCities = cities
    .filter((entry) => !entry.rootBoundRollbackWindow)
    .map(({ rootBoundRollbackWindow: _rootBoundRollbackWindow, ...entry }) => entry)
  return {
    schemaVersion: 2,
    kind: 'snapshot-high-card-d1-retirement-readiness',
    cityCount: cities.length,
    rootBoundCityCount: cities.length - blockingCities.length,
    rootBoundAuthorityReady: blockingCities.length === 0,
    blockingCities,
    cities,
  }
}

describe('scheduled native authority refresh policy', () => {
  it('forces one normal publication while a retained legacy window still blocks retirement', () => {
    const decision = scheduledNativeAuthorityRefreshDecision(report([city()]), 'Taichung')
    expect(decision).toEqual({
      city: 'Taichung',
      forcePublish: true,
      nativeRootBoundPublicationsRequired: 2,
      activeAuthorityMode: 'legacy-backfill',
      previousAuthorityMode: 'legacy-d1',
    })
    expect(renderScheduledNativeAuthorityRefreshFlag(decision)).toBe('1')
  })

  it('forces the second publication when active is root-bound but previous is still legacy', () => {
    const evidence = city({
      activeAuthorityMode: 'root-bound',
      previousAuthorityMode: 'legacy-backfill',
      nativeRootBoundPublicationsRequired: 1,
    })
    expect(scheduledNativeAuthorityRefreshDecision(report([evidence]), 'Taichung').forcePublish).toBe(true)
  })

  it('keeps the unchanged fast path once both retained versions are root-bound', () => {
    const evidence = city({
      activeAuthorityMode: 'root-bound',
      previousAuthorityMode: 'root-bound',
      rootBoundRollbackWindow: true,
      nativeRootBoundPublicationsRequired: 0,
    })
    const decision = scheduledNativeAuthorityRefreshDecision(report([evidence]), 'Taichung')
    expect(decision.forcePublish).toBe(false)
    expect(renderScheduledNativeAuthorityRefreshFlag(decision)).toBe('0')
  })

  it('accepts historical partial authority as a blocker rather than pretending it is ready', () => {
    const evidence = city({ city: 'Taipei', activeAuthorityMode: 'legacy-partial' })
    const decision = scheduledNativeAuthorityRefreshDecision(report([evidence]), 'Taipei')
    expect(decision.forcePublish).toBe(true)
    expect(decision.nativeRootBoundPublicationsRequired).toBe(2)
  })

  it('fails closed when the selected city is absent, duplicated, or disagrees with blockers', () => {
    const valid = report([city()])
    expect(() => scheduledNativeAuthorityRefreshDecision(valid, 'Taipei')).toThrow(/not uniquely represented/)

    const duplicate = { ...valid, cities: [valid.cities[0], valid.cities[0]], cityCount: 2 }
    expect(() => scheduledNativeAuthorityRefreshDecision(duplicate, 'Taichung')).toThrow(/not uniquely represented/)

    const disagreement = structuredClone(valid)
    disagreement.blockingCities[0].nativeRootBoundPublicationsRequired = 1
    expect(() => scheduledNativeAuthorityRefreshDecision(disagreement, 'Taichung')).toThrow(/disagrees/)
  })

  it('fails closed on an unsupported report schema or malformed ready state', () => {
    expect(() => scheduledNativeAuthorityRefreshDecision({ ...report([city()]), schemaVersion: 1 }, 'Taichung'))
      .toThrow(/report is invalid/)

    const ready = city({
      activeAuthorityMode: 'root-bound',
      previousAuthorityMode: 'root-bound',
      rootBoundRollbackWindow: true,
      nativeRootBoundPublicationsRequired: 0,
    })
    const malformed = report([ready])
    malformed.blockingCities.push({ ...ready, rootBoundRollbackWindow: undefined })
    expect(() => scheduledNativeAuthorityRefreshDecision(malformed, 'Taichung')).toThrow(/disagrees with blockers/)
  })
})
