import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  compileInstanceConfig,
  writeCompiledInstance,
} from './config.mjs'
import {
  buildProvisioningPlan,
  parseProvisioningPlanArguments,
  renderProvisioningPlanMarkdown,
  renderProvisioningPlanText,
} from './provision-plan.mjs'

const databaseId = '123e4567-e89b-42d3-a456-426614174000'
const temporaryDirectories = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function starterConfig(overrides = {}) {
  return {
    schemaVersion: 1,
    instanceId: 'chiayi-starter',
    site: { name: 'Chiayi Bus', canonicalOrigin: 'request' },
    transit: { enabledCities: ['Chiayi'], defaultCity: 'Chiayi', demoQuery: null },
    cloudflare: {
      workerName: 'chiayi-bus',
      workersDev: true,
      d1: { databaseName: 'chiayi-transit', databaseId: null },
      r2: { bucketName: 'chiayi-shapes' },
      rateLimits: { standardNamespaceId: null, expensiveNamespaceId: null },
    },
    operations: {
      profile: 'starter',
      snapshotSchedule: 'manual',
      releaseSmoke: false,
      publicProbe: false,
      windowWatchdog: false,
    },
    ...overrides,
  }
}

function operatorConfig(overrides = {}) {
  return {
    schemaVersion: 1,
    instanceId: 'operator-bus',
    site: { name: 'Operator Bus', canonicalOrigin: 'https://bus.example' },
    transit: {
      enabledCities: ['Taipei', 'Chiayi'],
      defaultCity: 'Taipei',
      demoQuery: {
        city: 'Taipei',
        routeName: '307',
        stopName: 'Example stop',
        stopUid: 'TPE0001',
        routeUid: 'TPE0001',
        direction: 0,
      },
    },
    cloudflare: {
      workerName: 'operator-bus',
      workersDev: false,
      d1: { databaseName: 'operator-transit', databaseId },
      r2: { bucketName: 'operator-shapes' },
      rateLimits: { standardNamespaceId: '1001', expensiveNamespaceId: '1002' },
    },
    operations: {
      profile: 'operator',
      snapshotSchedule: 'daily',
      releaseSmoke: true,
      publicProbe: true,
      windowWatchdog: true,
    },
    ...overrides,
  }
}

function managedRequestConfig() {
  const config = operatorConfig()
  config.instanceId = 'managed-bus'
  config.site = { name: 'Managed Bus', canonicalOrigin: 'request' }
  config.cloudflare = {
    ...config.cloudflare,
    workerName: 'managed-bus',
    workersDev: true,
    rateLimits: { standardNamespaceId: null, expensiveNamespaceId: null },
  }
  config.operations = { ...config.operations, profile: 'managed' }
  return config
}

async function fixture(config, { compile = true } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'mochi-provision-plan-'))
  temporaryDirectories.push(cwd)
  const configPath = join(cwd, 'instance.json')
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`)
  if (compile) {
    await writeCompiledInstance(
      compileInstanceConfig(config),
      join(cwd, '.generated/instance'),
      { workingDirectory: cwd },
    )
  }
  return { cwd, configPath }
}

function completeEnv() {
  return {
    MOCHI_BUS_INSTANCE_CONFIG: 'instance.json',
    CLOUDFLARE_DEPLOY_API_TOKEN: 'deploy-secret',
    CLOUDFLARE_API_TOKEN: 'operations-secret',
    CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
    TDX_CLIENT_ID: 'tdx-id',
    TDX_CLIENT_SECRET: 'tdx-secret',
    R2_ACCESS_KEY_ID: 'r2-id',
    R2_SECRET_ACCESS_KEY: 'opaque-sensitive-value-7f3b91',
  }
}

function cloudflareResponse(result) {
  return new Response(JSON.stringify({ success: true, result }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('instance provisioning plan', () => {
  it('parses explicit paths and reporting modes', () => {
    expect(parseProvisioningPlanArguments([
      '--config', 'instances/fork.json',
      '--out-dir=.generated/fork',
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
    expect(() => parseProvisioningPlanArguments(['--unknown']))
      .toThrow('Unknown provisioning plan option')
  })

  it('turns an unprovisioned starter into concrete D1, R2 and GitHub setup steps', async () => {
    const { cwd } = await fixture(starterConfig())
    const plan = await buildProvisioningPlan({ cwd, configPath: 'instance.json', env: {} })

    const d1 = plan.steps.find((step) => step.id === 'cloudflare-d1')
    expect(d1.status).toBe('action_required')
    expect(d1.commands).toEqual(["npx wrangler d1 create 'chiayi-transit'"])
    expect(d1.manualActions.join(' ')).toContain('cloudflare.d1.databaseId')

    const r2 = plan.steps.find((step) => step.id === 'cloudflare-r2')
    expect(r2.status).toBe('verify')
    expect(r2.commands.join(' ')).toContain("wrangler r2 bucket create 'chiayi-shapes'")

    expect(plan.steps.find((step) => step.id === 'github-secret-r2-access-key-id').status)
      .toBe('optional')
    expect(plan.steps.find((step) => step.id === 'github-variable-instance-config').commands)
      .toEqual(["gh variable set MOCHI_BUS_INSTANCE_CONFIG --body 'instance.json'"])
    expect(plan.ready).toBe(false)
  })

  it('marks verified operator resources complete and never includes secret values', async () => {
    const { cwd } = await fixture(operatorConfig())
    const fetchImpl = vi.fn(async (url) => String(url).includes('/d1/database/')
      ? cloudflareResponse({ uuid: databaseId, name: 'operator-transit' })
      : cloudflareResponse({ name: 'operator-shapes' }))
    const env = completeEnv()
    const plan = await buildProvisioningPlan({
      cwd,
      configPath: 'instance.json',
      env,
      remote: true,
      fetchImpl,
    })

    expect(plan.steps.find((step) => step.id === 'cloudflare-d1').status).toBe('complete')
    expect(plan.steps.find((step) => step.id === 'cloudflare-r2').status).toBe('complete')
    expect(plan.steps.find((step) => step.id === 'rate-limit-namespaces').status).toBe('complete')
    expect(plan.summary.actionRequired).toBe(0)
    expect(plan.summary.blocked).toBe(0)
    expect(plan.ready).toBe(true)

    const rendered = `${JSON.stringify(plan)}\n${renderProvisioningPlanText(plan)}\n${renderProvisioningPlanMarkdown(plan)}`
    for (const [name, secret] of Object.entries(env)) {
      if (name === 'MOCHI_BUS_INSTANCE_CONFIG') continue
      expect(rendered).not.toContain(secret)
    }
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('plans request-derived origins and every missing managed workflow secret', async () => {
    const { cwd } = await fixture(managedRequestConfig())
    const plan = await buildProvisioningPlan({ cwd, configPath: 'instance.json', env: {} })

    expect(plan.steps.find((step) => step.id === 'github-variable-release-smoke-origin').commands)
      .toEqual(["gh variable set RELEASE_SMOKE_ORIGIN --body 'https://your-domain.example'"])
    expect(plan.steps.find((step) => step.id === 'github-variable-snapshot-smoke-base-url').status)
      .toBe('action_required')
    expect(plan.steps.find((step) => step.id === 'github-secret-cloudflare-deploy-api-token').status)
      .toBe('action_required')
    expect(plan.steps.find((step) => step.id === 'github-secret-r2-secret-access-key').status)
      .toBe('action_required')
  })

  it('reports stale generated artifacts with one explicit compile command', async () => {
    const { cwd } = await fixture(starterConfig())
    const operationsPath = join(cwd, '.generated/instance/operations-plan.json')
    const operations = JSON.parse(await readFile(operationsPath, 'utf8'))
    operations.checks.releaseSmoke = true
    await writeFile(operationsPath, `${JSON.stringify(operations, null, 2)}\n`)

    const plan = await buildProvisioningPlan({ cwd, configPath: 'instance.json', env: {} })
    const generated = plan.steps.find((step) => step.id === 'generated-artifacts')
    expect(generated.status).toBe('action_required')
    expect(generated.commands).toEqual([
      "npm run instance:compile -- --config 'instance.json' --out-dir '.generated/instance'",
    ])
  })

  it('still produces D1 and rate-limit repair actions for an invalid operator draft', async () => {
    const invalid = operatorConfig()
    invalid.cloudflare.d1.databaseId = null
    invalid.cloudflare.rateLimits = { standardNamespaceId: null, expensiveNamespaceId: null }
    const { cwd } = await fixture(invalid, { compile: false })

    const plan = await buildProvisioningPlan({ cwd, configPath: 'instance.json', env: {} })
    expect(plan.steps.find((step) => step.id === 'manifest').status).toBe('blocked')
    expect(plan.steps.find((step) => step.id === 'cloudflare-d1').commands)
      .toEqual(["npx wrangler d1 create 'operator-transit'"])
    expect(plan.steps.find((step) => step.id === 'rate-limit-namespaces').status)
      .toBe('action_required')
    expect(plan.steps.find((step) => step.id === 'rate-limit-namespaces').manualActions.join(' '))
      .toContain('standardNamespaceId')
  })
})
