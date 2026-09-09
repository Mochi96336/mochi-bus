import { describe, expect, it, vi } from 'vitest'
import { estimateScheduledD1WriteForCity } from './d1-write-budget.mjs'

describe('read-only scheduled D1 write estimate', () => {
  it('uses published R2 counts and exact stale low-cardinality cleanup rows without a ledger write', async () => {
    const readState = vi.fn(async () => ({
      activeVersion: 'v-current',
      counts: { routes: 100, patterns: 200, stops: 5000, places: 50, patternStops: 12000 },
    }))
    const readCleanupRows = vi.fn(async () => 70)

    await expect(estimateScheduledD1WriteForCity({
      city: 'Taipei',
      env: { SNAPSHOT_D1_ESTIMATE_GROWTH_FACTOR: '1.10' },
      readState,
      readCleanupRows,
    })).resolves.toEqual({
      city: 'Taipei',
      counts: { routes: 100, patterns: 200, stops: 5000, places: 50, patternStops: 12000 },
      estimate: {
        stageRows: 1050,
        cleanupRows: 70,
        growthFactor: 1.1,
        estimatedRows: 1289,
        fixedReserveRows: 64,
      },
    })

    expect(readState).toHaveBeenCalledOnce()
    expect(readState).toHaveBeenCalledWith('Taipei')
    expect(readCleanupRows).toHaveBeenCalledOnce()
    expect(readCleanupRows).toHaveBeenCalledWith('Taipei')
  })

  it('fails closed on missing published counts before querying cleanup rows', async () => {
    const readCleanupRows = vi.fn()
    await expect(estimateScheduledD1WriteForCity({
      city: 'Taipei',
      readState: async () => ({ activeVersion: 'v-current' }),
      readCleanupRows,
    })).rejects.toThrow('published snapshot counts for Taipei')
    expect(readCleanupRows).not.toHaveBeenCalled()
  })
})
