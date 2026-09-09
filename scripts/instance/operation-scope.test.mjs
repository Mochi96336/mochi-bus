import { describe, expect, it, vi } from 'vitest'
import { resolveOperationScope, writeOperationScope } from './operation-scope.mjs'

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

function resources(overrides = {}) {
  return {
    workerName: 'chiayi-bus',
    d1DatabaseName: 'chiayi-transit',
    d1DatabaseId: '123e4567-e89b-42d3-a456-426614174000',
    r2BucketName: 'chiayi-transit-shapes',
    publicOrigin: 'https://bus.example',
    ...overrides,
  }
}

describe('instance operation workflow scope', () => {
  it('disables scheduled publication for manual instances', () => {
    expect(resolveOperationScope('snapshot', plan({ snapshotSchedule: 'manual' }), resources())).toMatchObject({
      enabled: false,
      snapshotSchedule: 'manual',
    })
    expect(resolveOperationScope('snapshot', plan({ snapshotSchedule: 'daily' }), resources()).enabled).toBe(true)
    expect(resolveOperationScope(
      'snapshot', plan({ snapshotSchedule: 'taipei-weekly-sharded' }), resources(),
    ).enabled).toBe(true)
  })

  it('attaches quota-aware static source floors only to weekly-sharded snapshots', () => {
    expect(resolveOperationScope(
      'snapshot', plan({ snapshotSchedule: 'taipei-weekly-sharded' }), resources(),
    ).staticSourceRefreshDays).toEqual({
      city: { topology: 14, schedule: 21, shape: 28 },
      intercity: { topology: 21, schedule: 35, shape: 56 },
    })
    expect(resolveOperationScope('snapshot', plan({ snapshotSchedule: 'daily' }), resources())
      .staticSourceRefreshDays).toEqual({
      city: { topology: 0, schedule: 0, shape: 0 },
      intercity: { topology: 0, schedule: 0, shape: 0 },
    })
  })

  it('uses each verification check as an explicit workflow gate', () => {
    const disabled = plan({
      checks: { releaseSmoke: false, publicProbe: false, windowWatchdog: false },
    })
    expect(resolveOperationScope('releaseSmoke', disabled, resources()).enabled).toBe(false)
    expect(resolveOperationScope('publicProbe', disabled, resources()).enabled).toBe(false)
    expect(resolveOperationScope('windowWatchdog', disabled, resources()).enabled).toBe(false)
  })

  it('allows explicit origin overrides for request-origin checks', () => {
    expect(resolveOperationScope('publicProbe', plan(), resources({ publicOrigin: null })).enabled).toBe(true)
    expect(resolveOperationScope('releaseSmoke', plan(), resources({ publicOrigin: null })).enabled).toBe(true)
  })

  it('reports operation intent before the dedicated provisioning preflight', () => {
    expect(resolveOperationScope('snapshot', plan(), resources({ d1DatabaseId: null }))).toMatchObject({
      enabled: true,
      d1DatabaseId: null,
    })
    expect(resolveOperationScope('publicProbe', plan(), resources({ d1DatabaseId: null }))).toMatchObject({
      enabled: true,
      d1DatabaseId: null,
    })
  })

  it('writes validated resource identity and refresh policy to GitHub outputs', () => {
    const appendFile = vi.fn()
    writeOperationScope(resolveOperationScope(
      'snapshot',
      plan({ snapshotSchedule: 'taipei-weekly-sharded' }),
      resources(),
    ), {
      GITHUB_OUTPUT: '/tmp/output',
    }, appendFile)

    const [path, content] = appendFile.mock.calls[0]
    expect(path).toBe('/tmp/output')
    expect(content).toContain('enabled=true\n')
    expect(content).toContain('d1_database_name=chiayi-transit\n')
    expect(content).toContain('d1_database_id=123e4567-e89b-42d3-a456-426614174000\n')
    expect(content).toContain('r2_bucket_name=chiayi-transit-shapes\n')
    expect(content).toContain('public_origin=https://bus.example\n')
    expect(content).toContain('static_city_topology_refresh_days=14\n')
    expect(content).toContain('static_city_schedule_refresh_days=21\n')
    expect(content).toContain('static_city_shape_refresh_days=28\n')
    expect(content).toContain('static_intercity_topology_refresh_days=21\n')
    expect(content).toContain('static_intercity_schedule_refresh_days=35\n')
    expect(content).toContain('static_intercity_shape_refresh_days=56\n')
  })

  it('fails closed for unknown operation names', () => {
    expect(() => resolveOperationScope('unknown', plan(), resources()))
      .toThrow('Unsupported instance operation: unknown')
  })
})
