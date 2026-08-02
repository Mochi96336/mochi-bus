import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  buildInstanceBundleArtifact,
  parseInstanceBundleArtifactArguments,
  resolveBundleArtifactOutputPath,
  writeInstanceBundleArtifact,
} from './bundle-artifact.mjs'
import { main } from './apply-bundle.mjs'
import { MAX_ATOMIC_MANIFEST_BYTES } from './atomic-manifest-write.mjs'

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
  const cwd = await mkdtemp(join(tmpdir(), 'mochi-bundle-recovery-'))
  await writeFile(join(cwd, 'instance.json'), `${JSON.stringify(BASE_MANIFEST, null, 2)}\n`, 'utf8')
  try {
    return await run(cwd)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

async function createArtifact(cwd) {
  const options = parseInstanceBundleArtifactArguments([
    '--config', 'instance.json',
    '--site-name', 'Island Transit',
    '--dry-run',
  ])
  const artifact = await buildInstanceBundleArtifact(options, { cwd, env: {} })
  const target = resolveBundleArtifactOutputPath(cwd, 'review/bundle.json', 'instance.json')
  await writeInstanceBundleArtifact(artifact, target)
  return artifact
}

function applyArguments(artifact) {
  return [
    '--input', 'review/bundle.json',
    '--expect-hash', artifact.bundle.hashes.bundleHash,
    '--expect-artifact-hash', artifact.integrity.artifactHash,
    '--write',
    '--json',
  ]
}

describe('instance reviewed bundle write recovery reporting', () => {
  test('bounds post-rename verification and reports a written but unverified manifest', async () => {
    await withWorkspace(async (cwd) => {
      const artifact = await createArtifact(cwd)
      let stdout = ''
      await expect(main({
        cwd,
        argv: applyArguments(artifact),
        stdout: { write(value) { stdout += value } },
        writerOptions: {
          afterRename: async ({ configPath }) => {
            await writeFile(configPath, Buffer.alloc(MAX_ATOMIC_MANIFEST_BYTES + 1, 0x78))
          },
        },
      })).rejects.toThrow('read limit')

      const report = JSON.parse(stdout)
      expect(report.writeState).toBe('written_unverified')
      expect(report.written).toBe(true)
      expect(report.verified).toBe(false)
      expect(report.writeError).toContain('read limit')
      expect((await stat(join(cwd, 'instance.json'))).size).toBe(MAX_ATOMIC_MANIFEST_BYTES + 1)
    })
  })

  test('reports a verified write separately from apply-lock cleanup failure', async () => {
    await withWorkspace(async (cwd) => {
      const artifact = await createArtifact(cwd)
      const lockPath = join(cwd, 'instance.json.apply.lock')
      let stdout = ''
      await expect(main({
        cwd,
        argv: applyArguments(artifact),
        stdout: { write(value) { stdout += value } },
        writerOptions: {
          remove: async (path, options) => {
            if (path === lockPath) throw new Error('injected apply-lock cleanup failure')
            return rm(path, options)
          },
        },
      })).rejects.toThrow('cleanup failure')

      const report = JSON.parse(stdout)
      expect(report.writeState).toBe('written_verified_cleanup_failed')
      expect(report.written).toBe(true)
      expect(report.verified).toBe(true)
      expect(report.cleanupErrors).toContain('remove apply lock: injected apply-lock cleanup failure')
      expect(JSON.parse(await readFile(join(cwd, 'instance.json'), 'utf8'))).toEqual(artifact.bundle.proposal.manifest)
      expect(await readFile(lockPath, 'utf8')).toContain(artifact.bundle.hashes.targetManifestHash)
    })
  })
})
