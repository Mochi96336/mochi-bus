import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  buildInstanceUpdate,
  parseInstanceUpdateArguments,
  renderInstanceUpdateText,
  writeInstanceUpdate,
} from './update.mjs'

const repositoryRoot = resolve(import.meta.dirname, '../..')
const productionPath = join(repositoryRoot, 'instances/mochi-production.json')
const updaterPath = join(repositoryRoot, 'scripts/instance/update.mjs')

async function copyProduction(root, relativePath = 'instance.json') {
  const path = join(root, relativePath)
  await mkdir(dirname(path), { recursive: true })
  await copyFile(productionPath, path)
  return path
}

function siteNameUpdate(configPath) {
  return parseInstanceUpdateArguments([
    '--config', configPath,
    '--site-name', 'Safety Regression Bus',
  ])
}

describe('instance update safety regressions', () => {
  test('rejects reserved directories at any depth and regardless of case', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mochi-update-reserved-'))

    for (const directory of ['.generated', 'node_modules', '.GIT']) {
      const relativePath = join('nested', directory, 'instance.json')
      await copyProduction(root, relativePath)
      await expect(buildInstanceUpdate(siteNameUpdate(relativePath), {
        cwd: root,
        env: {},
      })).rejects.toThrow(/cannot be updated inside/i)
    }
  })

  test('rejects a logical path whose real target enters a reserved directory', async () => {
    if (process.platform === 'win32') return

    const root = await mkdtemp(join(tmpdir(), 'mochi-update-realpath-'))
    await copyProduction(root, join('.generated', 'configs', 'instance.json'))
    await mkdir(join(root, 'nested'), { recursive: true })
    await symlink(join(root, '.generated'), join(root, 'nested', 'alias'), 'dir')

    await expect(buildInstanceUpdate(siteNameUpdate(join('nested', 'alias', 'configs', 'instance.json')), {
      cwd: root,
      env: {},
    })).rejects.toThrow(/cannot be updated inside \.generated/i)
  })

  test('uses exclusive unpredictable temporary files and restores the exact mode', async () => {
    const source = await readFile(updaterPath, 'utf8')
    expect(source).toContain('randomUUID()')
    expect(source).toContain("open(temporary, 'wx'")
    expect(source).toContain('handle.chmod(result.sourceIdentity.mode)')

    if (process.platform === 'win32') return

    const root = await mkdtemp(join(tmpdir(), 'mochi-update-mode-'))
    const configPath = await copyProduction(root)
    await chmod(configPath, 0o666)
    const originalUmask = process.umask(0o077)

    try {
      const result = await buildInstanceUpdate(siteNameUpdate('instance.json'), {
        cwd: root,
        env: {},
      })
      await writeInstanceUpdate(result)
      expect((await lstat(configPath)).mode & 0o7777).toBe(0o666)
    } finally {
      process.umask(originalUmask)
    }
  })

  test('describes write mode as rebuilding against the current file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mochi-update-preview-wording-'))
    await copyProduction(root)
    const result = await buildInstanceUpdate(siteNameUpdate('instance.json'), {
      cwd: root,
      env: {},
    })
    const output = renderInstanceUpdateText(result)

    expect(output).toMatch(/rebuild and apply the update against the current file/i)
    expect(output).not.toMatch(/apply this exact update/i)
  })
})
