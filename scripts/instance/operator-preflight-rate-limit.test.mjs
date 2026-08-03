import { describe, expect, it } from 'vitest'
import { resolveOperatorPreflight } from './operator-preflight.mjs'

const plan = {
  schemaVersion: 1,
  profile: 'operator',
  enabledCities: ['Taipei'],
  snapshotSchedule: 'daily',
  checks: { releaseSmoke: true, publicProbe: true, windowWatchdog: true },
  provisioned: true,
}

const baseResources = {
  instanceId: 'mochi-production',
  enabledCities: ['Taipei'],
  defaultCity: 'Taipei',
  demoQuery: { city: 'Taipei', routeName: '307' },
  workerName: 'mochi-tools',
  d1DatabaseName: 'mochi-transit',
  d1DatabaseId: '123e4567-e89b-42d3-a456-426614174000',
  r2BucketName: 'mochi-transit-shapes',
  publicOrigin: 'https://bus.example',
  rateLimitNamespaceIds: { standard: '1001', expensive: '1002' },
}

const env = {
  CLOUDFLARE_API_TOKEN: 'secret-api-token',
  CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
}

describe('operator rate-limit preflight', () => {
  it('rejects zero and duplicate generated namespace IDs at deployment time', () => {
    expect(() => resolveOperatorPreflight({
      operation: 'deploy',
      plan,
      resources: {
        ...baseResources,
        rateLimitNamespaceIds: { standard: '0', expensive: '1002' },
      },
      env,
    })).toThrow('two distinct positive rate-limit namespace IDs')

    expect(() => resolveOperatorPreflight({
      operation: 'deploy',
      plan,
      resources: {
        ...baseResources,
        rateLimitNamespaceIds: { standard: '1001', expensive: '1001' },
      },
      env,
    })).toThrow('two distinct positive rate-limit namespace IDs')
  })
})
