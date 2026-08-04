import { describe, expect, it } from 'vitest'
import {
  homeSnapshotSourceIsFresh,
  homeSnapshotSourceTimestamp,
} from './home-snapshot-freshness'

const snapshot = (savedAt: number, updatedText: string) => JSON.stringify({
  version: 2,
  savedAt,
  updatedText,
})

describe('home snapshot source freshness', () => {
  it('uses the displayed ETA data time instead of renewing on DOM capture', () => {
    const capturedAt = Date.parse('2026-08-04T04:10:00.000Z') // 12:10 in Taipei
    const raw = snapshot(capturedAt, '資料 12:00:00')
    expect(homeSnapshotSourceTimestamp(raw)).toBe(Date.parse('2026-08-04T04:00:00.000Z'))
    expect(homeSnapshotSourceIsFresh(raw, capturedAt)).toBe(false)
  })

  it('accepts a genuinely recent source timestamp', () => {
    const capturedAt = Date.parse('2026-08-04T04:01:00.000Z')
    const raw = snapshot(capturedAt, '資料 12:00:00')
    expect(homeSnapshotSourceIsFresh(raw, Date.parse('2026-08-04T04:02:30.000Z'))).toBe(true)
  })

  it('handles the Taipei midnight rollover', () => {
    const capturedAt = Date.parse('2026-08-04T16:01:00.000Z') // 00:01 next day
    const raw = snapshot(capturedAt, '資料 23:59:00')
    expect(homeSnapshotSourceTimestamp(raw)).toBe(Date.parse('2026-08-04T15:59:00.000Z'))
    expect(homeSnapshotSourceIsFresh(raw, capturedAt)).toBe(true)
  })

  it('rejects snapshots without a trustworthy data timestamp', () => {
    const capturedAt = Date.parse('2026-08-04T04:01:00.000Z')
    expect(homeSnapshotSourceIsFresh(snapshot(capturedAt, '暫時無法更新'), capturedAt)).toBe(false)
    expect(homeSnapshotSourceIsFresh('{bad json', capturedAt)).toBe(false)
  })
})
