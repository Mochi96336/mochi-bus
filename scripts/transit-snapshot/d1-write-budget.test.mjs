import { describe, expect, it } from 'vitest'
import {
  budgetDecision,
  estimateScheduledPublishRowsWritten,
  estimateStageRowsWritten,
  logicalSnapshotRows,
} from './d1-write-budget.mjs'

describe('D1 snapshot write budget', () => {
  it('matches the observed Taichung staging amplification', () => {
    const counts = {
      routes: 461,
      patterns: 1179,
      stops: 17225,
      places: 4903,
      patternStops: 47050,
    }

    expect(logicalSnapshotRows(counts)).toBe(70818)
    expect(estimateStageRowsWritten(counts)).toBe(229679)
  })

  it('matches the observed ChiayiCounty staging amplification', () => {
    const counts = {
      routes: 106,
      patterns: 373,
      stops: 4073,
      places: 1472,
      patternStops: 13884,
    }

    expect(logicalSnapshotRows(counts)).toBe(19908)
    expect(estimateStageRowsWritten(counts)).toBe(63797)
  })

  it('reserves growth, cleanup, and fixed publication overhead', () => {
    const estimate = estimateScheduledPublishRowsWritten({
      routes: 461,
      patterns: 1179,
      stops: 17225,
      places: 4903,
      patternStops: 47050,
    }, { growthFactor: 1.10 })

    expect(estimate).toEqual({
      stageRows: 229679,
      cleanupRows: 70818,
      growthFactor: 1.10,
      estimatedRows: 323529,
      fixedReserveRows: 64,
    })
  })

  it('fails closed when the workflow-wide reservation would exceed the budget', () => {
    expect(budgetDecision({
      budgetRows: 75000,
      reservedRows: 62000,
      estimatedRows: 20000,
    })).toMatchObject({
      allowed: false,
      remainingRows: 13000,
      projectedRows: 82000,
    })
  })
})
