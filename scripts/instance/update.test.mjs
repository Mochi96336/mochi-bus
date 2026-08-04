import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  buildInstanceManifest,
  parseInstanceInitArguments,
  writeInstanceManifest,
} from './init.mjs'
import { buildProvisioningPlan } from './provision-plan.mjs'
import {
  buildInstanceUpdate,
  main,
  parseInstanceUpdateArguments,
  renderInstanceUpdateJson,
  writeInstanceUpdate,
} from './update.mjs'

const repositoryRoot = resolve(import.meta.dirname, '../..')
const productionPath = join(repositoryRoot, 'instances/mochi-production.json')

async function createManifest(root, args) {
  const result = buildInstanceManifest(parseInstanceInitArguments([
    ...args,
    '--output', 'instance.json',
  ]), { cwd: root })
  await writeInstanceManifest(result)
  return result.outputPath
}

async function copyProduction(root) {
  const path = join(root, 'instance.json')
  await copyFile(productionPath, path)
  return path
}

describe('instance manifest updater', () => {
  test('parses preview, profile, city, resource and operation updates', () => {
    expect(parseInstanceUpdateArguments([
      '--config=instances/south.json',
      '--profile', 'managed',
      '--add-city', 'Tainan,Kaohsiung',
      '--remove-city=Chiayi',
      '--default-city', 'Tainan',
      '--d1-name', 'south-data',
      '--database-id=null',
      '--workers-dev=false',
      '--snapshot-schedule', 'taipei-weekly-sharded',
      '--public-probe=true',
      '--clear-demo-query',
      '--write',
      '--json',
    ])).toMatchObject({
      configPath: 'instances/south.json',
      profile: 'managed',
      addCities: ['Tainan', 'Kaohsiung'],
      removeCities: ['Chiayi'],
      defaultCity: 'Tainan',
      d1DatabaseName: 'south-data',
      databaseId: null,
      workersDev: false,
      snapshotSchedule: 'taipei-weekly-sharded',
      publicProbe: true,
      clearDemoQuery: true,
      write: true,
      json: true,
    })
  })

  test('changes profile and city scope while preserving provisioned IDs and demo query', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mochi-update-profile-'))
    const configPath = await copyProduction(root)
    const original = JSON.parse(await readFile(configPath, 'utf8'))
    const result = await buildInstanceUpdate(parseInstanceUpdateArguments([
      '--config', 'instance.json',
      '--profile', 'managed',
      '--cities', 'Taipei,Chiayi',
      '--default-city', 'Taipei',
    ]), { cwd: root, env: {} })

    expect(result.strictValidation.valid).toBe(true)
    expect(result.manifest.operations).toEqual({
      profile: 'managed',
      snapshotSchedule: 'daily',
      releaseSmoke: true,
      publicProbe: true,
      windowWatchdog: true,
    })
    expect(result.manifest.cloudflare.workersDev).toBe(true)
    expect(result.manifest.cloudflare.d1.databaseId).toBe(original.cloudflare.d1.databaseId)
    expect(result.manifest.cloudflare.rateLimits).toEqual(original.cloudflare.rateLimits)
    expect(result.manifest.transit.demoQuery).toEqual(original.transit.demoQuery)
    expect(result.changes.map((change) => change.path)).toEqual(expect.arrayContaining([
      'transit.enabledCities',
      'cloudflare.workersDev',
      'operations.profile',
      'operations.snapshotSchedule',
    ]))
  })

  test('adds and removes cities in order when the default replacement is explicit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mochi-update-cities-'))
    await createManifest(root, ['chiayi-bus', '--cities', 'Chiayi'])
    const result = await buildInstanceUpdate(parseInstanceUpdateArguments([
      '--config', 'instance.json',
      '--add-city', 'Tainan,Kaohsiung',
      '--remove-city', 'Chiayi',
      '--default-city', 'Tainan',
    ]), { cwd: root, env: {} })

    expect(result.manifest.transit.enabledCities).toEqual(['Tainan', 'Kaohsiung'])
    expect(result.manifest.transit.defaultCity).toBe('Tainan')
    expect(result.strictValidation.valid).toBe(true)
  })

  test('refuses to silently replace a removed default city', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mochi-update-default-'))
    await createManifest(root, ['chiayi-bus', '--cities', 'Chiayi,Tainan'])

    await expect(buildInstanceUpdate(parseInstanceUpdateArguments([
      '--config', 'instance.json',
      '--remove-city', 'Chiayi',
    ]), { cwd: root, env: {} })).rejects.toThrow(/removes default city Chiayi/)
  })

  test('preserves demo query unless clearing it is explicit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mochi-update-demo-'))
    await copyProduction(root)
    const args = [
      '--config', 'instance.json',
      '--cities', 'Chiayi',
      '--default-city', 'Chiayi',
    ]

    await expect(buildInstanceUpdate(parseInstanceUpdateArguments(args), {
      cwd: root,
      env: {},
    })).rejects.toThrow(/removes demo query city Taipei/)

    const result = await buildInstanceUpdate(parseInstanceUpdateArguments([
      ...args,
      '--clear-demo-query',
    ]), { cwd: root, env: {} })
    expect(result.manifest.transit.demoQuery).toBeNull()
    expect(result.warnings.join('\n')).toMatch(/explicitly cleared/)
  })

  test('turns a managed manifest into an operator provisioning draft and hands it to the planner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mochi-update-operator-'))
    await createManifest(root, [
      'operator-bus',
      '--profile', 'managed',
      '--cities', 'Taipei,NewTaipei',
      '--origin', 'https://bus.example.com',
    ])
    const result = await buildInstanceUpdate(parseInstanceUpdateArguments([
      '--config', 'instance.json',
      '--profile', 'operator',
    ]), { cwd: root, env: {} })

    expect(result.provisioningDraft).toBe(true)
    expect(result.strictValidation.errors.join('\n')).toMatch(/databaseId is required/)
    expect(result.strictValidation.errors.join('\n')).toMatch(/namespace IDs are required/)
    expect(result.manifest.cloudflare.workersDev).toBe(false)
    await writeInstanceUpdate(result)

    const plan = await buildProvisioningPlan({
      cwd: root,
      env: {},
      configPath: join(root, 'instance.json'),
      outputDirectory: join(root, '.generated/operator'),
    })
    expect(plan.steps.some((step) => step.id === 'cloudflare-d1' && step.status === 'action_required')).toBe(true)
    expect(plan.steps.some((step) => step.id === 'rate-limit-namespaces' && step.status === 'action_required')).toBe(true)
  })

  test('rejects non-provisioning operator violations instead of calling them drafts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mochi-update-operator-invalid-'))
    await createManifest(root, [
      'managed-bus',
      '--profile', 'managed',
      '--cities', 'Taipei',
    ])

    await expect(buildInstanceUpdate(parseInstanceUpdateArguments([
      '--config', 'instance.json',
      '--profile', 'operator',
    ]), { cwd: root, env: {} })).rejects.toThrow(/canonicalOrigin must be fixed/)

    await expect(buildInstanceUpdate(parseInstanceUpdateArguments([
      '--config', 'instance.json',
      '--profile', 'operator',
      '--origin', 'https://bus.example.com',
      '--workers-dev', 'true',
    ]), { cwd: root, env: {} })).rejects.toThrow(/workersDev must be false/)
  })

  test('preserves identities during resource renames and reports verification warnings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mochi-update-resource-'))
    const configPath = await copyProduction(root)
    const original = JSON.parse(await readFile(configPath, 'utf8'))
    const result = await buildInstanceUpdate(parseInstanceUpdateArguments([
      '--config', 'instance.json',
      '--worker-name', 'renamed-worker',
      '--d1-name', 'renamed-data',
      '--r2-name', 'renamed-shapes',
    ]), { cwd: root, env: {} })

    expect(result.manifest.cloudflare.d1.databaseId).toBe(original.cloudflare.d1.databaseId)
    expect(result.manifest.cloudflare.rateLimits).toEqual(original.cloudflare.rateLimits)
    expect(result.warnings.join('\n')).toMatch(/D1 database name changed/)
    expect(result.warnings.join('\n')).toMatch(/R2 bucket name changed/)
    expect(result.warnings.join('\n')).toMatch(/Worker name changed/)
  })

  test('previews by default and writes only when requested', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mochi-update-preview-'))
    const configPath = await createManifest(root, ['chiayi-bus', '--cities', 'Chiayi'])
    const before = await readFile(configPath, 'utf8')
    let output = ''
    await main({
      argv: ['--config', 'instance.json', '--site-name', 'Updated Bus'],
      cwd: root,
      env: {},
      stdout: { write(value) { output += value } },
    })

    expect(await readFile(configPath, 'utf8')).toBe(before)
    expect(output).toMatch(/NO FILE WAS CHANGED/)
    expect(output).toMatch(/site\.name/)

    await main({
      argv: ['--config', 'instance.json', '--site-name', 'Updated Bus', '--write'],
      cwd: root,
      env: {},
      stdout: { write() {} },
    })
    expect(JSON.parse(await readFile(configPath, 'utf8')).site.name).toBe('Updated Bus')
  })

  test('refuses a stale write when the manifest changed after preview', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mochi-update-stale-'))
    const configPath = await createManifest(root, ['chiayi-bus', '--cities', 'Chiayi'])
    const result = await buildInstanceUpdate(parseInstanceUpdateArguments([
      '--config', 'instance.json',
      '--site-name', 'Proposed Bus',
    ]), { cwd: root, env: {} })
    const external = JSON.parse(await readFile(configPath, 'utf8'))
    external.site.name = 'External Change'
    await writeFile(configPath, `${JSON.stringify(external, null, 2)}\n`, 'utf8')

    await expect(writeInstanceUpdate(result)).rejects.toThrow(/changed after preview/)
    expect(JSON.parse(await readFile(configPath, 'utf8')).site.name).toBe('External Change')
  })

  test('treats an explicit same-value update as a no-op', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mochi-update-noop-'))
    const configPath = await createManifest(root, ['chiayi-bus', '--cities', 'Chiayi'])
    const before = await readFile(configPath, 'utf8')
    const result = await buildInstanceUpdate(parseInstanceUpdateArguments([
      '--config', 'instance.json',
      '--site-name', 'Chiayi Bus',
    ]), { cwd: root, env: {} })

    expect(result.changed).toBe(false)
    expect(await writeInstanceUpdate(result)).toBe(false)
    expect(await readFile(configPath, 'utf8')).toBe(before)
  })

  test('confines editable manifests to regular JSON files inside the repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mochi-update-path-'))
    const outside = await mkdtemp(join(tmpdir(), 'mochi-update-outside-'))
    await createManifest(outside, ['outside-bus', '--cities', 'Chiayi'])
    await mkdir(join(root, '.generated'), { recursive: true })
    await writeFile(join(root, '.generated/instance.json'), '{}\n', 'utf8')

    await expect(buildInstanceUpdate(parseInstanceUpdateArguments([
      '--config', join(outside, 'instance.json'),
      '--site-name', 'Outside',
    ]), { cwd: root, env: {} })).rejects.toThrow(/must stay inside the repository/)

    await expect(buildInstanceUpdate(parseInstanceUpdateArguments([
      '--config', '.generated/instance.json',
      '--site-name', 'Generated',
    ]), { cwd: root, env: {} })).rejects.toThrow(/cannot be updated inside \.generated/)
  })

  test('keeps machine-readable output secret-free', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mochi-update-json-'))
    await createManifest(root, ['chiayi-bus', '--cities', 'Chiayi'])
    const result = await buildInstanceUpdate(parseInstanceUpdateArguments([
      '--config', 'instance.json',
      '--site-name', 'JSON Bus',
    ]), { cwd: root, env: {} })
    const output = JSON.stringify(renderInstanceUpdateJson(result))

    expect(output).toContain('"changed":true')
    expect(output).not.toMatch(/TDX_CLIENT_SECRET|CLOUDFLARE_API_TOKEN|R2_SECRET_ACCESS_KEY/)
  })
})
