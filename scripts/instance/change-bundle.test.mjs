import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  buildInstanceChangeBundle,
  main,
  parseInstanceChangeBundleArguments,
  renderInstanceChangeBundleText,
} from './change-bundle.mjs'

const BASE_MANIFEST = Object.freeze({
  $schema: '../config/instance.schema.json',
  schemaVersion: 1,
  instanceId: 'island-test',
  site: {
    name: 'Island Bus',
    canonicalOrigin: 'https://bus.example.com',
  },
  transit: {
    enabledCities: ['Taipei', 'Tainan'],
    defaultCity: 'Taipei',
    demoQuery: {
      city: 'Taipei',
      routeName: '307',
      stopName: '捷運西門站',
      stopUid: 'TPE213044',
      routeUid: 'TPE19108',
      direction: 0,
    },
  },
  cloudflare: {
    workerName: 'island-bus',
    workersDev: false,
    d1: {
      databaseName: 'island-transit',
      databaseId: '123e4567-e89b-42d3-a456-426614174000',
    },
    r2: {
      bucketName: 'island-shapes',
    },
    rateLimits: {
      standardNamespaceId: '42001',
      expensiveNamespaceId: '42002',
    },
  },
  operations: {
    profile: 'operator',
    snapshotSchedule: 'daily',
    releaseSmoke: true,
    publicProbe: true,
    windowWatchdog: true,
  },
})

async function withManifest(run, transform = (value) => value) {
  const cwd = await mkdtemp(join(tmpdir(), 'mochi-change-bundle-'))
  const manifest = transform(structuredClone(BASE_MANIFEST))
  await writeFile(join(cwd, 'instance.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  try {
    return await run({ cwd, configPath: 'instance.json' })
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

function options(configPath, changes, extra = []) {
  return parseInstanceChangeBundleArguments([
    '--config', configPath,
    ...changes,
    ...extra,
  ])
}

describe('instance change bundle', () => {
  test('parses bundle-only options without forwarding them to instance:update', () => {
    const parsed = parseInstanceChangeBundleArguments([
      '--config', 'instances/island.json',
      '--worker-name', 'island-v2',
      '--out-dir', '.generated/review',
      '--expect-hash', 'a'.repeat(64),
      '--github-summary',
      '--json',
    ])
    expect(parsed.updateOptions.configPath).toBe('instances/island.json')
    expect(parsed.updateOptions.workerName).toBe('island-v2')
    expect(parsed.outputDirectory).toBe('.generated/review')
    expect(parsed.expectedHash).toBe('a'.repeat(64))
    expect(parsed.githubSummary).toBe(true)
    expect(parsed.json).toBe(true)
  })

  test('rejects write mode and malformed expected hashes', () => {
    expect(() => parseInstanceChangeBundleArguments([
      '--config', 'instance.json',
      '--site-name', 'New name',
      '--write',
    ])).toThrow('does not accept --write')
    expect(() => parseInstanceChangeBundleArguments([
      '--config', 'instance.json',
      '--site-name', 'New name',
      '--expect-hash', 'not-a-hash',
    ])).toThrow('64-character SHA-256')
  })

  test('bundles one worker and origin proposal with matching fingerprints', async () => {
    await withManifest(async ({ cwd, configPath }) => {
      const bundle = await buildInstanceChangeBundle(options(configPath, [
        '--worker-name', 'island-v2',
        '--origin', 'https://new-bus.example.com',
      ]), { cwd, env: {} })
      expect(bundle.consistency.sameProposal).toBe(true)
      expect(bundle.proposal.changes.map((change) => change.path)).toEqual(expect.arrayContaining([
        'site.canonicalOrigin',
        'cloudflare.workerName',
      ]))
      expect(bundle.migrationPlan.risk).toBe('high')
      expect(bundle.provisioningPlan.projected).toBe(true)
      expect(bundle.doctor.projected).toBe(true)
      expect(bundle.hashes.bundleHash).toMatch(/^[a-f0-9]{64}$/)
      expect(renderInstanceChangeBundleText(bundle)).toContain('NO CHANGES WERE APPLIED')
    })
  })

  test('produces identical hashes for identical source and arguments', async () => {
    await withManifest(async ({ cwd, configPath }) => {
      const parsed = options(configPath, ['--add-city', 'Kaohsiung'])
      const first = await buildInstanceChangeBundle(parsed, { cwd, env: {} })
      const second = await buildInstanceChangeBundle(parsed, { cwd, env: {} })
      expect(second.hashes).toEqual(first.hashes)
      expect(second).toEqual(first)
    })
  })

  test('changes the bundle hash when a target value changes', async () => {
    await withManifest(async ({ cwd, configPath }) => {
      const first = await buildInstanceChangeBundle(options(configPath, [
        '--site-name', 'Island Transit',
      ]), { cwd, env: {} })
      const second = await buildInstanceChangeBundle(options(configPath, [
        '--site-name', 'Island Transit 2',
      ]), { cwd, env: {} })
      expect(second.hashes.targetManifestHash).not.toBe(first.hashes.targetManifestHash)
      expect(second.hashes.bundleHash).not.toBe(first.hashes.bundleHash)
    })
  })

  test('accepts a matching expected hash and fails closed on mismatch', async () => {
    await withManifest(async ({ cwd, configPath }) => {
      const initial = await buildInstanceChangeBundle(options(configPath, [
        '--site-name', 'Island Transit',
      ]), { cwd, env: {} })
      const verified = await buildInstanceChangeBundle(options(configPath, [
        '--site-name', 'Island Transit',
      ], ['--expect-hash', initial.hashes.bundleHash]), { cwd, env: {} })
      expect(verified.expectedHash).toEqual({
        value: initial.hashes.bundleHash,
        matched: true,
      })
      await expect(buildInstanceChangeBundle(options(configPath, [
        '--site-name', 'Island Transit',
      ], ['--expect-hash', 'f'.repeat(64)]), { cwd, env: {} })).rejects.toThrow('hash mismatch')
    })
  })

  test('projects operator provisioning drafts as deployment blockers', async () => {
    await withManifest(async ({ cwd, configPath }) => {
      const bundle = await buildInstanceChangeBundle(options(configPath, [
        '--profile', 'operator',
        '--origin', 'https://operator.example.com',
      ]), { cwd, env: {} })
      expect(bundle.provisioningDraft).toBe(true)
      expect(bundle.cutoverReady).toBe(false)
      expect(bundle.doctor.manifest.status).toBe('blocked')
      expect(bundle.provisioningPlan.steps.find((step) => step.id === 'manifest')?.status).toBe('blocked')
      expect(bundle.provisioningPlan.steps.find((step) => step.id === 'cloudflare-d1')?.status).toBe('action_required')
    }, (manifest) => {
      manifest.operations.profile = 'managed'
      manifest.cloudflare.workersDev = true
      manifest.cloudflare.d1.databaseId = null
      manifest.cloudflare.rateLimits.standardNamespaceId = null
      manifest.cloudflare.rateLimits.expensiveNamespaceId = null
      return manifest
    })
  })

  test('keeps a site-name-only bundle free of manufactured remote migration work', async () => {
    await withManifest(async ({ cwd, configPath }) => {
      const bundle = await buildInstanceChangeBundle(options(configPath, [
        '--site-name', 'Island Transit',
      ]), { cwd, env: {} })
      const remoteMigration = bundle.migrationPlan.steps.filter((step) => step.phase === 'remote-resources')
      expect(remoteMigration.every((step) => step.status === 'not_applicable')).toBe(true)
      expect(bundle.risk).toBe('medium')
    })
  })

  test('does not include credential values in text or JSON output', async () => {
    await withManifest(async ({ cwd, configPath }) => {
      const secret = 'super-sensitive-value'
      const bundle = await buildInstanceChangeBundle(options(configPath, [
        '--r2-name', 'island-shapes-v2',
      ]), {
        cwd,
        env: {
          TDX_CLIENT_SECRET: secret,
          CLOUDFLARE_API_TOKEN: secret,
          R2_SECRET_ACCESS_KEY: secret,
        },
      })
      expect(JSON.stringify(bundle)).not.toContain(secret)
      expect(renderInstanceChangeBundleText(bundle)).not.toContain(secret)
    })
  })

  test('appends a GitHub summary without changing the manifest', async () => {
    await withManifest(async ({ cwd, configPath }) => {
      const summaryPath = join(cwd, 'summary.md')
      await writeFile(summaryPath, '', 'utf8')
      const before = await readFile(join(cwd, configPath), 'utf8')
      let output = ''
      await main({
        cwd,
        env: { GITHUB_STEP_SUMMARY: summaryPath },
        argv: [
          '--config', configPath,
          '--site-name', 'Island Transit',
          '--github-summary',
        ],
        stdout: { write(value) { output += value } },
      })
      const after = await readFile(join(cwd, configPath), 'utf8')
      const summary = await readFile(summaryPath, 'utf8')
      expect(after).toBe(before)
      expect(output).toContain('NO CHANGES WERE APPLIED')
      expect(summary).toContain('instance change bundle')
      expect(summary).toContain('Bundle SHA-256')
    })
  })

  test('supports an effective no-op while retaining deterministic review hashes', async () => {
    await withManifest(async ({ cwd, configPath }) => {
      const bundle = await buildInstanceChangeBundle(options(configPath, [
        '--site-name', 'Island Bus',
      ]), { cwd, env: {} })
      expect(bundle.changed).toBe(false)
      expect(bundle.proposal.changes).toEqual([])
      expect(bundle.hashes.bundleHash).toMatch(/^[a-f0-9]{64}$/)
    })
  })
})
