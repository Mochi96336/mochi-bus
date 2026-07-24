import { describe, expect, it } from 'vitest'
import { aggregateAssignmentIterations } from './report.mjs'

function snapshot({ best = [], forcedMatch = [], forcedUnmatched = [], activeMaskPeak = null } = {}) {
  return {
    assignment: {
      bestCount: best.length,
      forcedMatchCount: forcedMatch.length,
      forcedUnmatchedCount: forcedUnmatched.length,
      bestTimeSamplesMs: best,
      forcedMatchTimeSamplesMs: forcedMatch,
      forcedUnmatchedTimeSamplesMs: forcedUnmatched,
      activeMaskPeak,
    },
  }
}

describe('assignment timing contract', () => {
  it('uses null rather than invented zero when no assignment solve ran', () => {
    expect(aggregateAssignmentIterations([snapshot(), snapshot()])).toEqual({
      bestCount: 0,
      forcedMatchCount: 0,
      forcedUnmatchedCount: 0,
      bestTimeMs: null,
      ambiguityProofTimeMs: null,
      activeMaskPeak: null,
    })
  })

  it('sums every forced solve within an iteration before cross-iteration median', () => {
    const hundredForced = Array.from({ length: 100 }, () => 1)
    expect(aggregateAssignmentIterations([snapshot({ forcedMatch: hundredForced })]).ambiguityProofTimeMs).toBe(100)

    const result = aggregateAssignmentIterations([
      snapshot({ forcedMatch: [4], forcedUnmatched: [6] }),
      snapshot({ forcedMatch: [60], forcedUnmatched: [40] }),
      snapshot({ forcedMatch: [7], forcedUnmatched: [13] }),
    ])
    expect(result.ambiguityProofTimeMs).toBe(20)
    expect(result.forcedMatchCount).toBe(1)
    expect(result.forcedUnmatchedCount).toBe(1)
  })

  it('takes nearest-rank median of per-iteration best totals', () => {
    expect(aggregateAssignmentIterations([
      snapshot({ best: [4, 6] }),
      snapshot({ best: [40, 60] }),
      snapshot({ best: [8, 12] }),
    ]).bestTimeMs).toBe(20)
  })

  it('fails closed when structural solve counts differ between iterations', () => {
    expect(() => aggregateAssignmentIterations([
      snapshot({ forcedMatch: [1] }),
      snapshot({ forcedMatch: [1, 1] }),
    ])).toThrow(/solve counts.*iterations/i)
  })
})
