import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const syncWorkflow = readFileSync('.github/workflows/sync-transit.yml', 'utf8')
const publicProbeWorkflow = readFileSync('.github/workflows/public-probe.yml', 'utf8')
const watchdogWorkflow = readFileSync('.github/workflows/snapshot-window-watchdog.yml', 'utf8')
const publicProbeRunner = readFileSync('scripts/transit-snapshot/run-public-probe.mjs', 'utf8')

describe('instance operational workflow gates', () => {
  it('resolves and preflights snapshot scope before migrations and publication', () => {
    const scope = 'node scripts/instance/operation-scope.mjs snapshot'
    const preflight = 'npm run instance:preflight -- snapshot'
    const migration = 'wrangler d1 migrations apply'
    const publication = 'name: Build and publish snapshot'
    const condition = "github.event_name == 'workflow_dispatch' || steps.operation.outputs.enabled == 'true'"

    expect(syncWorkflow).toContain(scope)
    expect(syncWorkflow).toContain(preflight)
    expect(syncWorkflow.indexOf(scope)).toBeLessThan(syncWorkflow.indexOf(preflight))
    expect(syncWorkflow.indexOf(preflight)).toBeLessThan(syncWorkflow.indexOf(migration))
    expect(syncWorkflow.indexOf(migration)).toBeLessThan(syncWorkflow.indexOf(publication))
    expect(syncWorkflow.match(new RegExp(condition.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')))
      .toHaveLength(3)
  })

  it('skips disabled public probe and watchdog before preflight or D1 access', () => {
    for (const [source, operation] of [
      [publicProbeWorkflow, 'publicProbe'],
      [watchdogWorkflow, 'windowWatchdog'],
    ]) {
      const scope = `node scripts/instance/operation-scope.mjs ${operation}`
      const preflight = `npm run instance:preflight -- ${operation}`
      const migration = 'wrangler d1 migrations apply'

      expect(source).toContain(scope)
      expect(source).toContain(preflight)
      expect(source.indexOf(scope)).toBeLessThan(source.indexOf(preflight))
      expect(source.indexOf(preflight)).toBeLessThan(source.indexOf(migration))
      expect(source.match(/if: steps\.operation\.outputs\.enabled == 'true'/g)).toHaveLength(3)
    }
  })

  it('does not silently fall back to the Mochi production origin', () => {
    expect(publicProbeRunner).toContain('resolvePublicProbeBaseUrl')
    expect(publicProbeRunner).not.toContain('PUBLIC_PROBE_DEFAULT_BASE_URL')
    expect(publicProbeRunner).not.toContain("'https://bus.moc96336.com'")
  })
})
