import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { compileInstanceConfig, writeCompiledInstance } from './config.mjs'
import {
  diagnoseInstance,
  parseInstanceDoctorArguments,
  renderInstanceDoctorMarkdown,
  renderInstanceDoctorText,
} from './doctor.mjs'

const databaseId = '123e4567-e89b-42d3-a456-426614174000'
const temporaryDirectories = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function operatorConfig(overrides = {}) {
  return {
    schemaVersion: 1,
    instanceId: 'test-instance',
    site: { name: 'Test Bus', canonicalOrigin: 'https://bus.example' },
    transit: {
      enabledCities: ['Taipei', 'Chiayi'],
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
      workerName: 'test-bus',
      workersDev: false,
      d1: { databaseName: 'test-transit', databaseId },
      r2: { bucketName: 'test-transit-shapes' },
      rateLimits: { standardNamespaceId: '1001', expensiveNamespaceId: '1002' },
    },
    operations: {
      profile: 'operator',
      snapshotSchedule: 'taipei-weekly-sharded',
      releaseSmoke: true,
      publicProbe: true,
      windowWatchdog: true,
    },
    ...overrides,
  }
}

function readyEnvironment(overrides = {}) {
  return {
    CLOUDFLARE_API_TOKEN: 'cloudflare-secret',
    CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
    TDX_CLIENT_ID: 'tdx-client',
    TDX_CLIENT_SECRET: 'tdx-secret',
    R2_ACCESS_KEY_ID: 'r2-access',
    R2_SECRET_ACCESS_KEY: 'r2-secret',
    ...overrides,
  }
}

async function workspace(config = operatorConfig()) {
  const cwd = await mkdtemp(join(tmpdir(), 'mochi-bus-doctor-'))
  temporaryDirectories.push(cwd)
  await writeFile(join(cwd, 'instance.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  await writeCompiledInstance(
    compileInstanceConfig(config),
    join(cwd, '.generated/instance'),
    { workingDirectory: cwd },
  )
  return cwd
}

function cloudflareResponse(result) {
  return new Response(JSON.stringify({ success: true, result }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('instance doctor', () => {
  it('reports a complete local operator instance as ready', async () => {
    const cwd = await workspace()
    const report = await diagnoseInstance({ cwd, env: readyEnvironment() })

    expect(report.ok).toBe(true)
    expect(report.manifest).toMatchObject({
      status: 'ready',
      path: 'instance.json',
      instanceId: 'test-instance',
      profile: 'operator',
      enabledCities: ['Taipei', 'Chiayi'],
    })
    expect(report.generated.map(({ key, status }) => [key, status])).toEqual([
      ['runtime', 'ready'],
      ['wrangler', 'ready'],
      ['operations', 'ready'],
    ])
    expect(report.operations.map(({ name, status }) => [name, status])).toEqual([
      ['deploy', 'ready'],
      ['snapshot', 'ready'],
      ['publicProbe', 'ready'],
      ['windowWatchdog', 'ready'],
    ])
    expect(report.remote.status).toBe('not_checked')
  })

  it('detects stale generated artifacts before evaluating operations', async () => {
    const cwd = await workspace()
    const planPath = join(cwd, '.generated/instance/operations-plan.json')
    const plan = JSON.parse(await readFile(planPath, 'utf8'))
    plan.checks.publicProbe = false
    await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8')

    const report = await diagnoseInstance({ cwd, env: readyEnvironment() })

    expect(report.ok).toBe(false)
    expect(report.generated.find(({ key }) => key === 'operations')).toMatchObject({
      status: 'blocked',
      blockers: ['Generated operations plan is stale; run npm run instance:compile'],
    })
    expect(report.operations.every(({ status }) => status === 'not_checked')).toBe(true)
  })

  it('lists operation blockers without exposing supplied secret values', async () => {
    const cwd = await workspace()
    const report = await diagnoseInstance({
      cwd,
      env: {
        CLOUDFLARE_API_TOKEN: 'never-print-cloudflare',
        TDX_CLIENT_SECRET: 'never-print-tdx',
        R2_ACCESS_KEY_ID: 'never-print-r2',
      },
    })
    const serialized = JSON.stringify(report)

    expect(report.ok).toBe(false)
    expect(report.operations.find(({ name }) => name === 'deploy').blockers.join('\n'))
      .toContain('CLOUDFLARE_ACCOUNT_ID')
    expect(report.operations.find(({ name }) => name === 'snapshot').blockers.join('\n'))
      .toContain('TDX_CLIENT_ID')
    expect(serialized).not.toContain('never-print-cloudflare')
    expect(serialized).not.toContain('never-print-tdx')
    expect(serialized).not.toContain('never-print-r2')
  })

  it('shows disabled checks and the starter manual snapshot fallback without blocking readiness', async () => {
    const config = operatorConfig({
      cloudflare: {
        workerName: 'starter-bus',
        workersDev: true,
        d1: { databaseName: 'starter-transit', databaseId },
        r2: { bucketName: 'starter-transit-shapes' },
        rateLimits: { standardNamespaceId: null, expensiveNamespaceId: null },
      },
      operations: {
        profile: 'starter',
        snapshotSchedule: 'manual',
        releaseSmoke: false,
        publicProbe: false,
        windowWatchdog: false,
      },
    })
    const cwd = await workspace(config)
    const report = await diagnoseInstance({
      cwd,
      env: readyEnvironment({ R2_ACCESS_KEY_ID: '', R2_SECRET_ACCESS_KEY: '' }),
    })

    expect(report.ok).toBe(true)
    expect(report.operations.find(({ name }) => name === 'snapshot')).toMatchObject({
      mode: 'manual',
      status: 'ready',
      warnings: ['R2 S3 credentials are absent; the manual starter snapshot will use the slow Wrangler fallback'],
    })
    expect(report.operations.find(({ name }) => name === 'publicProbe').status).toBe('disabled')
    expect(report.operations.find(({ name }) => name === 'windowWatchdog').status).toBe('disabled')
  })

  it('deduplicates and verifies remote D1 and R2 identity only when requested', async () => {
    const cwd = await workspace()
    const fetchImpl = vi.fn(async (url, options) => {
      expect(options.headers.Authorization).toBe('Bearer cloudflare-secret')
      return String(url).includes('/d1/database/')
        ? cloudflareResponse({ uuid: databaseId, name: 'test-transit' })
        : cloudflareResponse({ name: 'test-transit-shapes' })
    })
    const report = await diagnoseInstance({
      cwd,
      env: readyEnvironment(),
      remote: true,
      fetchImpl,
    })

    expect(report.ok).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(report.remote).toMatchObject({
      requested: true,
      status: 'ready',
      checkedResources: [
        { kind: 'd1', name: 'test-transit' },
        { kind: 'r2', name: 'test-transit-shapes' },
      ],
    })
    expect(JSON.stringify(report)).not.toContain('cloudflare-secret')
  })

  it('supports explicit config/output paths and renders terminal plus GitHub summaries', async () => {
    expect(parseInstanceDoctorArguments([
      '--config=instances/fork.json',
      '--out-dir', '.generated/fork',
      '--remote',
      '--json',
      '--github-summary',
    ])).toEqual({
      configPath: 'instances/fork.json',
      outputDirectory: '.generated/fork',
      remote: true,
      json: true,
      githubSummary: true,
    })
    expect(() => parseInstanceDoctorArguments(['--unknown'])).toThrow('Unknown instance doctor option')

    const cwd = await workspace()
    const report = await diagnoseInstance({ cwd, env: readyEnvironment() })
    expect(renderInstanceDoctorText(report)).toContain('READY')
    expect(renderInstanceDoctorMarkdown(report)).toContain('**Result: READY**')
    expect(renderInstanceDoctorMarkdown(report)).toContain('| Deploy | ✅ Ready |')
  })
})
