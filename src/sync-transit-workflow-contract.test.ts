/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest'
import workflowSource from '../.github/workflows/sync-transit.yml?raw'
import { supportedCities } from './config'

function expectedManualCityInput(): string {
  return [
    '      city:',
    '        description: TDX city code',
    '        required: true',
    '        type: choice',
    '        options:',
    ...supportedCities.map(([code]) => `          - ${code}`),
    '        default: Chiayi',
  ].join('\n')
}

describe('Sync transit snapshots workflow contract', () => {
  it('offers exactly every supported city in manual dispatch', () => {
    expect(supportedCities).toHaveLength(22)
    expect(workflowSource).toContain(`${expectedManualCityInput()}\n      force_publish:`)
  })

  it('validates a manual choice against the instance before repair or publication', () => {
    const validation = 'node scripts/instance/assert-operation-city.mjs "$INPUT_CITY"'
    const repairPreflight = 'npm run snapshot:repair-legacy-previous --'
    const publication = 'npm run snapshot:window -- "$city"'

    expect(workflowSource).toContain(validation)
    expect(workflowSource).toContain(repairPreflight)
    expect(workflowSource).toContain(publication)
    expect(workflowSource.indexOf(validation)).toBeLessThan(workflowSource.indexOf(repairPreflight))
    expect(workflowSource.indexOf(validation)).toBeLessThan(workflowSource.indexOf(publication))
  })

  it('acquires one shared TDX token before migrations and reuses only its job-local file', () => {
    const resourcePreflight = '- name: Preflight snapshot resources'
    const tokenPreflight = '- name: Acquire shared TDX snapshot token'
    const tokenCommand = 'node scripts/transit-snapshot/prepare-snapshot-tdx-token.mjs'
    const migrations = '- name: Apply transit database migrations'
    const publication = '- name: Build and publish snapshot'
    const tokenFile = 'SNAPSHOT_TDX_ACCESS_TOKEN_FILE: .transit-snapshot/tdx-access-token.json'
    const preload = 'NODE_OPTIONS: --import=./scripts/transit-snapshot/install-snapshot-tdx-token-file.mjs'
    const cleanup = '- name: Cleanup shared TDX snapshot token'

    expect(workflowSource).toContain(tokenCommand)
    expect(workflowSource.match(new RegExp(tokenCommand.replaceAll('.', '\\.'), 'g'))).toHaveLength(1)
    expect(workflowSource.indexOf(resourcePreflight)).toBeLessThan(workflowSource.indexOf(tokenPreflight))
    expect(workflowSource.indexOf(tokenPreflight)).toBeLessThan(workflowSource.indexOf(migrations))
    expect(workflowSource.indexOf(migrations)).toBeLessThan(workflowSource.indexOf(publication))
    expect(workflowSource).toContain(tokenFile)
    expect(workflowSource).toContain(preload)
    expect(workflowSource).toContain(cleanup)
    expect(workflowSource).toContain('if: always()')
    expect(workflowSource).not.toContain('SNAPSHOT_TDX_ACCESS_TOKEN:')
    expect(workflowSource).not.toContain('access_token: ${{')
  })

  it('sources static refresh floors from operation scope and bypasses them for manual dispatch', () => {
    const bindings = [
      ['SNAPSHOT_CITY_TOPOLOGY_REFRESH_DAYS', 'static_city_topology_refresh_days'],
      ['SNAPSHOT_CITY_SCHEDULE_REFRESH_DAYS', 'static_city_schedule_refresh_days'],
      ['SNAPSHOT_CITY_SHAPE_REFRESH_DAYS', 'static_city_shape_refresh_days'],
      ['SNAPSHOT_INTERCITY_TOPOLOGY_REFRESH_DAYS', 'static_intercity_topology_refresh_days'],
      ['SNAPSHOT_INTERCITY_SCHEDULE_REFRESH_DAYS', 'static_intercity_schedule_refresh_days'],
      ['SNAPSHOT_INTERCITY_SHAPE_REFRESH_DAYS', 'static_intercity_shape_refresh_days'],
    ] as const

    for (const [envName, outputName] of bindings) {
      expect(workflowSource).toContain(
        `${envName}: \${{ steps.operation.outputs.${outputName} }}`,
      )
      expect(workflowSource).not.toMatch(new RegExp(`${envName}: ['\"]?\\d+`))
    }
    expect(workflowSource).toContain(
      "SNAPSHOT_STATIC_SOURCE_BYPASS_FLOOR: ${{ github.event_name == 'workflow_dispatch' && '1' || '' }}",
    )
  })
})
