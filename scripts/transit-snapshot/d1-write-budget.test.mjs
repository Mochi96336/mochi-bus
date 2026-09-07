import { describe, expect, it } from 'vitest'
import {
  budgetDecision,
  estimateScheduledPublishRowsWritten,
  estimateStageRowsWritten,
  logicalSnapshotRows,
} from './d1-write-budget.mjs'

describe('D1 snapshot write budget', () => {
  it('reduces the observed Taichung snapshot to the low-cardinality D1 footprint', () => {
    const counts = {
      routes: 461,
      patterns: 1179,
      stops: 17225,
      places: 4903,
      patternStops: 47050,
    }

    expect(logicalSnapshotRows(counts)).toBe(6543)
    expect(estimateStageRowsWritten(counts)).toBe(19629)
  })

  it('reduces the observed ChiayiCounty snapshot to low-cardinality D1 writes', () => {
    const counts = {
      routes: 106,
      patterns: 373,
      stops: 4073,
      places: 1472,
      patternStops: 13884,
    }

    expect(logicalSnapshotRows(counts)).toBe(1951)
    expect(estimateStageRowsWritten(counts)).toBe(5853)
  })

  it('reserves growth, low-cardinality cleanup, and fixed publication overhead', () => {
    const estimate = estimateScheduledPublishRowsWritten({
      routes: 461,
      patterns: 1179,
      stops: 17225,
      places: 4903,
      patternStops: 47050,
    }, { growthFactor: 1.10 })

    expect(estimate).toEqual({
      stageRows: 19629,
      cleanupRows: 6543,
      growthFactor: 1.10,
      estimatedRows: 28199,
      fixedReserveRows: 64,
    })
  })

  it('uses the exact low-cardinality cleanup count when supplied', () => {
    const estimate = estimateScheduledPublishRowsWritten({
      routes: 106,
      patterns: 373,
      stops: 4073,
      places: 1472,
      patternStops: 13884,
    }, { growthFactor: 1, cleanupRows: 123 })

    expect(estimate).toMatchObject({
      stageRows: 5853,
      cleanupRows: 123,
      estimatedRows: 6040,
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
