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
})
