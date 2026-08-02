import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

const root = process.cwd()

async function read(path) {
  return readFile(join(root, path), 'utf8')
}

describe('instance migration plan repository contract', () => {
  test('exposes the migration planner as a dedicated npm command', async () => {
    const packageJson = JSON.parse(await read('package.json'))
    expect(packageJson.scripts['instance:migration-plan']).toBe('node scripts/instance/migration-plan.mjs')
  })

  test('documents preview, remote effects, rollback and the deployment blocker boundary', async () => {
    const documentation = await read('docs/INSTANCE_MIGRATION_PLAN.md')
    expect(documentation).toContain('npm run instance:migration-plan')
    expect(documentation).toContain('NO CHANGES WERE APPLIED')
    expect(documentation).toContain('deployment cutover')
    expect(documentation).toContain('provisioning draft')
    expect(documentation).toContain('rollback')
    expect(documentation).toContain('--github-summary')
  })

  test('reuses the updater proposal without network, subprocess or resource mutation APIs', async () => {
    const source = await read('scripts/instance/migration-plan.mjs')
    expect(source).toContain('buildInstanceUpdate')
    expect(source).not.toMatch(/node:child_process/)
    expect(source).not.toMatch(/\bfetch\s*\(/)
    expect(source).not.toMatch(/\b(writeFile|rename|rm|mkdir|open)\s*\(/)
    expect(source).not.toMatch(/wrangler\s+(deploy|d1|r2)/)
    expect(source).not.toContain('github.rest')
  })
})
