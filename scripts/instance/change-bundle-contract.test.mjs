import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

const root = process.cwd()

async function read(path) {
  return readFile(join(root, path), 'utf8')
}

describe('instance change bundle repository contract', () => {
  test('exposes a dedicated change bundle command', async () => {
    const packageJson = JSON.parse(await read('package.json'))
    expect(packageJson.scripts['instance:change-bundle']).toBe('node scripts/instance/change-bundle.mjs')
  })

  test('documents deterministic hashes, expected-hash verification and non-destructive behavior', async () => {
    const documentation = await read('docs/INSTANCE_CHANGE_BUNDLE.md')
    expect(documentation).toContain('npm run instance:change-bundle')
    expect(documentation).toContain('--expect-hash')
    expect(documentation).toContain('bundleHash')
    expect(documentation).toContain('NO CHANGES WERE APPLIED')
    expect(documentation).toContain('projected doctor')
  })

  test('does not import network, subprocess or general file mutation APIs', async () => {
    const source = await read('scripts/instance/change-bundle.mjs')
    expect(source).toContain("from 'node:crypto'")
    expect(source).toContain('buildInstanceUpdate')
    expect(source).toContain('buildInstanceMigrationPlan')
    expect(source).not.toMatch(/node:child_process/)
    expect(source).not.toMatch(/\bfetch\s*\(/)
    expect(source).not.toMatch(/\b(writeFile|rename|rm|mkdir|open|unlink)\s*\(/)
    expect(source).not.toMatch(/wrangler\s+(deploy|d1 migrations apply|delete)/)
    expect(source).not.toContain('github.rest')
    expect(source).not.toContain('process.env.TDX_CLIENT_SECRET')
  })
})
