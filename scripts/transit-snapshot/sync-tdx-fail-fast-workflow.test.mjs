import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const workflow = readFileSync(
  new URL('../../.github/workflows/sync-transit.yml', import.meta.url),
  'utf8',
)

describe('snapshot sync TDX fail-fast workflow', () => {
  it('does not require TDX authentication when no city is scheduled', () => {
    const noCities = workflow.indexOf('if [ -z "$cities" ]; then')
    const emptyExit = workflow.indexOf('echo "今天沒有排程的城市"', noCities)
    const credentialPreflight = workflow.indexOf('npm run snapshot:tdx-preflight')

    expect(noCities).toBeGreaterThan(-1)
    expect(emptyExit).toBeGreaterThan(noCities)
    expect(credentialPreflight).toBeGreaterThan(emptyExit)
  })

  it('authenticates before scheduled readiness scans and city publication', () => {
    const credentialPreflight = workflow.indexOf('npm run snapshot:tdx-preflight')
    const readiness = workflow.indexOf('scripts/transit-snapshot/high-card-retirement-readiness.mjs')
    const cityLoop = workflow.indexOf('for city in $cities; do')
    const windowPublish = workflow.indexOf('npm run snapshot:window -- "$city"')

    expect(credentialPreflight).toBeGreaterThan(-1)
    expect(readiness).toBeGreaterThan(credentialPreflight)
    expect(cityLoop).toBeGreaterThan(readiness)
    expect(windowPublish).toBeGreaterThan(cityLoop)
  })

  it('authenticates before legacy repair preflight while preserving its confirmation gate', () => {
    const credentialPreflight = workflow.indexOf('npm run snapshot:tdx-preflight')
    const repairConfirmation = workflow.indexOf("echo 'Legacy previous repair requires force_publish=true'")
    const repairPreflight = workflow.indexOf('npm run snapshot:repair-legacy-previous --')

    expect(repairConfirmation).toBeGreaterThan(-1)
    expect(credentialPreflight).toBeGreaterThan(repairConfirmation)
    expect(repairPreflight).toBeGreaterThan(credentialPreflight)
  })

  it('uses the existing bounded credential-only command without changing secret inputs', () => {
    expect(workflow).toContain('TDX_CLIENT_ID: ${{ secrets.TDX_CLIENT_ID }}')
    expect(workflow).toContain('TDX_CLIENT_SECRET: ${{ secrets.TDX_CLIENT_SECRET }}')
    expect(workflow.match(/npm run snapshot:tdx-preflight/g)).toHaveLength(1)
  })
})
