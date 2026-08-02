import { describe, expect, it, vi } from 'vitest'
import {
  inspectOperatorPreflight,
  parseOperatorPreflightArguments,
  resolveOperatorPreflight,
  runOperatorPreflight,
} from './operator-preflight.mjs'

const databaseId = '123e4567-e89b-42d3-a456-426614174000'

function plan(overrides = {}) {
  return {
    schemaVersion: 1,
    profile: 'operator',
    enabledCities: ['Taipei', 'Chiayi'],
    snapshotSchedule: 'taipei-weekly-sharded',
    checks: { releaseSmoke: true, publicProbe: true, windowWatchdog: true },
    provisioned: true,
    ...overrides,
  }
}

function resources(overrides = {}) {
  return {
    instanceId: 'mochi-production',
    enabledCities: ['Taipei', 'Chiayi'],
    defaultCity: 'Taipei',
    demoQuery: { city: 'Taipei', routeName: '307' },
    workerName: 'mochi-tools',
    d1DatabaseName: 'mochi-transit',
    d1DatabaseId: databaseId,
    r2BucketName: 'mochi-transit-shapes',
    publicOrigin: 'https://bus.example',
    rateLimitNamespaceIds: { standard: '1001', expensive: '1002' },
    ...overrides,
  }
}

function cloudflareEnv(overrides = {}) {
  return {
    CLOUDFLARE_API_TOKEN: 'secret-api-token',
    CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
    ...overrides,
  }
}

function cloudflareResponse(result) {
  return new Response(JSON.stringify({ success: true, result }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('instance operator preflight', () => {
  it('skips disabled checks without requiring unrelated credentials', () => {
    const resolved = resolveOperatorPreflight({
      operation: 'publicProbe',
      plan: plan({ checks: { releaseSmoke: false, publicProbe: false, windowWatchdog: false } }),
      resources: resources({ d1DatabaseId: null, publicOrigin: null }),
      env: {},
    })
    expect(resolved).toEqual({
      operation: 'publicProbe',
      enabled: false,
      profile: 'operator',
      origin: null,
      remoteChecks: [],
      warnings: [],
    })
  })

  it('verifies operator deployment D1 and R2 identity before deployment', async () => {
    const fetchImpl = vi.fn(async (url, options) => {
      expect(options.headers.Authorization).toBe('Bearer secret-api-token')
      return String(url).includes('/d1/database/')
        ? cloudflareResponse({ uuid: databaseId, name: 'mochi-transit' })
        : cloudflareResponse({ name: 'mochi-transit-shapes' })
    })

    const result = await runOperatorPreflight({
      operation: 'deploy',
      plan: plan(),
      resources: resources(),
      env: cloudflareEnv(),
      fetchImpl,
    })

    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      `https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/d1/database/${databaseId}`,
      'https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/r2/buckets/mochi-transit-shapes',
    ])
    expect(result.checkedResources).toEqual([
      { kind: 'd1', name: 'mochi-transit' },
      { kind: 'r2', name: 'mochi-transit-shapes' },
    ])
    expect(JSON.stringify(result)).not.toContain('secret-api-token')
  })

  it('fails with configuration names without printing secret values', () => {
    let caught
    try {
      resolveOperatorPreflight({
        operation: 'snapshot',
        plan: plan(),
        resources: resources(),
        env: cloudflareEnv({ CLOUDFLARE_API_TOKEN: 'highly-sensitive-value' }),
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    expect(caught.message).toContain('TDX_CLIENT_ID')
    expect(caught.message).toContain('TDX_CLIENT_SECRET')
    expect(caught.message).toContain('R2_ACCESS_KEY_ID')
    expect(caught.message).not.toContain('highly-sensitive-value')
  })

  it('collects every local blocker for doctor-style diagnostics', () => {
    const inspected = inspectOperatorPreflight({
      operation: 'snapshot',
      forceEnabled: true,
      plan: plan({ profile: 'managed' }),
      resources: resources({ d1DatabaseId: null, publicOrigin: null }),
      env: {
        CLOUDFLARE_ACCOUNT_ID: 'not-an-account',
        CLOUDFLARE_API_TOKEN: 'do-not-print-me',
        R2_ACCESS_KEY_ID: 'only-half-a-pair',
      },
    })

    expect(inspected.blockers).toEqual([
      'CLOUDFLARE_ACCOUNT_ID must be a 32-character hexadecimal account ID',
      'snapshot requires a provisioned D1 database ID',
      'R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY must be configured together',
      'A fixed public origin or SNAPSHOT_SMOKE_BASE_URL is required',
      'Missing required operator configuration: TDX_CLIENT_ID, TDX_CLIENT_SECRET',
    ])
    expect(JSON.stringify(inspected)).not.toContain('do-not-print-me')
    expect(JSON.stringify(inspected)).not.toContain('only-half-a-pair')
  })

  it('requires explicit public origins only for operations that use them', () => {
    expect(() => resolveOperatorPreflight({
      operation: 'deploy',
      plan: plan(),
      resources: resources({ publicOrigin: null }),
      env: cloudflareEnv(),
    })).toThrow('RELEASE_SMOKE_ORIGIN is required')

    expect(resolveOperatorPreflight({
      operation: 'deploy',
      plan: plan(),
      resources: resources({ publicOrigin: null }),
      env: cloudflareEnv({ RELEASE_SMOKE_ORIGIN: 'https://fork.example' }),
    }).origin).toBe('https://fork.example')

    expect(resolveOperatorPreflight({
      operation: 'windowWatchdog',
      plan: plan(),
      resources: resources({ publicOrigin: null }),
      env: cloudflareEnv(),
    }).origin).toBeNull()
  })

  it('requires scalable R2 credentials for managed snapshots but preserves starter fallback', () => {
    const baseEnv = cloudflareEnv({
      TDX_CLIENT_ID: 'tdx-id',
      TDX_CLIENT_SECRET: 'tdx-secret',
    })
    expect(() => resolveOperatorPreflight({
      operation: 'snapshot',
      plan: plan({ profile: 'managed' }),
      resources: resources(),
      env: baseEnv,
    })).toThrow('R2_ACCESS_KEY_ID')

    const starter = resolveOperatorPreflight({
      operation: 'snapshot',
      forceEnabled: true,
      plan: plan({ profile: 'starter', snapshotSchedule: 'manual' }),
      resources: resources(),
      env: baseEnv,
    })
    expect(starter.enabled).toBe(true)
    expect(starter.warnings).toEqual([
      'R2 S3 credentials are absent; the manual starter snapshot will use the slow Wrangler fallback',
    ])
  })

  it('fails closed on remote identity mismatches and unreadable resources', async () => {
    await expect(runOperatorPreflight({
      operation: 'publicProbe',
      plan: plan(),
      resources: resources(),
      env: cloudflareEnv(),
      fetchImpl: vi.fn(async () => cloudflareResponse({ uuid: databaseId, name: 'wrong-database' })),
    })).rejects.toThrow('Cloudflare D1 identity mismatch')

    await expect(runOperatorPreflight({
      operation: 'publicProbe',
      plan: plan(),
      resources: resources(),
      env: cloudflareEnv(),
      fetchImpl: vi.fn(async () => new Response('', { status: 403 })),
    })).rejects.toThrow('Cloudflare D1 database preflight failed with HTTP 403')
  })

  it('supports forced manual snapshot checks and rejects unknown CLI options', () => {
    expect(parseOperatorPreflightArguments(['snapshot'], {
      MOCHI_BUS_PREFLIGHT_FORCE_ENABLED: 'true',
    })).toEqual({ operation: 'snapshot', forceEnabled: true })
    expect(parseOperatorPreflightArguments(['snapshot', '--force-enabled'], {}))
      .toEqual({ operation: 'snapshot', forceEnabled: true })
    expect(() => parseOperatorPreflightArguments(['snapshot', '--unknown'], {}))
      .toThrow('Unknown operator preflight option')
    expect(() => parseOperatorPreflightArguments([], {}))
      .toThrow('requires exactly one operation')
  })
})
