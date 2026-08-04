import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  buildInstanceBundleArtifact,
  parseInstanceBundleArtifactArguments,
  resolveBundleArtifactOutputPath,
  writeInstanceBundleArtifact,
} from './bundle-artifact.mjs'
import {
  buildInstanceBundleApply,
  main,
  parseInstanceBundleApplyArguments,
  writeInstanceBundleApply,
} from './apply-bundle.mjs'

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
    demoQuery: null,
  },
  cloudflare: {
    workerName: 'island-bus',
    workersDev: false,
    d1: {
      databaseName: 'island-transit',
      databaseId: '123e4567-e89b-42d3-a456-426614174000',
    },
    r2: { bucketName: 'island-shapes' },
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

async function withWorkspace(run, { source = `${JSON.stringify(BASE_MANIFEST, null, 2)}\n` } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'mochi-bundle-apply-'))
  await writeFile(join(cwd, 'instance.json'), source, 'utf8')
  try {
    return await run(cwd)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

async function createArtifact(cwd, changes = ['--site-name', 'Island Transit']) {
  const options = parseInstanceBundleArtifactArguments([
    '--config', 'instance.json',
    ...changes,
    '--dry-run',
  ])
  const artifact = await buildInstanceBundleArtifact(options, { cwd, env: {} })
  const target = resolveBundleArtifactOutputPath(cwd, 'review/bundle.json', 'instance.json')
  await writeInstanceBundleArtifact(artifact, target)
  return artifact
}

function applyOptions(artifact, extra = []) {
  return parseInstanceBundleApplyArguments([
    '--input', 'review/bundle.json',
    '--expect-hash', artifact.bundle.hashes.bundleHash,
    '--expect-artifact-hash', artifact.integrity.artifactHash,
    ...extra,
  ])
}

describe('instance reviewed bundle atomic apply', () => {
  test('requires both reviewed hashes and parses explicit write mode', () => {
    expect(() => parseInstanceBundleApplyArguments(['--input', 'bundle.json'])).toThrow('requires both')
    const parsed = parseInstanceBundleApplyArguments([
      'bundle.json',
      '--expect-hash', 'a'.repeat(64),
      '--expect-artifact-hash', 'b'.repeat(64),
      '--write',
      '--json',
    ])
    expect(parsed.inputPath).toBe('bundle.json')
    expect(parsed.write).toBe(true)
    expect(parsed.json).toBe(true)
  })

  test('previews a fresh reviewed proposal without changing the manifest', async () => {
    await withWorkspace(async (cwd) => {
      const artifact = await createArtifact(cwd)
      const before = await readFile(join(cwd, 'instance.json'), 'utf8')
      const plan = await buildInstanceBundleApply(applyOptions(artifact), { cwd })
      expect(plan.ready).toBe(true)
      expect(plan.changeCount).toBeGreaterThan(0)
      expect(plan.targetManifestHash).toBe(artifact.bundle.hashes.targetManifestHash)
      expect(await readFile(join(cwd, 'instance.json'), 'utf8')).toBe(before)
    })
  })

  test('writes exactly the reviewed target with atomic verification', async () => {
    await withWorkspace(async (cwd) => {
      const artifact = await createArtifact(cwd)
      const plan = await buildInstanceBundleApply(applyOptions(artifact), { cwd })
      expect(await writeInstanceBundleApply(plan)).toBe(true)
      const writtenSource = await readFile(join(cwd, 'instance.json'), 'utf8')
      expect(writtenSource.endsWith('\n')).toBe(true)
      expect(JSON.parse(writtenSource)).toEqual(artifact.bundle.proposal.manifest)
      await expect(readFile(join(cwd, 'instance.json.apply.lock'), 'utf8')).rejects.toThrow()
    })
  })

  test('preserves CRLF, indentation and trailing-newline policy', async () => {
    const source = `${JSON.stringify(BASE_MANIFEST, null, '\t').replaceAll('\n', '\r\n')}\r\n`
    await withWorkspace(async (cwd) => {
      const artifact = await createArtifact(cwd)
      const plan = await buildInstanceBundleApply(applyOptions(artifact), { cwd })
      await writeInstanceBundleApply(plan)
      const written = await readFile(join(cwd, 'instance.json'), 'utf8')
      expect(written).toContain('\r\n\t"schemaVersion"')
      expect(written.endsWith('\r\n')).toBe(true)
    }, { source })
  })

  test('blocks a valid same-value artifact instead of claiming an apply', async () => {
    await withWorkspace(async (cwd) => {
      const artifact = await createArtifact(cwd, ['--site-name', 'Island Bus'])
      const plan = await buildInstanceBundleApply(applyOptions(artifact), { cwd })
      expect(plan.ready).toBe(false)
      expect(plan.reason).toBe('no_effective_change')
    })
  })

  test('blocks stale source bytes and an already-applied target', async () => {
    await withWorkspace(async (cwd) => {
      const artifact = await createArtifact(cwd)
      await writeFile(join(cwd, 'instance.json'), `${JSON.stringify(BASE_MANIFEST)}\n`, 'utf8')
      const formatting = await buildInstanceBundleApply(applyOptions(artifact), { cwd })
      expect(formatting.ready).toBe(false)
      expect(formatting.freshness.staleKind).toBe('formatting_drift')

      await writeFile(
        join(cwd, 'instance.json'),
        `${JSON.stringify(artifact.bundle.proposal.manifest, null, 2)}\n`,
        'utf8',
      )
      const applied = await buildInstanceBundleApply(applyOptions(artifact), { cwd })
      expect(applied.ready).toBe(false)
      expect(applied.freshness.staleKind).toBe('already_applied')
    })
  })

  test('blocks tampering and expected hash mismatches', async () => {
    await withWorkspace(async (cwd) => {
      const artifact = await createArtifact(cwd)
      const wrongHash = parseInstanceBundleApplyArguments([
        '--input', 'review/bundle.json',
        '--expect-hash', 'f'.repeat(64),
        '--expect-artifact-hash', artifact.integrity.artifactHash,
      ])
      const mismatch = await buildInstanceBundleApply(wrongHash, { cwd })
      expect(mismatch.ready).toBe(false)
      expect(mismatch.freshness.status).toBe('blocked')

      const tampered = structuredClone(artifact)
      tampered.bundle.proposal.manifest.site.name = 'Tampered'
      await writeFile(join(cwd, 'review/bundle.json'), `${JSON.stringify(tampered, null, 2)}\n`, 'utf8')
      const tamper = await buildInstanceBundleApply(applyOptions(artifact), { cwd })
      expect(tamper.ready).toBe(false)
      expect(tamper.freshness.status).toBe('blocked')
    })
  })

  test('blocks config-path and instance-identity mismatches', async () => {
    await withWorkspace(async (cwd) => {
      const artifact = await createArtifact(cwd)
      await writeFile(join(cwd, 'other.json'), `${JSON.stringify(BASE_MANIFEST, null, 2)}\n`, 'utf8')
      const other = await buildInstanceBundleApply(applyOptions(artifact, ['--config', 'other.json']), { cwd })
      expect(other.ready).toBe(false)
      expect(other.freshness.status).toBe('blocked')

      const changed = structuredClone(BASE_MANIFEST)
      changed.instanceId = 'other-instance'
      await writeFile(join(cwd, 'instance.json'), `${JSON.stringify(changed, null, 2)}\n`, 'utf8')
      const identity = await buildInstanceBundleApply(applyOptions(artifact), { cwd })
      expect(identity.ready).toBe(false)
      expect(identity.freshness.status).toBe('blocked')
    })
  })

  test('refuses source drift after preview and leaves the newer file intact', async () => {
    await withWorkspace(async (cwd) => {
      const artifact = await createArtifact(cwd)
      const plan = await buildInstanceBundleApply(applyOptions(artifact), { cwd })
      const changed = structuredClone(BASE_MANIFEST)
      changed.site.name = 'Changed after preview'
      const changedSource = `${JSON.stringify(changed, null, 2)}\n`
      await writeFile(join(cwd, 'instance.json'), changedSource, 'utf8')
      await expect(writeInstanceBundleApply(plan)).rejects.toThrow('changed after review')
      expect(await readFile(join(cwd, 'instance.json'), 'utf8')).toBe(changedSource)
    })
  })

  test('respects an existing apply lock without deleting it', async () => {
    await withWorkspace(async (cwd) => {
      const artifact = await createArtifact(cwd)
      const plan = await buildInstanceBundleApply(applyOptions(artifact), { cwd })
      const lockPath = join(cwd, 'instance.json.apply.lock')
      await writeFile(lockPath, 'owned by another process\n', 'utf8')
      await expect(writeInstanceBundleApply(plan)).rejects.toThrow('apply lock already exists')
      expect(await readFile(lockPath, 'utf8')).toBe('owned by another process\n')
    })
  })

  test('rejects symlink manifests through the freshness boundary', async () => {
    await withWorkspace(async (cwd) => {
      const artifact = await createArtifact(cwd)
      await writeFile(join(cwd, 'real.json'), `${JSON.stringify(BASE_MANIFEST, null, 2)}\n`, 'utf8')
      await rm(join(cwd, 'instance.json'))
      await symlink(join(cwd, 'real.json'), join(cwd, 'instance.json'))
      const plan = await buildInstanceBundleApply(applyOptions(artifact), { cwd })
      expect(plan.ready).toBe(false)
      expect(plan.freshness.status).toBe('blocked')
    })
  })

  test('main prints a complete blocked report before failing closed', async () => {
    await withWorkspace(async (cwd) => {
      const artifact = await createArtifact(cwd)
      const changed = structuredClone(BASE_MANIFEST)
      changed.site.name = 'Drifted'
      await writeFile(join(cwd, 'instance.json'), `${JSON.stringify(changed, null, 2)}\n`, 'utf8')
      let stdout = ''
      await expect(main({
        cwd,
        argv: [
          '--input', 'review/bundle.json',
          '--expect-hash', artifact.bundle.hashes.bundleHash,
          '--expect-artifact-hash', artifact.integrity.artifactHash,
        ],
        stdout: { write(value) { stdout += value } },
      })).rejects.toThrow('blocked')
      expect(stdout).toContain('BLOCKED')
      expect(stdout).toContain('NO FILE WAS CHANGED')
    })
  })
})
