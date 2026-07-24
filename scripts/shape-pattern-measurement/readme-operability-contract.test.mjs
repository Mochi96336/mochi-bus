import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const readme = await readFile('scripts/shape-pattern-measurement/README.md', 'utf8')
const roots = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function findDirectories(root, pattern) {
  const { stdout } = await execFileAsync('find', [
    root,
    '-mindepth', '1',
    '-maxdepth', '1',
    '-type', 'd',
    '-name', pattern,
    '-print',
  ], { encoding: 'utf8' })
  return stdout.trim().split('\n').filter(Boolean).map((path) => path.slice(root.length + 1)).sort()
}

describe('measurement README operability', () => {
  it('documents the complete live-fetch and two-mode offline replay workflow', () => {
    for (const required of [
      'TDX_CLIENT_ID', 'TDX_CLIENT_SECRET',
      '--cities Taipei,NewTaipei,Taoyuan,Keelung,Taichung,Tainan,Kaohsiung,Chiayi,MiaoliCounty',
      '--include-intercity', '--replay', '--warmup', '--iterations',
      '--instrumented', '--expected-matcher-sha256',
      'sha256sum src/domain/map/shape-pattern-matcher.ts',
      'completion.json', 'deterministicContentHash', 'bundleContentHash',
      'orphan', 'git status --short',
    ]) expect(readme).toContain(required)
  })

  it('distinguishes the Git blob SHA-1 pin from the caller-supplied file SHA-256', () => {
    expect(readme).toMatch(/Git blob SHA-1/i)
    expect(readme).toMatch(/file SHA-256/i)
    expect(readme).toContain('fc67cdecd785e89b9b08937edab156ade430198b')
  })

  it('keeps the production and review gates closed after harness verification', () => {
    expect(readme).toContain('C. Temporarily not ready for production integration.')
    expect(readme).toMatch(/Production PR 2 remains blocked/i)
    expect(readme).toMatch(/sanitized fixture.*must not/i)
    expect(readme).toMatch(/remain Draft.*fourth narrow review/i)
  })

  it('uses inspection patterns matching only actual raw, report and generated staging names', async () => {
    const root = await mkdtemp(join(tmpdir(), 'measurement-readme-orphans-'))
    roots.push(root)
    const measurementRoot = join(root, '.tdx-measurement')
    const rawRoot = join(measurementRoot, 'raw')
    const reportRoot = join(measurementRoot, 'reports')
    const generatedRoot = join(measurementRoot, 'generated')
    await Promise.all([
      mkdir(rawRoot, { recursive: true }),
      mkdir(reportRoot, { recursive: true }),
      mkdir(generatedRoot, { recursive: true }),
    ])

    await Promise.all([
      mkdir(join(measurementRoot, 'raw.tmp-a1b2c3')),
      mkdir(join(measurementRoot, 'unrelated.tmp-a1b2c3')),
      mkdir(join(reportRoot, 'instrumented-published-run')),
      mkdir(join(reportRoot, '.instrumented-safe-run-a1b2c3')),
      mkdir(join(reportRoot, '.unrelated')),
      mkdir(join(generatedRoot, 'run-a1b2c3')),
      mkdir(join(generatedRoot, 'unrelated-run-a1b2c3')),
    ])

    expect(await findDirectories(measurementRoot, 'raw.tmp-*')).toEqual(['raw.tmp-a1b2c3'])
    expect(await findDirectories(reportRoot, '.*-*')).toEqual(['.instrumented-safe-run-a1b2c3'])
    expect(await findDirectories(generatedRoot, 'run-*')).toEqual(['run-a1b2c3'])

    expect(readme).toContain("find .tdx-measurement/reports -mindepth 1 -maxdepth 1 -type d -name '.*-*' -print")
    expect(readme).toContain("find .tdx-measurement -mindepth 1 -maxdepth 1 -type d -name 'raw.tmp-*' -print")
    expect(readme).toContain("find .tdx-measurement/generated -mindepth 1 -maxdepth 1 -type d -name 'run-*' -print")
    expect(readme).toMatch(/Windows PowerShell/i)
    expect(readme).toMatch(/Get-ChildItem.*\.tdx-measurement/i)
  })
})
