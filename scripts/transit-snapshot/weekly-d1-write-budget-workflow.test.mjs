import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const workflow = readFileSync('.github/workflows/snapshot-weekly-d1-budget-proof.yml', 'utf8')
const publisherWorkflow = readFileSync('.github/workflows/sync-transit.yml', 'utf8')
const report = readFileSync('scripts/transit-snapshot/weekly-d1-write-budget.mjs', 'utf8')

describe('weekly D1 budget proof workflow', () => {
  it('runs before the scheduled snapshot window and re-proves budget contract changes on main', () => {
    expect(workflow).toContain("- cron: '45 18 * * *'")
    expect(workflow).toContain('push:')
    expect(workflow).toContain("- 'scripts/transit-snapshot/d1-write-budget.mjs'")
    expect(workflow).toContain("- 'scripts/transit-snapshot/snapshot-schedule.mjs'")
    expect(workflow).toContain("- 'scripts/transit-snapshot/weekly-d1-write-budget.mjs'")
    expect(workflow).toContain('node scripts/instance/operation-scope.mjs snapshot')
    expect(workflow).toContain('node scripts/transit-snapshot/weekly-d1-write-budget.mjs')
  })

  it('uses the exact scheduled publisher budget and growth factor instead of an independent proof policy', () => {
    const proofBudget = workflow.match(/SNAPSHOT_D1_WRITE_BUDGET: '(\d+)'/)?.[1]
    const publisherBudget = publisherWorkflow.match(/SNAPSHOT_D1_WRITE_BUDGET: .*&& '(\d+)' \|\| ''/)?.[1]
    const proofGrowth = workflow.match(/SNAPSHOT_D1_ESTIMATE_GROWTH_FACTOR: '([^']+)'/)?.[1]
    const publisherGrowth = publisherWorkflow.match(/SNAPSHOT_D1_ESTIMATE_GROWTH_FACTOR: '([^']+)'/)?.[1]

    expect(proofBudget).toBeDefined()
    expect(publisherBudget).toBeDefined()
    expect(proofBudget).toBe(publisherBudget)
    expect(proofGrowth).toBeDefined()
    expect(publisherGrowth).toBeDefined()
    expect(proofGrowth).toBe(publisherGrowth)
  })

  it('has no TDX or mutation path and uploads bounded evidence', () => {
    expect(workflow).toContain('permissions:\n  contents: read')
    expect(workflow).toContain("SNAPSHOT_D1_WRITE_BUDGET: '75000'")
    expect(workflow).toContain("SNAPSHOT_D1_ESTIMATE_GROWTH_FACTOR: '1.10'")
    expect(workflow).toContain('snapshot-weekly-d1-budget-proof')
    expect(workflow).toContain('retention-days: 14')
    expect(workflow).not.toMatch(/TDX_CLIENT|TDX_ACCESS|snapshot:window|sync-transit-snapshot|npm run deploy|wrangler|migrations apply|SNAPSHOT_FORCE/)
    expect(report).toContain('estimateScheduledD1WriteForCity')
    expect(report).not.toContain('reserveScheduledD1Budget')
    expect(report).not.toContain('settleScheduledD1Budget')
  })

  it('aggregates cleanup rows once before feeding the unchanged per-city estimator', () => {
    expect(report).toContain('const cleanupRowsByCity = await readWeeklyCleanupRowsByCity({ env })')
    expect(report).toContain('readCleanupRows: async () => cleanupRowsByCity.get(city) ?? 0')
    expect(report).toContain('WEEKLY_CLEANUP_ROWS_SQL')
    expect((report.match(/await readWeeklyCleanupRowsByCity\(\{ env \}\)/g) ?? [])).toHaveLength(1)
  })
})
