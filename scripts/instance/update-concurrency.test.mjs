import { copyFile, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  buildInstanceUpdate,
  parseInstanceUpdateArguments,
  writeInstanceUpdate,
} from './update.mjs'

const repositoryRoot = resolve(import.meta.dirname, '../..')
const productionPath = join(repositoryRoot, 'instances/mochi-production.json')
const updaterPath = join(repositoryRoot, 'scripts/instance/update.mjs')

describe('instance update concurrent writer boundary', () => {
  test('locks before writing and rechecks the reviewed source immediately before rename', async () => {
    const source = await readFile(updaterPath, 'utf8')
    expect(source).toContain("open(lockPath, 'wx'")
    expect(source).toContain('await handle.sync()')
    expect(source.match(/await assertSourceUnchanged\(result\)/g)).toHaveLength(2)
    expect(source).toContain('await verifyWrittenManifest(result, replacement)')
  })

  test('preserves a pre-existing lock and leaves the manifest unchanged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mochi-update-lock-'))
    const configPath = join(root, 'instance.json')
    await copyFile(productionPath, configPath)
    const before = await readFile(configPath, 'utf8')
    const lockPath = `${configPath}.update.lock`
    await writeFile(lockPath, 'owned elsewhere\n', { flag: 'wx' })

    const options = parseInstanceUpdateArguments([
      '--config', 'instance.json',
      '--site-name', 'Locked Bus',
    ])
    const result = await buildInstanceUpdate(options, { cwd: root, env: {} })

    await expect(writeInstanceUpdate(result)).rejects.toThrow(/lock already exists/i)
    expect(await readFile(configPath, 'utf8')).toBe(before)
    expect(await readFile(lockPath, 'utf8')).toBe('owned elsewhere\n')
  })
})
