import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
const sync = read('.github/workflows/sync-transit.yml')
const deploy = read('.github/workflows/deploy.yml')

describe('manual production workflow intent gates', () => {
  it('requires main plus a mode-specific confirmation before manual snapshot credentials or mutation', () => {
    expect(sync).toContain('confirmation:')
    expect(sync).toContain('description: Type SYNC_<City>, FORCE_<City>, or REPAIR_<City> to match the selected manual operation')
    expect(sync).toContain('name: Validate manual production snapshot intent')
    expect(sync).toContain("if: github.event_name == 'workflow_dispatch'")
    expect(sync).toContain('test "$GITHUB_REF" = "refs/heads/main"')
    expect(sync).toContain('expected="REPAIR_${INPUT_CITY}"')
    expect(sync).toContain('expected="FORCE_${INPUT_CITY}"')
    expect(sync).toContain('expected="SYNC_${INPUT_CITY}"')
    expect(sync).toContain('test "$INPUT_CONFIRMATION" = "$expected"')
    expect(sync).toContain('test "$INPUT_FORCE_PUBLISH" = "true"')

    const gate = sync.indexOf('name: Validate manual production snapshot intent')
    const checkout = sync.indexOf('actions/checkout@')
    const preflight = sync.indexOf('npm run instance:preflight -- snapshot')
    const migration = sync.indexOf('name: Apply transit database migrations')
    const publication = sync.indexOf('name: Build and publish snapshot')
    const firstCloudflareSecret = sync.indexOf('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}')
    expect(gate).toBeGreaterThanOrEqual(0)
    expect(checkout).toBeGreaterThan(gate)
    expect(preflight).toBeGreaterThan(checkout)
    expect(firstCloudflareSecret).toBeGreaterThan(gate)
    expect(migration).toBeGreaterThan(preflight)
    expect(publication).toBeGreaterThan(migration)
  })

  it('preserves scheduled snapshot semantics and keeps the D1 budget scoped to schedule runs', () => {
    expect(sync).toContain("- cron: '17 19 * * *'")
    expect(sync).toContain("SNAPSHOT_D1_WRITE_BUDGET: ${{ github.event_name == 'schedule' && '75000' || '' }}")
    expect(sync).toContain("SNAPSHOT_STATIC_SOURCE_BYPASS_FLOOR: ${{ github.event_name == 'workflow_dispatch' && '1' || '' }}")
  })

  it('requires main plus DEPLOY_PRODUCTION before a manual Worker deploy can reach credentials', () => {
    expect(deploy).toContain('workflow_dispatch:')
    expect(deploy).toContain('confirmation:')
    expect(deploy).toContain('description: Type DEPLOY_PRODUCTION to manually deploy the current main commit')
    expect(deploy).toContain('name: Validate manual production deploy intent')
    expect(deploy).toContain("if: github.event_name == 'workflow_dispatch'")
    expect(deploy).toContain('test "$GITHUB_REF" = "refs/heads/main"')
    expect(deploy).toContain('test "$INPUT_CONFIRMATION" = "DEPLOY_PRODUCTION"')

    const gate = deploy.indexOf('name: Validate manual production deploy intent')
    const checkout = deploy.indexOf('actions/checkout@')
    const deploySecret = deploy.indexOf('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_DEPLOY_API_TOKEN }}')
    const mutation = deploy.indexOf('name: Deploy Worker')
    expect(gate).toBeGreaterThanOrEqual(0)
    expect(checkout).toBeGreaterThan(gate)
    expect(deploySecret).toBeGreaterThan(gate)
    expect(mutation).toBeGreaterThan(deploySecret)
  })

  it('preserves automatic main-push deployment without requiring a manual confirmation', () => {
    expect(deploy).toContain('push:\n    branches:\n      - main')
    expect(deploy.match(/if: github\.event_name == 'workflow_dispatch'/g)).toHaveLength(1)
    expect(deploy).toContain('name: Deploy Worker')
  })
})
