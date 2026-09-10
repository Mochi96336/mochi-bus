import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const workflow = readFileSync(new URL('../../.github/workflows/sync-transit.yml', import.meta.url), 'utf8')

describe('scheduled native authority refresh workflow', () => {
  it('derives automatic force-publish only from the read-only retirement proof on scheduled runs', () => {
    const scheduledCities = workflow.indexOf('cities="$(node scripts/transit-snapshot/scheduled-cities.mjs)"')
    const readiness = workflow.indexOf('node scripts/transit-snapshot/high-card-retirement-readiness.mjs')
    const decision = workflow.indexOf('node scripts/transit-snapshot/scheduled-native-authority-refresh.mjs')
    const publisher = workflow.indexOf('npm run snapshot:window -- "$city"')

    expect(scheduledCities).toBeGreaterThan(-1)
    expect(readiness).toBeGreaterThan(scheduledCities)
    expect(decision).toBeGreaterThan(readiness)
    expect(publisher).toBeGreaterThan(decision)
    expect(workflow).toContain('retirement_report=""')
    expect(workflow).toContain('retirement_report="$SNAPSHOT_HIGH_CARD_RETIREMENT_REPORT"')
    expect(workflow).toContain('refresh_flag="$(node scripts/transit-snapshot/scheduled-native-authority-refresh.mjs "$retirement_report" "$city")"')
    expect(workflow).toContain('unset SNAPSHOT_FORCE')
  })

  it('keeps automatic readiness collection fail-open without turning an unknown report into force publish', () => {
    expect(workflow).toContain('if node scripts/transit-snapshot/high-card-retirement-readiness.mjs; then')
    expect(workflow).toContain('scheduled_native_authority_refresh_unavailable')
    expect(workflow).toContain('continue_without_force_publish')
    expect(workflow).toContain('Invalid scheduled native authority refresh flag for $city')
  })

  it('preserves the existing manual force and static-source bypass boundaries', () => {
    expect(workflow).toContain('if [ "$INPUT_FORCE_PUBLISH" = "true" ]; then')
    expect(workflow).toContain("SNAPSHOT_STATIC_SOURCE_BYPASS_FLOOR: ${{ github.event_name == 'workflow_dispatch' && '1' || '' }}")
    expect(workflow).toContain("SNAPSHOT_D1_WRITE_BUDGET: ${{ github.event_name == 'schedule' && '75000' || '' }}")
    expect(workflow.match(/export SNAPSHOT_FORCE=1/g)).toHaveLength(2)
  })

  it('does not introduce a second publisher, rollback, backfill, or direct D1 mutation path', () => {
    expect(workflow).not.toContain('scheduled-native-authority-refresh.yml')
    expect(workflow).not.toMatch(/wrangler d1 execute.*scheduled-native-authority-refresh/)
    expect(workflow).not.toMatch(/snapshot:rollback|ROLLBACK_TAICHUNG/)
    expect(workflow).not.toMatch(/snapshot:backfill|backfill-(?:pattern|place|transfer|stop)/)
  })
})
