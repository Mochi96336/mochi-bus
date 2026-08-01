/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest'
import publicProbeWorkflow from '../.github/workflows/public-probe.yml?raw'
import watchdogWorkflow from '../.github/workflows/snapshot-window-watchdog.yml?raw'
import packageSource from '../package.json?raw'
import releaseSmokeSource from '../scripts/release-smoke/run-post-deploy.mjs?raw'
import snapshotPublisherSource from '../scripts/sync-transit-snapshot.mjs?raw'
import publicProbeSource from '../scripts/transit-snapshot/run-public-probe.mjs?raw'
import rollbackSource from '../scripts/transit-snapshot/rollback.mjs?raw'

function expectScopedWorkflow(source: string, operation: string): void {
  expect(source).toContain(`node scripts/instance/operation-scope.mjs ${operation}`)
  expect(source).toContain("if: steps.operation.outputs.enabled == 'true'")
  expect(source).toContain('"${{ steps.operation.outputs.d1_database_name }}"')
  expect(source).toContain('--config .generated/instance/wrangler.instance.jsonc')
  expect(source).not.toContain('d1 migrations apply mochi-transit')
}

describe('instance operational workflow contracts', () => {
  it('gates public probe and supplies generated D1 and public origin identity', () => {
    expectScopedWorkflow(publicProbeWorkflow, 'publicProbe')
    expect(publicProbeWorkflow).toContain('TRANSIT_DATABASE_ID: ${{ steps.operation.outputs.d1_database_id }}')
    expect(publicProbeWorkflow).toContain(
      'SNAPSHOT_SMOKE_BASE_URL: ${{ steps.operation.outputs.public_origin || vars.SNAPSHOT_SMOKE_BASE_URL }}',
    )
  })

  it('gates the watchdog and supplies its generated D1 database ID', () => {
    expectScopedWorkflow(watchdogWorkflow, 'windowWatchdog')
    expect(watchdogWorkflow).toContain('TRANSIT_DATABASE_ID: ${{ steps.operation.outputs.d1_database_id }}')
  })

  it('uses the generated Wrangler config for dev, deploy, types and dry-run', () => {
    const scripts = JSON.parse(packageSource).scripts as Record<string, string>
    for (const name of ['dev', 'deploy', 'cf-typegen', 'cf-typegen:check', 'check']) {
      expect(scripts[name], name).toContain('.generated/instance/wrangler.instance.jsonc')
    }
  })

  it('does not retain Mochi production fallbacks in operational entrypoints', () => {
    for (const source of [snapshotPublisherSource, publicProbeSource, rollbackSource, releaseSmokeSource]) {
      expect(source).toContain('operational-resources.mjs')
      expect(source).not.toContain("const DATABASE = 'mochi-transit'")
      expect(source).not.toContain("const BUCKET = 'mochi-transit-shapes'")
      expect(source).not.toContain("const DEFAULT_ORIGIN = 'https://bus.moc96336.com'")
      expect(source).not.toContain("?? 'https://bus.moc96336.com'")
    }
  })
})
