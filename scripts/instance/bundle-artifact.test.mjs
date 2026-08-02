import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  buildInstanceBundleArtifact,
  main as artifactMain,
  parseInstanceBundleArtifactArguments,
  resolveBundleArtifactOutputPath,
  writeInstanceBundleArtifact,
} from './bundle-artifact.mjs'
import {
  parseStrictJson,
  verifyInstanceBundleArtifact,
} from './bundle-integrity.mjs'
import {
  main as verifyMain,
  parseInstanceBundleVerificationArguments,
  readInstanceBundleArtifact,
  verifyInstanceBundleFile,
} from './verify-bundle.mjs'

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

async function withWorkspace(run) {
  const cwd = await mkdtemp(join(tmpdir(), 'mochi-bundle-artifact-'))
  await writeFile(join(cwd, 'instance.json'), `${JSON.stringify(BASE_MANIFEST, null, 2)}\n`, 'utf8')
  try {
    return await run(cwd)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

function artifactOptions(changes = [], extra = []) {
  return parseInstanceBundleArtifactArguments([
    '--config', 'instance.json',
    ...changes,
    ...extra,
  ])
}

async function buildArtifact(cwd, changes = ['--site-name', 'Island Transit'], extra = ['--dry-run']) {
  return buildInstanceBundleArtifact(artifactOptions(changes, extra), { cwd, env: {} })
}

describe('instance bundle artifacts', () => {
  test('parses writer-only options without forwarding output or dry-run', () => {
    const parsed = parseInstanceBundleArtifactArguments([
      '--config', 'instances/island.json',
      '--site-name', 'Island Transit',
      '--output', '.generated/review/island.json',
      '--expect-hash', 'a'.repeat(64),
      '--json',
    ])
    expect(parsed.outputPath).toBe('.generated/review/island.json')
    expect(parsed.json).toBe(true)
    expect(parsed.bundleOptions.updateOptions.configPath).toBe('instances/island.json')
    expect(parsed.bundleOptions.updateOptions.siteName).toBe('Island Transit')
    expect(parsed.bundleOptions.expectedHash).toBe('a'.repeat(64))
  })

  test('requires an explicit output unless dry-run and rejects summary mode', () => {
    expect(() => artifactOptions()).toThrow('explicit --output')
    expect(() => artifactOptions([], ['--dry-run'])).not.toThrow()
    expect(() => artifactOptions([], ['--output', 'bundle.json', '--github-summary'])).toThrow('does not accept --github-summary')
  })

  test('rejects traversal, manifest replacement, reserved generated names and non-JSON output', () => {
    expect(() => resolveBundleArtifactOutputPath('/repo', '../bundle.json', 'instance.json')).toThrow('stay inside')
    expect(() => resolveBundleArtifactOutputPath('/repo', 'instance.json', 'instance.json')).toThrow('source instance manifest')
    expect(() => resolveBundleArtifactOutputPath('/repo', '.generated/instance/instance-runtime.json', 'instance.json')).toThrow('generated runtime file')
    expect(() => resolveBundleArtifactOutputPath('/repo', '.git/bundle.json', 'instance.json')).toThrow('.git')
    expect(() => resolveBundleArtifactOutputPath('/repo', 'bundle.txt', 'instance.json')).toThrow('.json extension')
  })

  test('builds a self-contained artifact whose nine integrity layers verify', async () => {
    await withWorkspace(async (cwd) => {
      const artifact = await buildArtifact(cwd, [
        '--worker-name', 'island-v2',
        '--origin', 'https://new-bus.example.com',
      ])
      const report = verifyInstanceBundleArtifact(artifact)
      expect(report.ok).toBe(true)
      expect(report.summary.failed).toBe(0)
      expect(report.artifactHash).toBe(artifact.integrity.artifactHash)
      expect(report.bundleHash).toBe(artifact.bundle.hashes.bundleHash)
      expect(artifact.evidence.sourceManifest).toContain('"Island Bus"')
      expect(artifact.evidence.baselineManifest.site.name).toBe('Island Bus')
      expect(artifact.bundle.proposal.manifest.site.canonicalOrigin).toBe('https://new-bus.example.com')
    })
  })

  test('writes atomically, never overwrites and leaves the first artifact unchanged', async () => {
    await withWorkspace(async (cwd) => {
      const artifact = await buildArtifact(cwd)
      const target = resolveBundleArtifactOutputPath(cwd, '.generated/review/island.json', 'instance.json')
      await writeInstanceBundleArtifact(artifact, target)
      const first = await readFile(target.outputPath, 'utf8')
      await expect(writeInstanceBundleArtifact(artifact, target)).rejects.toThrow('never overwritten')
      expect(await readFile(target.outputPath, 'utf8')).toBe(first)
      expect(JSON.parse(first).integrity.artifactHash).toBe(artifact.integrity.artifactHash)
    })
  })

  test('refuses an output parent that resolves through a symbolic link', async () => {
    await withWorkspace(async (cwd) => {
      const artifact = await buildArtifact(cwd)
      const outside = await mkdtemp(join(tmpdir(), 'mochi-bundle-outside-'))
      try {
        await symlink(outside, join(cwd, 'linked-review'))
        const target = resolveBundleArtifactOutputPath(cwd, 'linked-review/island.json', 'instance.json')
        await expect(writeInstanceBundleArtifact(artifact, target)).rejects.toThrow('symbolic link')
      } finally {
        await rm(outside, { recursive: true, force: true })
      }
    })
  })

  test('verifies without the source manifest or repository state', async () => {
    await withWorkspace(async (cwd) => {
      const artifact = await buildArtifact(cwd)
      const target = resolveBundleArtifactOutputPath(cwd, 'review/island.json', 'instance.json')
      await writeInstanceBundleArtifact(artifact, target)
      await rm(join(cwd, 'instance.json'))
      const report = await verifyInstanceBundleFile(
        parseInstanceBundleVerificationArguments(['--input', 'review/island.json']),
        { cwd },
      )
      expect(report.ok).toBe(true)
      expect(report.instanceId).toBe('island-test')
    })
  })

  test('detects target, source and wrapper tampering independently', async () => {
    await withWorkspace(async (cwd) => {
      const original = await buildArtifact(cwd)

      const targetTamper = structuredClone(original)
      targetTamper.bundle.proposal.manifest.site.name = 'Tampered'
      const targetReport = verifyInstanceBundleArtifact(targetTamper)
      expect(targetReport.ok).toBe(false)
      expect(targetReport.errors.join('\n')).toContain('target-manifest-hash')
      expect(targetReport.errors.join('\n')).toContain('artifact-hash')

      const sourceTamper = structuredClone(original)
      sourceTamper.evidence.sourceManifest += ' '
      const sourceReport = verifyInstanceBundleArtifact(sourceTamper)
      expect(sourceReport.errors.join('\n')).toContain('source-manifest-hash')

      const wrapperTamper = structuredClone(original)
      wrapperTamper.kind = 'different-kind'
      const wrapperReport = verifyInstanceBundleArtifact(wrapperTamper)
      expect(wrapperReport.errors.join('\n')).toContain('artifact-kind')
      expect(wrapperReport.errors.join('\n')).toContain('artifact-hash')
    })
  })

  test('rejects duplicate keys before JSON.parse can collapse them', () => {
    expect(() => parseStrictJson('{"kind":"first","kind":"second"}')).toThrow('Duplicate JSON object key')
    expect(() => parseStrictJson('{"outer":{"x":1,"x":2}}')).toThrow('Duplicate JSON object key')
    expect(() => parseStrictJson('{"escaped":"a","\\u0065scaped":"b"}')).toThrow('Duplicate JSON object key')
  })

  test('applies bounded reads and rejects symlink inputs', async () => {
    await withWorkspace(async (cwd) => {
      await writeFile(join(cwd, 'large.json'), '123456789', 'utf8')
      await expect(readInstanceBundleArtifact('large.json', { cwd, maxBytes: 8 })).rejects.toThrow('read limit')
      await symlink(join(cwd, 'large.json'), join(cwd, 'link.json'))
      await expect(readInstanceBundleArtifact('link.json', { cwd })).rejects.toThrow()
    })
  })

  test('checks reviewed bundle and artifact hashes and fails closed on mismatch', async () => {
    await withWorkspace(async (cwd) => {
      const artifact = await buildArtifact(cwd)
      const target = resolveBundleArtifactOutputPath(cwd, 'review/island.json', 'instance.json')
      await writeInstanceBundleArtifact(artifact, target)
      const matching = await verifyInstanceBundleFile(parseInstanceBundleVerificationArguments([
        'review/island.json',
        '--expect-hash', artifact.bundle.hashes.bundleHash,
        '--expect-artifact-hash', artifact.integrity.artifactHash,
      ]), { cwd })
      expect(matching.ok).toBe(true)

      const mismatch = await verifyInstanceBundleFile(parseInstanceBundleVerificationArguments([
        'review/island.json',
        '--expect-hash', 'f'.repeat(64),
      ]), { cwd })
      expect(mismatch.ok).toBe(false)
      expect(mismatch.errors.join('\n')).toContain('expected-bundle-hash')
    })
  })

  test('does not serialize credential values even when the environment contains them', async () => {
    await withWorkspace(async (cwd) => {
      const secret = 'super-sensitive-value'
      const options = artifactOptions(['--r2-name', 'island-shapes-v2'], ['--dry-run'])
      const artifact = await buildInstanceBundleArtifact(options, {
        cwd,
        env: {
          TDX_CLIENT_SECRET: secret,
          CLOUDFLARE_API_TOKEN: secret,
          R2_SECRET_ACCESS_KEY: secret,
        },
      })
      expect(JSON.stringify(artifact)).not.toContain(secret)
    })
  })

  test('supports dry-run JSON, saved verification and explicit GitHub summary only', async () => {
    await withWorkspace(async (cwd) => {
      let preview = ''
      await artifactMain({
        cwd,
        env: {},
        argv: ['--config', 'instance.json', '--site-name', 'Island Transit', '--dry-run'],
        stdout: { write(value) { preview += value } },
      })
      const artifact = JSON.parse(preview)
      expect(artifact.kind).toBe('mochi-bus-instance-change-bundle')

      const target = resolveBundleArtifactOutputPath(cwd, 'review/island.json', 'instance.json')
      await writeInstanceBundleArtifact(artifact, target)
      const summaryPath = join(cwd, 'summary.md')
      await writeFile(summaryPath, '', 'utf8')
      let output = ''
      await verifyMain({
        cwd,
        env: { GITHUB_STEP_SUMMARY: summaryPath },
        argv: ['--input', 'review/island.json', '--github-summary'],
        stdout: { write(value) { output += value } },
      })
      expect(output).toContain('VERIFIED')
      expect(output).toContain('NO FILES WERE CHANGED')
      expect(await readFile(summaryPath, 'utf8')).toContain('artifact verification')
    })
  })
})
