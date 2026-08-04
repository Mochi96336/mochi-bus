import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const root = resolve(import.meta.dirname, '../..')

async function source(path) {
  return readFile(resolve(root, path), 'utf8')
}

describe('instance update repository contract', () => {
  test('exposes the preview-first updater through package scripts', async () => {
    const packageJson = JSON.parse(await source('package.json'))
    expect(packageJson.scripts['instance:update']).toBe('node scripts/instance/update.mjs')
  })

  test('documents explicit write, preserved identities and demo-query protection', async () => {
    const documentation = await source('docs/INSTANCE_UPDATE.md')
    expect(documentation).toMatch(/previews? .* by default/i)
    expect(documentation).toContain('--write')
    expect(documentation).toMatch(/D1.*ID.*preserv/i)
    expect(documentation).toMatch(/rate-limit.*ID.*preserv/i)
    expect(documentation).toMatch(/demo query.*preserv/i)
    expect(documentation).toContain('--clear-demo-query')
  })

  test('keeps the updater local, non-provisioning and guarded by optimistic writes', async () => {
    const updater = await source('scripts/instance/update.mjs')
    expect(updater).not.toMatch(/child_process|\bexec\(|\bspawn\(|fetch\(/)
    expect(updater).toContain('NO FILE WAS CHANGED')
    expect(updater).toContain('changed after preview')
    expect(updater).toContain('options.write ? await writeInstanceUpdate')
  })
})
