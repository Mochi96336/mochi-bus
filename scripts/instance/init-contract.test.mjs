import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const repositoryRoot = resolve(import.meta.dirname, '../..')

async function read(path) {
  return readFile(resolve(repositoryRoot, path), 'utf8')
}

describe('instance initializer repository contract', () => {
  test('exposes the initializer through the package script', async () => {
    const packageJson = JSON.parse(await read('package.json'))
    expect(packageJson.scripts['instance:init']).toBe('node scripts/instance/init.mjs')
  })

  test('keeps the initializer local and free of provisioning side effects', async () => {
    const source = await read('scripts/instance/init.mjs')
    expect(source).not.toMatch(/node:child_process|\bexecFile\b|\bspawn\b/)
    expect(source).not.toMatch(/\bfetch\s*\(|wrangler\s+(?:d1|r2|secret)|gh\s+(?:secret|variable)/)
    expect(source).toMatch(/open\(result\.outputPath, 'wx'\)/)
    expect(source).toMatch(/--force/)
  })

  test('documents preview, overwrite safety and the provisioning handoff', async () => {
    const documentation = await read('docs/INSTANCE_INIT.md')
    expect(documentation).toMatch(/--dry-run/)
    expect(documentation).toMatch(/--force/)
    expect(documentation).toMatch(/instance:provision-plan/)
    expect(documentation).toMatch(/No placeholder UUID or fake namespace identity is invented/)
  })
})
