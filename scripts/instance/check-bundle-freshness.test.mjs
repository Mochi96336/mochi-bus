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
  checkInstanceBundleFreshnessFile,
  main,
  parseInstanceBundleFreshnessArguments,
  readCurrentInstanceManifest,
} from './check-bundle-freshness.mjs'

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

async function withWorkspace(run) {
  const cwd = await mkdtemp(join(tmpdir(), 'mochi-bundle-freshness-'))
  await writeFile(join(cwd, 'instance.json'), `${JSON.stringify(BASE_MANIFEST, null, 2)}\n`, 'utf8')
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

function freshnessOptions(extra = []) {
  return parseInstanceBundleFreshnessArguments([
    '--input', 'review/bundle.json',
    ...extra,
  ])
}

describe('instance change-bundle freshness gate', () => {
  test('parses artifact, manifest and expected hash options', () => {
    const parsed = parseInstanceBundleFreshnessArguments([
      'review/bundle.json',
      '--config', 'instance.json',
      '--expect-hash', 'a'.repeat(64),
      '--expect-artifact-hash', 'b'.repeat(64),
      '--json',
    ])
    expect(parsed.inputPath).toBe('review/bundle.json')
    expect(parsed.configPath).toBe('instance.json')
    expect(parsed.expectedBundleHash).toBe('a'.repeat(64))
    expect(parsed.expectedArtifactHash).toBe('b'.repeat(64))
    expect(parsed.json).toBe(true)
  })

  test('reports fresh and exposes the reviewed apply command only for exact source bytes', async () => {
    await withWorkspace(async (cwd) => {
      const artifact = await createArtifact(cwd)
      const report = await checkInstanceBundleFreshnessFile(freshnessOptions([
        '--expect-hash', artifact.bundle.hashes.bundleHash,
        '--expect-artifact-hash', artifact.integrity.artifactHash,
      ]), { cwd })
      expect(report.status).toBe('fresh')
      expect(report.currentState).toBe('baseline')
      expect(report.applyAllowed).toBe(true)
      expect(report.proposal.applyCommand).toContain('instance:update')
      expect(report.source.matched).toBe(true)
      expect(report.baseline.matched).toBe(true)
    })
  })

  test('treats formatting-only source changes as stale', async () => {
    await withWorkspace(async (cwd) => {
      await createArtifact(cwd)
      await writeFile(join(cwd, 'instance.json'), `${JSON.stringify(BASE_MANIFEST)}\n`, 'utf8')
      const report = await checkInstanceBundleFreshnessFile(freshnessOptions(), { cwd })
      expect(report.status).toBe('stale')
      expect(report.staleKind).toBe('formatting_drift')
      expect(report.currentState).toBe('baseline')
      expect(report.source.matched).toBe(false)
      expect(report.baseline.matched).toBe(true)
      expect(report.applyAllowed).toBe(false)
    })
  })

  test('detects semantic drift from both baseline and target', async () => {
    await withWorkspace(async (cwd) => {
      await createArtifact(cwd)
      const changed = structuredClone(BASE_MANIFEST)
      changed.site.name = 'Someone Else'
      await writeFile(join(cwd, 'instance.json'), `${JSON.stringify(changed, null, 2)}\n`, 'utf8')
      const report = await checkInstanceBundleFreshnessFile(freshnessOptions(), { cwd })
      expect(report.status).toBe('stale')
      expect(report.staleKind).toBe('semantic_drift')
      expect(report.currentState).toBe('diverged')
      expect(report.applyAllowed).toBe(false)
    })
  })

  test('recognizes an already-applied target and refuses a second apply', async () => {
    await withWorkspace(async (cwd) => {
      const artifact = await createArtifact(cwd)
      await writeFile(
        join(cwd, 'instance.json'),
        `${JSON.stringify(artifact.bundle.proposal.manifest, null, 2)}\n`,
        'utf8',
      )
      const report = await checkInstanceBundleFreshnessFile(freshnessOptions(), { cwd })
      expect(report.status).toBe('stale')
      expect(report.staleKind).toBe('already_applied')
      expect(report.currentState).toBe('target')
      expect(report.target.currentMatched).toBe(true)
      expect(report.proposal.applyCommand).toBeNull()
    })
  })

  test('blocks instance identity drift instead of treating it as a normal stale proposal', async () => {
    await withWorkspace(async (cwd) => {
      await createArtifact(cwd)
      const changed = structuredClone(BASE_MANIFEST)
      changed.instanceId = 'different-instance'
      await writeFile(join(cwd, 'instance.json'), `${JSON.stringify(changed, null, 2)}\n`, 'utf8')
      const report = await checkInstanceBundleFreshnessFile(freshnessOptions(), { cwd })
      expect(report.status).toBe('blocked')
      expect(report.errors.join('\n')).toContain('instance-id')
      expect(report.applyAllowed).toBe(false)
    })
  })

  test('blocks a different config path even when its content matches', async () => {
    await withWorkspace(async (cwd) => {
      await createArtifact(cwd)
      await writeFile(join(cwd, 'other.json'), `${JSON.stringify(BASE_MANIFEST, null, 2)}\n`, 'utf8')
      const report = await checkInstanceBundleFreshnessFile(freshnessOptions([
        '--config', 'other.json',
      ]), { cwd })
      expect(report.status).toBe('blocked')
      expect(report.errors.join('\n')).toContain('config-path')
    })
  })

  test('blocks artifact tampering and expected hash mismatch before trusting apply data', async () => {
    await withWorkspace(async (cwd) => {
      const artifact = await createArtifact(cwd)
      const tampered = structuredClone(artifact)
      tampered.bundle.proposal.manifest.site.name = 'Tampered'
      await writeFile(join(cwd, 'review/bundle.json'), `${JSON.stringify(tampered, null, 2)}\n`, 'utf8')
      const tamperReport = await checkInstanceBundleFreshnessFile(freshnessOptions(), { cwd })
      expect(tamperReport.status).toBe('blocked')
      expect(tamperReport.errors.join('\n')).toContain('artifact:target-manifest-hash')
      expect(tamperReport.proposal.applyCommand).toBeNull()

      await writeFile(join(cwd, 'review/bundle.json'), `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')
      const mismatch = await checkInstanceBundleFreshnessFile(freshnessOptions([
        '--expect-hash', 'f'.repeat(64),
      ]), { cwd })
      expect(mismatch.status).toBe('blocked')
      expect(mismatch.errors.join('\n')).toContain('expected-bundle-hash')
    })
  })

  test('keeps a no-op artifact fresh without claiming that apply is needed', async () => {
    await withWorkspace(async (cwd) => {
      await createArtifact(cwd, [])
      const report = await checkInstanceBundleFreshnessFile(freshnessOptions(), { cwd })
      expect(report.status).toBe('fresh')
      expect(report.proposal.changed).toBe(false)
      expect(report.applyAllowed).toBe(false)
      expect(report.proposal.applyCommand).toBeNull()
    })
  })

  test('bounds current manifest reads and rejects symlinks', async () => {
    await withWorkspace(async (cwd) => {
      await writeFile(join(cwd, 'large.json'), '123456789', 'utf8')
      await expect(readCurrentInstanceManifest('large.json', { cwd, maxBytes: 8 })).rejects.toThrow('read limit')
      await symlink(join(cwd, 'instance.json'), join(cwd, 'linked.json'))
      await expect(readCurrentInstanceManifest('linked.json', { cwd })).rejects.toThrow()
      await expect(readCurrentInstanceManifest('../outside.json', { cwd })).rejects.toThrow('stay inside')
    })
  })

  test('writes an explicit summary and then fails closed for stale evidence', async () => {
    await withWorkspace(async (cwd) => {
      await createArtifact(cwd)
      const changed = structuredClone(BASE_MANIFEST)
      changed.site.name = 'Drifted'
      await writeFile(join(cwd, 'instance.json'), `${JSON.stringify(changed, null, 2)}\n`, 'utf8')
      const summaryPath = join(cwd, 'summary.md')
      await writeFile(summaryPath, '', 'utf8')
      let stdout = ''
      await expect(main({
        cwd,
        env: { GITHUB_STEP_SUMMARY: summaryPath },
        argv: ['--input', 'review/bundle.json', '--github-summary'],
        stdout: { write(value) { stdout += value } },
      })).rejects.toThrow('returned stale')
      expect(stdout).toContain('STALE')
      expect(stdout).toContain('NO FILES WERE CHANGED')
      expect(await readFile(summaryPath, 'utf8')).toContain('Instance change-bundle freshness')
    })
  })
})
