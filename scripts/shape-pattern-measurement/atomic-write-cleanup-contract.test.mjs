import { mkdtemp, open, readFile, readdir, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { attachCleanupFailure } from './measurement-errors.mjs'
import { atomicWrite } from './util.mjs'

const roots = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), 'atomic-write-cleanup-'))
  roots.push(root)
  return root
}

async function measurementSources(root = 'scripts/shape-pattern-measurement') {
  const files = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) files.push(...await measurementSources(path))
    else if (/\.(?:mjs|js)$/.test(entry.name)) files.push(path)
  }
  return files
}

describe('atomic write cleanup visibility', () => {
  it('preserves a rename failure when temporary removal succeeds', async () => {
    const root = await tempRoot()
    const file = join(root, 'result.json')
    const error = await atomicWrite(file, '{}\n', {
      renameFile: async () => { throw Object.assign(new Error('rename failed'), { code: 'EXDEV' }) },
    }).catch((caught) => caught)

    expect(error.code).toBe('EXDEV')
    expect(error.cleanupFailures).toBeUndefined()
    expect(await readdir(root)).toEqual([])
  })

  it('keeps the primary rename classification and adds bounded temporary cleanup data', async () => {
    const root = await tempRoot()
    const file = join(root, 'result.json')
    let temporaryPath = null
    const error = await atomicWrite(file, 'fake secret file content\n', {
      renameFile: async (temporary) => {
        temporaryPath = temporary
        throw Object.assign(new Error('primary rename failure'), { code: 'EXDEV' })
      },
      removeFile: async () => {
        throw Object.assign(new Error('EACCES fake secret cleanup stack'), { code: 'EACCES' })
      },
    }).catch((caught) => caught)

    expect(error.code).toBe('EXDEV')
    expect(error.cleanupFailures).toEqual([{
      stage: 'atomic-write-temp-cleanup',
      temporaryPath: basename(temporaryPath),
    }])
    const serialized = JSON.stringify(error)
    expect(serialized).not.toContain('EACCES')
    expect(serialized).not.toContain('fake secret')
  })

  it('preserves a write failure when temporary cleanup also fails', async () => {
    const root = await tempRoot()
    const file = join(root, 'result.json')
    const error = await atomicWrite(file, 'secret payload\n', {
      openFile: async (temporary, flags, mode) => {
        const handle = await open(temporary, flags, mode)
        return {
          writeFile: async () => { throw Object.assign(new Error('write failed'), { code: 'WRITE_FAILED' }) },
          sync: () => handle.sync(),
          close: () => handle.close(),
        }
      },
      removeFile: async () => { throw new Error('raw cleanup error') },
    }).catch((caught) => caught)

    expect(error.code).toBe('WRITE_FAILED')
    expect(error.cleanupFailures).toEqual([{
      stage: 'atomic-write-temp-cleanup',
      temporaryPath: expect.stringMatching(/^result\.json\./),
    }])
    expect(JSON.stringify(error)).not.toContain('raw cleanup error')
    expect(JSON.stringify(error)).not.toContain('secret payload')
  })

  it('composes atomic and outer staging cleanup failures without replacing the primary code', async () => {
    const root = await tempRoot()
    const file = join(root, 'result.json')
    const atomicError = await atomicWrite(file, '{}\n', {
      renameFile: async () => { throw Object.assign(new Error('rename failed'), { code: 'REPORT_WRITE_FAILED' }) },
      removeFile: async () => { throw new Error('atomic cleanup failed') },
    }).catch((caught) => caught)
    const combined = attachCleanupFailure(atomicError, {
      stage: 'report-temporary-cleanup',
      temporaryPath: join(root, '.report-run-orphan'),
    })

    expect(combined.code).toBe('REPORT_WRITE_FAILED')
    expect(combined.cleanupFailures.map((failure) => failure.stage)).toEqual([
      'atomic-write-temp-cleanup',
      'report-temporary-cleanup',
    ])
  })

  it('publishes successfully without a cleanup entry or temporary residue', async () => {
    const root = await tempRoot()
    const file = join(root, 'result.json')
    await expect(atomicWrite(file, '{"ok":true}\n')).resolves.toBeUndefined()
    expect(await readFile(file, 'utf8')).toBe('{"ok":true}\n')
    expect(await readdir(root)).toEqual(['result.json'])
  })

  it('contains no undocumented empty catch used to hide cleanup failure', async () => {
    const violations = []
    for (const file of await measurementSources()) {
      const source = await readFile(file, 'utf8')
      if (/catch\s*(?:\([^)]*\)\s*)?\{\s*\}/m.test(source)
        || /\.catch\(\s*\(\s*\)\s*=>\s*(?:undefined|\{\s*\})\s*\)/m.test(source)) {
        violations.push(file)
      }
    }
    expect(violations).toEqual([])
  })
})
