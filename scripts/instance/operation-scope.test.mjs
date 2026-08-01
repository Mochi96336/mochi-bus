import { describe, expect, it } from 'vitest'
import { resolveOperationScope } from './operation-scope.mjs'

function plan(overrides = {}) {
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

describe('instance operation workflow scope', () => {
  it('disables scheduled publication for manual instances', () => {
    expect(resolveOperationScope('snapshot', plan({ snapshotSchedule: 'manual' }))).toMatchObject({
      enabled: false,
      snapshotSchedule: 'manual',
    })
    expect(resolveOperationScope('snapshot', plan({ snapshotSchedule: 'daily' })).enabled).toBe(true)
    expect(resolveOperationScope('snapshot', plan({ snapshotSchedule: 'taipei-weekly-sharded' })).enabled).toBe(true)
  })

  it('uses each verification check as an explicit workflow gate', () => {
    const disabled = plan({
      checks: { releaseSmoke: true, publicProbe: false, windowWatchdog: false },
    })
    expect(resolveOperationScope('publicProbe', disabled).enabled).toBe(false)
    expect(resolveOperationScope('windowWatchdog', disabled).enabled).toBe(false)
  })

  it('fails closed for unknown operation names', () => {
    expect(() => resolveOperationScope('unknown', plan())).toThrow('Unsupported instance operation: unknown')
  })
})
