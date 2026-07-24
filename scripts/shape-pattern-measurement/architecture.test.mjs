import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MATCHER_SOURCE, SUPPORTED_MATCHER_GIT_BLOB_SHA1 } from './constants.mjs'
import { gitBlobSha1 } from './util.mjs'

async function sourceFiles(root) {
  const result = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) result.push(...await sourceFiles(path))
    else if (/\.(?:ts|tsx|js|mjs|jsonc)$/.test(entry.name)) result.push(path)
  }
  return result
}

describe('measurement harness production isolation', () => {
  it('pins the latest-main production matcher blob without modifying semantics', async () => {
    expect(gitBlobSha1(await readFile(MATCHER_SOURCE))).toBe(SUPPORTED_MATCHER_GIT_BLOB_SHA1)
  })

  it('is not imported by src, web, Vite, Worker, or production telemetry', async () => {
    const paths = [...await sourceFiles('src'), ...await sourceFiles('web'), 'vite.config.ts', 'wrangler.jsonc']
    for (const path of paths) {
      const source = await readFile(path, 'utf8')
      expect(source, path).not.toContain('scripts/shape-pattern-measurement')
      expect(source, path).not.toContain('__MOCHI_SHAPE_PATTERN_MEASUREMENT__')
    }
  })

  it('keeps raw, generated, cache staging, and reports ignored', async () => {
    const gitignore = await readFile('.gitignore', 'utf8')
    expect(gitignore).toContain('/.tdx-measurement/')
  })

  it('does not add the harness to production start, build, or deploy commands', async () => {
    const pkg = JSON.parse(await readFile('package.json', 'utf8'))
    expect(pkg.scripts['measure:shape-pattern']).toContain('scripts/shape-pattern-measurement/run.mjs')
    expect(pkg.scripts['test:shape-pattern-measurement']).toContain('shape-pattern-measurement')
    for (const name of ['build:map', 'dev', 'deploy']) {
      expect(pkg.scripts[name]).not.toContain('shape-pattern-measurement')
    }
  })
})
