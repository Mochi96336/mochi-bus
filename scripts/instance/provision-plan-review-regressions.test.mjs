import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  compileInstanceConfig,
  writeCompiledInstance,
} from './config.mjs'
import { buildProvisioningPlan } from './provision-plan.mjs'

const workflow = readFileSync(
  new URL('../../.github/workflows/instance-provisioning-plan.yml', import.meta.url),
  'utf8',
)
const temporaryDirectories = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function starterConfig() {
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
  }
}

async function fixture(config, { compile = false } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'mochi-provision-review-'))
  temporaryDirectories.push(cwd)
  await writeFile(join(cwd, 'instance.json'), `${JSON.stringify(config, null, 2)}\n`)
  if (compile) {
    await writeCompiledInstance(
      compileInstanceConfig(config),
      join(cwd, '.generated/instance'),
      { workingDirectory: cwd },
    )
  }
  return cwd
}

describe('provisioning plan review regressions', () => {
  it('blocks malformed non-empty D1 and R2 identity instead of printing resource commands', async () => {
    const config = starterConfig()
    config.cloudflare.d1.databaseId = 'pending'
    config.cloudflare.r2.bucketName = 'Bad Bucket!'
    const cwd = await fixture(config)

    const plan = await buildProvisioningPlan({ cwd, configPath: 'instance.json', env: {} })
    const d1 = plan.steps.find((step) => step.id === 'cloudflare-d1')
    const r2 = plan.steps.find((step) => step.id === 'cloudflare-r2')

    expect(d1.status).toBe('blocked')
    expect(d1.detail).toContain('valid D1 UUID')
    expect(d1.commands).toEqual([])
    expect(r2.status).toBe('blocked')
    expect(r2.detail).toContain('resource-name format')
    expect(r2.commands).toEqual([])
  })

  it('blocks malformed D1 names before suggesting database creation', async () => {
    const config = starterConfig()
    config.cloudflare.d1.databaseName = 'Bad Name!'
    const cwd = await fixture(config)

    const plan = await buildProvisioningPlan({ cwd, configPath: 'instance.json', env: {} })
    const d1 = plan.steps.find((step) => step.id === 'cloudflare-d1')

    expect(d1.status).toBe('blocked')
    expect(d1.detail).toContain('resource-name format')
    expect(d1.commands).toEqual([])
  })

  it('does not treat local environment values as confirmed GitHub configuration', async () => {
    const cwd = await fixture(starterConfig(), { compile: true })
    const local = await buildProvisioningPlan({
      cwd,
      configPath: 'instance.json',
      env: {
        MOCHI_BUS_INSTANCE_CONFIG: 'instance.json',
        TDX_CLIENT_ID: 'local-value',
      },
    })
    const actions = await buildProvisioningPlan({
      cwd,
      configPath: 'instance.json',
      env: {
        GITHUB_ACTIONS: 'true',
        MOCHI_BUS_INSTANCE_CONFIG: 'instance.json',
        TDX_CLIENT_ID: 'configured',
      },
    })

    expect(local.steps.find((step) => step.id === 'github-secret-tdx-client-id').status)
      .toBe('verify')
    expect(local.steps.find((step) => step.id === 'github-variable-instance-config').status)
      .toBe('verify')
    expect(actions.steps.find((step) => step.id === 'github-secret-tdx-client-id').status)
      .toBe('complete')
    expect(actions.steps.find((step) => step.id === 'github-variable-instance-config').status)
      .toBe('complete')
  })

  it('pins manual execution to the default branch and limits raw secret exposure', () => {
    expect(workflow).toContain('if: github.ref_name == github.event.repository.default_branch')
    expect(workflow).toContain('ref: ${{ github.event.repository.default_branch }}')

    const localStart = workflow.indexOf('Generate non-destructive provisioning plan\n')
    const remoteStart = workflow.indexOf('Generate non-destructive provisioning plan with remote verification')
    expect(localStart).toBeGreaterThan(-1)
    expect(remoteStart).toBeGreaterThan(localStart)

    const localBlock = workflow.slice(localStart, remoteStart)
    expect(localBlock).not.toContain('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}')
    expect(localBlock).not.toContain('CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}')
    expect(localBlock).toContain("CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID != '' && '00000000000000000000000000000000' || '' }}")

    const remoteBlock = workflow.slice(remoteStart)
    expect(remoteBlock).toContain('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}')
    expect(remoteBlock).toContain('CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}')
    for (const secret of [
      'CLOUDFLARE_DEPLOY_API_TOKEN',
      'TDX_CLIENT_ID',
      'TDX_CLIENT_SECRET',
      'R2_ACCESS_KEY_ID',
      'R2_SECRET_ACCESS_KEY',
    ]) {
      expect(remoteBlock).not.toContain(`${secret}: \${{ secrets.${secret} }}`)
    }
  })
})
