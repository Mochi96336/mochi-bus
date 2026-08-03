import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { compileInstanceConfig, writeCompiledInstance } from './config.mjs'
import { diagnoseInstance } from './doctor.mjs'

const temporaryDirectories = []
const databaseId = '123e4567-e89b-42d3-a456-426614174000'

const config = {
  schemaVersion: 1,
  instanceId: 'request-derived-test',
  site: { name: 'Request-derived Bus', canonicalOrigin: 'request' },
  transit: {
    enabledCities: ['Taipei'],
    defaultCity: 'Taipei',
    demoQuery: {
      city: 'Taipei',
      routeName: '307',
      stopName: '臺北車站',
      stopUid: 'TPE1000',
      routeUid: 'TPE307',
      direction: 0,
    },
  },
  cloudflare: {
    workerName: 'request-derived-test',
    workersDev: false,
    d1: { databaseName: 'request-derived-data', databaseId },
    r2: { bucketName: 'request-derived-shapes' },
    rateLimits: { standardNamespaceId: '1001', expensiveNamespaceId: '1002' },
  },
  operations: {
    profile: 'managed',
    snapshotSchedule: 'daily',
    releaseSmoke: true,
    publicProbe: true,
    windowWatchdog: true,
  },
}

function readyEnvironment(overrides = {}) {
  return {
    CLOUDFLARE_API_TOKEN: 'cloudflare-secret',
    CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
    TDX_CLIENT_ID: 'tdx-client',
    TDX_CLIENT_SECRET: 'tdx-secret',
    R2_ACCESS_KEY_ID: 'r2-access',
    R2_SECRET_ACCESS_KEY: 'r2-secret',
    RELEASE_SMOKE_ORIGIN: 'https://release.example',
    SNAPSHOT_SMOKE_BASE_URL: 'https://snapshot.example',
    ...overrides,
  }
}

async function workspace() {
  const cwd = await mkdtemp(join(tmpdir(), 'mochi-bus-doctor-isolation-'))
  temporaryDirectories.push(cwd)
  await writeFile(join(cwd, 'instance.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  await writeCompiledInstance(
    compileInstanceConfig(config),
    join(cwd, '.generated/instance'),
    { workingDirectory: cwd },
  )
  return cwd
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('instance doctor operation isolation', () => {
  it('keeps a release origin error on deploy only', async () => {
    const report = await diagnoseInstance({
      cwd: await workspace(),
      env: readyEnvironment({ RELEASE_SMOKE_ORIGIN: 'http://release.example' }),
    })

    expect(report.environment.status).toBe('ready')
    expect(report.operations.find(({ name }) => name === 'deploy')).toMatchObject({
      status: 'blocked',
      blockers: ['RELEASE_SMOKE_ORIGIN must be an absolute HTTPS origin'],
    })
    expect(report.operations.find(({ name }) => name === 'snapshot').status).toBe('ready')
    expect(report.operations.find(({ name }) => name === 'publicProbe').status).toBe('ready')
    expect(report.operations.find(({ name }) => name === 'windowWatchdog').status).toBe('ready')
  })

  it('keeps a snapshot origin error off deploy and watchdog', async () => {
    const report = await diagnoseInstance({
      cwd: await workspace(),
      env: readyEnvironment({ SNAPSHOT_SMOKE_BASE_URL: 'not-an-origin' }),
    })

    expect(report.environment.status).toBe('ready')
    expect(report.operations.find(({ name }) => name === 'deploy').status).toBe('ready')
    expect(report.operations.find(({ name }) => name === 'snapshot').status).toBe('blocked')
    expect(report.operations.find(({ name }) => name === 'publicProbe').status).toBe('blocked')
    expect(report.operations.find(({ name }) => name === 'windowWatchdog').status).toBe('ready')
  })
})