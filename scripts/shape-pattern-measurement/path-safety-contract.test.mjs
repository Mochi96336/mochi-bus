import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { validatePathBoundaries } from './cli.mjs'
import { prepareReportPublicationPaths, validateRunId } from './report.mjs'

const roots = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

async function repoFixture() {
  const root = await mkdtemp(join(tmpdir(), 'measurement-path-policy-'))
  roots.push(root)
  await Promise.all([mkdir(join(root, 'src')), mkdir(join(root, '.git')), mkdir(join(root, 'web')), mkdir(join(root, 'scripts')), mkdir(join(root, 'docs'))])
  return root
}

describe('canonical report run IDs', () => {
  it.each(['x/../../outside', '../outside', '/tmp/outside', 'C:\\outside', '..\\outside', '.', '..', ' spaced ', 'a'.repeat(129)])('rejects unsafe run ID %s', (runId) => {
    expect(() => validateRunId(runId)).toThrow()
  })
  it('accepts a bounded canonical run ID', () => expect(validateRunId('instrumented-main-20260723')).toBe('instrumented-main-20260723'))
})

describe('report root containment', () => {
  it('rejects a symlink report root', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'report-root-parent-'))
    const target = await mkdtemp(join(tmpdir(), 'report-root-target-'))
    roots.push(parent, target)
    const linked = join(parent, 'reports')
    await symlink(target, linked, 'dir')
    await expect(prepareReportPublicationPaths(linked, 'safe-run')).rejects.toThrow(/symlink/i)
  })

  it('keeps temporary and final directories strict children of the resolved root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'report-safe-root-'))
    roots.push(root)
    const paths = await prepareReportPublicationPaths(root, 'safe-run')
    expect(paths.finalDirectory.startsWith(`${resolve(root)}/`)).toBe(true)
    expect(paths.temporaryPrefix.startsWith(`${resolve(root)}/`)).toBe(true)
  })
})

describe('measurement root policy', () => {
  it.each([
    ['reportDir', 'web'], ['reportDir', 'scripts'], ['generatedRoot', 'web'], ['rawDir', 'docs'],
  ])('rejects repository-internal %s at %s', async (field, relativePath) => {
    const repositoryRoot = await repoFixture()
    const values = {
      rawDir: join(repositoryRoot, '.tdx-measurement/raw'),
      reportDir: join(repositoryRoot, '.tdx-measurement/reports'),
      generatedRoot: join(repositoryRoot, '.tdx-measurement/generated'),
    }
    values[field] = join(repositoryRoot, relativePath)
    await expect(validatePathBoundaries({ ...values, repositoryRoot })).rejects.toThrow(/\.tdx-measurement|repository/i)
  })

  it('accepts pairwise-disjoint strict children under .tdx-measurement', async () => {
    const repositoryRoot = await repoFixture()
    await expect(validatePathBoundaries({
      rawDir: join(repositoryRoot, '.tdx-measurement/raw'),
      reportDir: join(repositoryRoot, '.tdx-measurement/reports'),
      generatedRoot: join(repositoryRoot, '.tdx-measurement/generated'),
      repositoryRoot,
    })).resolves.toBeUndefined()
  })

  it('accepts safe disjoint external roots but rejects a repository ancestor', async () => {
    const repositoryRoot = await repoFixture()
    const outside = await mkdtemp(join(tmpdir(), 'measurement-outside-'))
    roots.push(outside)
    await expect(validatePathBoundaries({
      rawDir: join(outside, 'raw'), reportDir: join(outside, 'reports'), generatedRoot: join(outside, 'generated'), repositoryRoot,
    })).resolves.toBeUndefined()
    await expect(validatePathBoundaries({
      rawDir: resolve(repositoryRoot, '..'), reportDir: join(outside, 'reports'), generatedRoot: join(outside, 'generated'), repositoryRoot,
    })).rejects.toThrow(/repository|root|disjoint|overlap/i)
  })
})
