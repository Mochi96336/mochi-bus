import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { parseCli, pathsOverlap, validatePathBoundaries } from './cli.mjs'

const roots = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'shape-measure-cli-'))
  roots.push(root)
  await mkdir(join(root, 'src'))
  await mkdir(join(root, '.git'))
  return root
}

describe('measurement CLI path boundaries', () => {
  it.each([
    ['generated equals measurement root', ['--generated-dir', '.tdx-measurement']],
    ['generated is raw ancestor', ['--generated-dir', '.tdx-measurement', '--raw-dir', '.tdx-measurement/raw']],
    ['generated is report ancestor', ['--generated-dir', '.tdx-measurement', '--report-dir', '.tdx-measurement/reports']],
    ['raw is generated ancestor', ['--raw-dir', '.tdx-measurement', '--generated-dir', '.tdx-measurement/generated']],
    ['report is raw child', ['--raw-dir', '.tdx-measurement/raw', '--report-dir', '.tdx-measurement/raw/reports']],
    ['repository root', ['--generated-dir', '.']],
    ['parent repository', ['--generated-dir', '..']],
    ['source tree', ['--generated-dir', 'src']],
    ['git metadata', ['--generated-dir', '.git/cache']],
    ['web tree', ['--report-dir', 'web']],
    ['scripts tree', ['--report-dir', 'scripts']],
  ])('rejects %s', async (_name, argv) => {
    const root = await workspace()
    await expect(parseCli(argv, { cwd: root, repositoryRoot: root, requireReplayPath: false }))
      .rejects.toThrow(/overlap|disjoint|repository|\.tdx-measurement/)
  })

  it('resolves symlinks before repository-boundary checks', async () => {
    const root = await workspace()
    const outside = await mkdtemp(join(tmpdir(), 'shape-measure-outside-'))
    roots.push(outside)
    await symlink(outside, join(root, 'linked-root'), 'dir')
    await expect(validatePathBoundaries({
      rawDir: join(root, 'linked-root', 'raw'),
      reportDir: join(outside, 'reports'),
      generatedRoot: join(outside, 'generated'),
      repositoryRoot: root,
    })).rejects.toThrow(/repository boundary|symlink/i)
  })

  it('does not mistake sibling prefixes for containment under the owned measurement root', async () => {
    const root = await workspace()
    await expect(validatePathBoundaries({
      rawDir: join(root, '.tdx-measurement', 'foo', 'bar'),
      reportDir: join(root, '.tdx-measurement', 'foo', 'bar-other'),
      generatedRoot: join(root, '.tdx-measurement', 'foo', 'generated'),
      repositoryRoot: root,
    })).resolves.toBeUndefined()
    expect(pathsOverlap('/foo/bar', '/foo/bar-other')).toBe(false)
  })

  it('tracks whether replay scope was explicitly supplied', async () => {
    const root = await workspace()
    const defaults = await parseCli([], { cwd: root, repositoryRoot: root, requireReplayPath: false })
    expect(defaults.citiesExplicit).toBe(false)
    expect(defaults.includeIntercityExplicit).toBe(false)
    const explicit = await parseCli(['--cities', 'Taipei', '--include-intercity'], {
      cwd: root, repositoryRoot: root, requireReplayPath: false,
    })
    expect(explicit.citiesExplicit).toBe(true)
    expect(explicit.includeIntercityExplicit).toBe(true)
  })

  it('accepts --matcher-sha and rejects ambiguous SHA aliases', async () => {
    const root = await workspace()
    const sha = 'a'.repeat(64)
    const options = await parseCli(['--instrumented', '--matcher-sha', sha], {
      cwd: root, repositoryRoot: root, requireReplayPath: false,
    })
    expect(options.expectedMatcherSha256).toBe(sha)
    await expect(parseCli([
      '--instrumented', '--matcher-sha', sha, '--expected-matcher-sha256', sha,
    ], { cwd: root, repositoryRoot: root, requireReplayPath: false })).rejects.toThrow(/only one/i)
  })

  it.each([
    ['--warmup', 'NaN'], ['--warmup', 'Infinity'], ['--warmup', '-1'],
    ['--iterations', '0'], ['--iterations', '1.5'], ['--top-outliers', '01'],
    ['--fetch-concurrency', '1e3'],
  ])('rejects malformed numeric option %s %s', async (flag, value) => {
    const root = await workspace()
    await expect(parseCli([flag, value], { cwd: root, repositoryRoot: root, requireReplayPath: false })).rejects.toThrow()
  })

  it.each(['--client-id', '--client-secret', '--token'])('rejects secret CLI flag %s', async (flag) => {
    const root = await workspace()
    await expect(parseCli([flag, 'secret'], { cwd: root, repositoryRoot: root, requireReplayPath: false })).rejects.toThrow(/forbidden/)
  })
})
