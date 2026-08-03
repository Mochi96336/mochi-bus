import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { validateInstanceConfig } from './config.mjs'
import { buildProvisioningPlan } from './provision-plan.mjs'
import {
  buildInstanceManifest,
  parseInstanceInitArguments,
  renderInstanceInitJson,
  writeInstanceManifest,
} from './init.mjs'

describe('instance manifest initializer', () => {
  test('parses positional IDs, repeated city lists and explicit resource names', () => {
    expect(parseInstanceInitArguments([
      'island-bus',
      '--profile=managed',
      '--cities', 'Chiayi,Tainan',
      '--cities=Kaohsiung',
      '--default-city', 'Tainan',
      '--worker-name', 'island-worker',
      '--d1-name=island-data',
      '--r2-name', 'island-shapes',
      '--output', 'instances/island.json',
    ])).toMatchObject({
      instanceId: 'island-bus',
      profile: 'managed',
      cities: ['Chiayi', 'Tainan', 'Kaohsiung'],
      defaultCity: 'Tainan',
      workerName: 'island-worker',
      d1DatabaseName: 'island-data',
      r2BucketName: 'island-shapes',
      outputPath: 'instances/island.json',
    })
  })

  test('builds a deterministic starter manifest that passes strict validation', () => {
    const options = parseInstanceInitArguments([
      '--instance-id', 'chiayi-bus',
      '--cities', 'Chiayi',
    ])
    const first = buildInstanceManifest(options, { cwd: '/workspace/mochi-bus' })
    const second = buildInstanceManifest(options, { cwd: '/workspace/mochi-bus' })

    expect(first.manifest).toEqual(second.manifest)
    expect(first.manifest).toMatchObject({
      $schema: './config/instance.schema.json',
      instanceId: 'chiayi-bus',
      site: { name: 'Chiayi Bus', canonicalOrigin: 'request' },
      transit: { enabledCities: ['Chiayi'], defaultCity: 'Chiayi', demoQuery: null },
      cloudflare: {
        workerName: 'chiayi-bus',
        workersDev: true,
        d1: { databaseName: 'chiayi-transit', databaseId: null },
        r2: { bucketName: 'chiayi-transit-shapes' },
      },
      operations: {
        profile: 'starter',
        snapshotSchedule: 'manual',
        releaseSmoke: true,
        publicProbe: false,
        windowWatchdog: false,
      },
    })
    expect(() => validateInstanceConfig(first.manifest)).not.toThrow()
    expect(first.strictValidation.valid).toBe(true)
    expect(first.provisioningDraft).toBe(false)
  })

  test('managed profile enables scheduled operations while keeping request-derived origin portable', () => {
    const result = buildInstanceManifest(parseInstanceInitArguments([
      'south-bus',
      '--profile', 'managed',
      '--cities', 'Tainan,Kaohsiung',
    ]), { cwd: '/workspace/mochi-bus' })

    expect(result.manifest.site.canonicalOrigin).toBe('request')
    expect(result.manifest.operations).toEqual({
      profile: 'managed',
      snapshotSchedule: 'daily',
      releaseSmoke: true,
      publicProbe: true,
      windowWatchdog: true,
    })
    expect(() => validateInstanceConfig(result.manifest)).not.toThrow()
  })

  test('creates an operator provisioning draft and feeds it directly to the plan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mochi-init-operator-'))
    const result = buildInstanceManifest(parseInstanceInitArguments([
      'operator-bus',
      '--profile', 'operator',
      '--cities', 'Taipei,NewTaipei',
      '--origin', 'https://bus.example.com',
    ]), { cwd: root })

    expect(result.provisioningDraft).toBe(true)
    expect(result.strictValidation.valid).toBe(false)
    expect(result.strictValidation.errors.join('\n')).toMatch(/databaseId is required/)
    expect(result.strictValidation.errors.join('\n')).toMatch(/namespace IDs are required/)
    expect(result.manifest.cloudflare.workersDev).toBe(false)
    await writeInstanceManifest(result)

    const plan = await buildProvisioningPlan({
      cwd: root,
      env: {},
      configPath: result.outputPath,
      outputDirectory: join(root, '.generated/operator'),
    })
    expect(plan.instance).toMatchObject({ id: 'operator-bus', profile: 'operator' })
    expect(plan.nonDestructive).toBe(true)
    expect(plan.steps.some((step) => step.id === 'cloudflare-d1' && step.status === 'action_required')).toBe(true)
    expect(plan.steps.some((step) => step.id === 'rate-limit-namespaces' && step.status === 'action_required')).toBe(true)
  })

  test('produces a strictly valid operator manifest when all provisioned IDs are supplied', () => {
    const result = buildInstanceManifest(parseInstanceInitArguments([
      'operator-bus',
      '--profile', 'operator',
      '--cities', 'Taipei',
      '--origin', 'https://bus.example.com',
      '--database-id', '123e4567-e89b-42d3-a456-426614174000',
      '--standard-rate-limit-id', '41001',
      '--expensive-rate-limit-id', '41002',
    ]), { cwd: '/workspace/mochi-bus' })

    expect(result.strictValidation.valid).toBe(true)
    expect(result.provisioningDraft).toBe(false)
    expect(() => validateInstanceConfig(result.manifest)).not.toThrow()
  })

  test('rejects resource names Cloudflare cannot provision', () => {
    expect(() => buildInstanceManifest(parseInstanceInitArguments([
      'edge-', '--cities', 'Chiayi',
    ]), { cwd: '/workspace/mochi-bus' })).toThrow(/end with a lowercase letter or number/)

    expect(() => buildInstanceManifest(parseInstanceInitArguments([
      'edge-bus', '--cities', 'Chiayi', '--worker-name', 'edge-',
    ]), { cwd: '/workspace/mochi-bus' })).toThrow(/--worker-name/)

    expect(() => buildInstanceManifest(parseInstanceInitArguments([
      'edge-bus', '--cities', 'Chiayi', '--r2-name', 'x',
    ]), { cwd: '/workspace/mochi-bus' })).toThrow(/--r2-name/)

    const valid = buildInstanceManifest(parseInstanceInitArguments([
      'edge-bus', '--cities', 'Chiayi',
    ]), { cwd: '/workspace/mochi-bus' }).manifest
    const trailingWorker = structuredClone(valid)
    trailingWorker.cloudflare.workerName = 'edge-'
    expect(() => validateInstanceConfig(trailingWorker)).toThrow(/workerName has an invalid format/)
    const shortBucket = structuredClone(valid)
    shortBucket.cloudflare.r2.bucketName = 'x'
    expect(() => validateInstanceConfig(shortBucket)).toThrow(/bucketName has an invalid format/)
  })

  test('requires positive rate-limit namespace IDs', () => {
    expect(() => buildInstanceManifest(parseInstanceInitArguments([
      'operator-bus',
      '--profile', 'operator',
      '--cities', 'Taipei',
      '--origin', 'https://bus.example.com',
      '--database-id', '123e4567-e89b-42d3-a456-426614174000',
      '--standard-rate-limit-id', '0',
      '--expensive-rate-limit-id', '00',
    ]), { cwd: '/workspace/mochi-bus' })).toThrow(/--standard-rate-limit-id has an invalid value/)

    const valid = buildInstanceManifest(parseInstanceInitArguments([
      'operator-bus',
      '--profile', 'operator',
      '--cities', 'Taipei',
      '--origin', 'https://bus.example.com',
      '--database-id', '123e4567-e89b-42d3-a456-426614174000',
      '--standard-rate-limit-id', '41001',
      '--expensive-rate-limit-id', '41002',
    ]), { cwd: '/workspace/mochi-bus' }).manifest
    const zeroNamespace = structuredClone(valid)
    zeroNamespace.cloudflare.rateLimits.standardNamespaceId = '0'
    expect(() => validateInstanceConfig(zeroNamespace)).toThrow(/standardNamespaceId has an invalid format/)
  })

  test('refuses unsafe output paths and invalid operator origins', () => {
    expect(() => buildInstanceManifest(parseInstanceInitArguments([
      'unsafe-bus', '--cities', 'Chiayi', '--output', '../outside.json',
    ]), { cwd: '/workspace/mochi-bus' })).toThrow(/must stay inside the repository/)

    expect(() => buildInstanceManifest(parseInstanceInitArguments([
      'unsafe-bus', '--cities', 'Chiayi', '--output', '.generated/instance.json',
    ]), { cwd: '/workspace/mochi-bus' })).toThrow(/cannot write inside \.generated/)

    expect(() => buildInstanceManifest(parseInstanceInitArguments([
      'unsafe-bus', '--cities', 'Chiayi', '--output', 'examples/node_modules/instance.json',
    ]), { cwd: '/workspace/mochi-bus' })).toThrow(/cannot write inside node_modules/)

    expect(() => buildInstanceManifest(parseInstanceInitArguments([
      'unsafe-bus', '--cities', 'Chiayi', '--output', '.GIT/instance.json',
    ]), { cwd: '/workspace/mochi-bus' })).toThrow(/cannot write inside \.GIT/)

    expect(() => buildInstanceManifest(parseInstanceInitArguments([
      'operator-bus', '--profile', 'operator', '--cities', 'Taipei', '--origin', 'request',
    ]), { cwd: '/workspace/mochi-bus' })).toThrow(/not allowed for operator/)
  })

  test('refuses output paths whose existing ancestors are symbolic links or junctions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mochi-init-link-root-'))
    const outside = await mkdtemp(join(tmpdir(), 'mochi-init-link-outside-'))
    await mkdir(join(root, 'instances'))
    await symlink(outside, join(root, 'instances', 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    const result = buildInstanceManifest(parseInstanceInitArguments([
      'linked-bus', '--cities', 'Chiayi', '--output', 'instances/linked/instance.json',
    ]), { cwd: root })

    await expect(writeInstanceManifest(result)).rejects.toThrow(/symbolic links or junctions/)
  })

  test('does not overwrite an existing manifest unless force is explicit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mochi-init-overwrite-'))
    const result = buildInstanceManifest(parseInstanceInitArguments([
      'first-bus', '--cities', 'Chiayi',
    ]), { cwd: root })
    await writeFile(result.outputPath, '{"existing":true}\n', 'utf8')

    await expect(writeInstanceManifest(result)).rejects.toThrow(/already exists/)
    expect(JSON.parse(await readFile(result.outputPath, 'utf8'))).toEqual({ existing: true })

    await writeInstanceManifest(result, { force: true })
    expect(JSON.parse(await readFile(result.outputPath, 'utf8')).instanceId).toBe('first-bus')
  })

  test('keeps machine-readable output secret-free and reports draft state', () => {
    const result = buildInstanceManifest(parseInstanceInitArguments([
      'operator-bus',
      '--profile', 'operator',
      '--cities', 'Taipei',
      '--origin', 'https://bus.example.com',
    ]), { cwd: '/workspace/mochi-bus' })
    const output = JSON.stringify(renderInstanceInitJson(result, { dryRun: true }))

    expect(output).toContain('"provisioningDraft":true')
    expect(output).not.toMatch(/TDX_CLIENT_SECRET|CLOUDFLARE_API_TOKEN|R2_SECRET_ACCESS_KEY/)
  })
})
