import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
const deploy = read('.github/workflows/deploy.yml')
const sync = read('.github/workflows/sync-transit.yml')
const probe = read('.github/workflows/public-probe.yml')
const watchdog = read('.github/workflows/snapshot-window-watchdog.yml')
const packageJson = JSON.parse(read('package.json'))

describe('operator preflight workflow integration', () => {
  it('runs deployment preflight before validation and deployment', () => {
    const preflight = deploy.indexOf('npm run instance:preflight -- deploy')
    expect(preflight).toBeGreaterThan(-1)
    expect(deploy.indexOf('name: Verify release candidate')).toBeGreaterThan(preflight)
    expect(deploy.indexOf('name: Deploy Worker')).toBeGreaterThan(preflight)
    expect(deploy).toContain('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_DEPLOY_API_TOKEN }}')
    expect(deploy).toContain('RELEASE_SMOKE_ORIGIN: ${{ steps.operation.outputs.public_origin || vars.RELEASE_SMOKE_ORIGIN }}')
  })

  it('preflights scheduled and manually forced snapshots before migrations', () => {
    const preflight = sync.indexOf('npm run instance:preflight -- snapshot')
    expect(preflight).toBeGreaterThan(-1)
    expect(sync.indexOf('name: Apply transit database migrations')).toBeGreaterThan(preflight)
    expect(sync.indexOf('name: Build and publish snapshot')).toBeGreaterThan(preflight)
    expect(sync).toContain("MOCHI_BUS_PREFLIGHT_FORCE_ENABLED: ${{ github.event_name == 'workflow_dispatch' && 'true' || 'false' }}")
    for (const secret of [
      'TDX_CLIENT_ID',
      'TDX_CLIENT_SECRET',
      'CLOUDFLARE_API_TOKEN',
      'CLOUDFLARE_ACCOUNT_ID',
      'R2_ACCESS_KEY_ID',
      'R2_SECRET_ACCESS_KEY',
    ]) {
      expect(sync).toContain(`${secret}: \${{ secrets.${secret} }}`)
    }
  })

  it('preflights probe and watchdog only when their operation gate is enabled', () => {
    for (const [source, operation] of [[probe, 'publicProbe'], [watchdog, 'windowWatchdog']]) {
      const preflight = source.indexOf(`npm run instance:preflight -- ${operation}`)
      expect(preflight).toBeGreaterThan(-1)
      expect(source.lastIndexOf("if: steps.operation.outputs.enabled == 'true'", preflight)).toBeGreaterThan(-1)
      expect(source.indexOf('name: Apply transit database migrations')).toBeGreaterThan(preflight)
      expect(source).toContain('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}')
      expect(source).toContain('CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}')
    }
    expect(probe).toContain('SNAPSHOT_SMOKE_BASE_URL: ${{ steps.operation.outputs.public_origin || vars.SNAPSHOT_SMOKE_BASE_URL }}')
  })

  it('exposes one shared command instead of embedding credential validation in YAML', () => {
    expect(packageJson.scripts['instance:preflight']).toBe('node scripts/instance/operator-preflight.mjs')
    expect(deploy).not.toContain('if [ -z "$CLOUDFLARE')
    expect(sync).not.toContain('if [ -z "$TDX_CLIENT')
    expect(probe).not.toContain('if [ -z "$CLOUDFLARE')
    expect(watchdog).not.toContain('if [ -z "$CLOUDFLARE')
  })
})
