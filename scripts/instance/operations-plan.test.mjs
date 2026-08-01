import { describe, expect, it, vi } from 'vitest'
import {
  assertOperationCityEnabled,
  loadOperationsPlan,
  resolveOperationsPlanPath,
  validateOperationsPlan,
} from './operations-plan.mjs'

function validPlan(overrides = {}) {
  return {
    schemaVersion: 1,
    profile: 'managed',
    enabledCities: ['Chiayi'],
    snapshotSchedule: 'daily',
    checks: {
      releaseSmoke: true,
      publicProbe: true,
      windowWatchdog: true,
    },
    provisioned: true,
    ...overrides,
  }
}

describe('instance operations plan', () => {
  it('loads an explicit operations plan and preserves enabled-city order', () => {
    const readFile = vi.fn(() => JSON.stringify(validPlan({
      enabledCities: ['Chiayi', 'Keelung'],
    })))
    const plan = loadOperationsPlan({
      cwd: '/repo',
      env: { MOCHI_BUS_OPERATIONS_PLAN: 'custom/operations.json' },
      readFile,
    })

    expect(resolveOperationsPlanPath({
      cwd: '/repo',
      env: { MOCHI_BUS_OPERATIONS_PLAN: 'custom/operations.json' },
    })).toBe('/repo/custom/operations.json')
    expect(readFile).toHaveBeenCalledWith('/repo/custom/operations.json', 'utf8')
    expect(plan.enabledCities).toEqual(['Chiayi', 'Keelung'])
    expect(Object.isFrozen(plan.enabledCities)).toBe(true)
  })

  it('fails closed on unknown fields, duplicates and unsupported cities', () => {
    expect(() => validateOperationsPlan(validPlan({ unexpected: true }))).toThrow('unknown property unexpected')
    expect(() => validateOperationsPlan(validPlan({ enabledCities: ['Chiayi', 'Chiayi'] })))
      .toThrow('duplicate city Chiayi')
    expect(() => validateOperationsPlan(validPlan({ enabledCities: ['Atlantis'] })))
      .toThrow('supported city code')
  })

  it('rejects a manual snapshot city outside the instance scope', () => {
    expect(assertOperationCityEnabled('Chiayi', ['Chiayi'])).toBe('Chiayi')
    expect(() => assertOperationCityEnabled('Taipei', ['Chiayi']))
      .toThrow('Snapshot city is not enabled for this instance: Taipei')
    expect(() => assertOperationCityEnabled('Atlantis', ['Chiayi']))
      .toThrow('Unsupported snapshot city: Atlantis')
  })
})
