import { readFile } from 'node:fs/promises'
import { describe, expect, test } from 'vitest'

const applyUrl = new URL('./apply-bundle.mjs', import.meta.url)
const writerUrl = new URL('./atomic-manifest-write.mjs', import.meta.url)
const packageUrl = new URL('../../package.json', import.meta.url)
const documentationUrl = new URL('../../docs/INSTANCE_BUNDLE_APPLY.md', import.meta.url)
const stalenessDocumentationUrl = new URL('../../docs/INSTANCE_BUNDLE_STALENESS.md', import.meta.url)

async function source(url) {
  return readFile(url, 'utf8')
}

describe('instance reviewed bundle apply contracts', () => {
  test('exposes one explicit-write command without subprocess, network, compile or deploy access', async () => {
    const [apply, packageSource] = await Promise.all([source(applyUrl), source(packageUrl)])
    expect(packageSource).toContain('"instance:apply-bundle": "node scripts/instance/apply-bundle.mjs"')
    expect(apply).toContain("argument === '--write'")
    expect(apply).toContain('requires both --expect-hash and --expect-artifact-hash')
    expect(apply).not.toMatch(/node:child_process|\bexec(File|Sync)?\b|\bspawn(Sync)?\b/)
    expect(apply).not.toMatch(/node:https|node:http|undici|\bfetch\s*\(/)
    expect(apply).not.toMatch(/from ['"][^'"]*(compile-config|wrangler|cloudflare)[^'"]*['"]/i)
  })

  test('reuses the complete freshness gate and independently re-verifies critical identities', async () => {
    const apply = await source(applyUrl)
    expect(apply).toContain('checkInstanceBundleFreshnessFile')
    expect(apply).toContain('verifyInstanceBundleArtifact')
    expect(apply).toContain('readCurrentInstanceManifest')
    expect(apply).toContain('source_changed_after_freshness')
    expect(apply).toContain('sourceManifestHash')
    expect(apply).toContain('baselineManifestHash')
    expect(apply).toContain('targetManifestHash')
    expect(apply).toContain("freshness.status !== 'fresh'")
    expect(apply).toContain('freshness.applyAllowed')
  })

  test('uses an exclusive lock, durable temp file, immediate source recheck, atomic rename and post-write verification', async () => {
    const writer = await source(writerUrl)
    expect(writer).toContain('MAX_ATOMIC_MANIFEST_BYTES = 1024 * 1024')
    expect(writer).toContain("open(lockPath, 'wx', 0o600)")
    expect(writer).toContain("open(temporaryPath, 'wx', sourceIdentity.mode)")
    expect(writer.match(/assertExpectedCurrentSource\(/g)?.length).toBeGreaterThanOrEqual(3)
    expect(writer).toContain('await temporaryHandle.sync()')
    expect(writer).toContain('await rename(temporaryPath, configPath)')
    expect(writer).toContain('readVerifiedReplacement')
    expect(writer).toContain('parseStrictJson(targetSource)')
    expect(writer).toContain('O_NOFOLLOW')
    expect(writer).not.toMatch(/copyFile|appendFile|truncate/)
  })

  test('documentation separates repository apply from compile, provisioning and deployment', async () => {
    const [documentation, stalenessDocumentation] = await Promise.all([
      source(documentationUrl),
      source(stalenessDocumentationUrl),
    ])
    expect(documentation).toContain('--expect-hash')
    expect(documentation).toContain('--expect-artifact-hash')
    expect(documentation).toContain('--write')
    expect(documentation).toContain('atomic rename')
    expect(documentation).toContain('does not compile')
    expect(documentation).toContain('deploy a Worker')
    expect(documentation).toContain('apply lock')
    expect(stalenessDocumentation).toContain('instance:apply-bundle')
    expect(stalenessDocumentation).not.toContain('A future apply-from-artifact command')
  })
})
