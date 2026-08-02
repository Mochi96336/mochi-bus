import { readFile } from 'node:fs/promises'
import { describe, expect, test } from 'vitest'

async function source(path) {
  return readFile(new URL(`../../${path}`, import.meta.url), 'utf8')
}

describe('instance bundle artifact repository contracts', () => {
  test('exposes separate artifact creation and offline verification commands', async () => {
    const packageJson = JSON.parse(await source('package.json'))
    expect(packageJson.scripts['instance:bundle-artifact']).toBe('node scripts/instance/bundle-artifact.mjs')
    expect(packageJson.scripts['instance:verify-bundle']).toBe('node scripts/instance/verify-bundle.mjs')
  })

  test('keeps the writer exclusive, atomic and without a force mode', async () => {
    const writer = await source('scripts/instance/bundle-artifact.mjs')
    expect(writer).toContain("await link(temporary, target.outputPath)")
    expect(writer).toContain("await open(temporary, 'wx', 0o600)")
    expect(writer).toContain('bundle artifacts are never overwritten')
    expect(writer).not.toContain("argument === '--force'")
    expect(writer).not.toContain("argument.startsWith('--force='")
  })

  test('keeps creation and verification free of subprocess, network and secret-value inspection', async () => {
    const combined = [
      await source('scripts/instance/bundle-artifact.mjs'),
      await source('scripts/instance/verify-bundle.mjs'),
      await source('scripts/instance/bundle-integrity.mjs'),
    ].join('\n')
    expect(combined).not.toMatch(/node:child_process|\bexecFile\b|\bspawn\b/)
    expect(combined).not.toMatch(/\bfetch\s*\(|https:\/\//)
    expect(combined).not.toMatch(/process\.env\.(TDX_CLIENT_SECRET|CLOUDFLARE_API_TOKEN|R2_SECRET_ACCESS_KEY)/)
    expect(combined).not.toMatch(/wrangler\s+(deploy|d1|r2|secret)/)
  })

  test('documents self-contained evidence, nine hash layers and offline safety boundaries', async () => {
    const documentation = await source('docs/INSTANCE_BUNDLE_ARTIFACTS.md')
    expect(documentation).toContain('exact source manifest bytes')
    expect(documentation).toContain('canonical baseline manifest')
    expect(documentation).toContain('complete artifact digest')
    expect(documentation).toContain('existing artifact is never overwritten')
    expect(documentation).toContain('rejects duplicate object keys')
    expect(documentation).toContain('does not prove that the proposal has been applied')
  })
})
