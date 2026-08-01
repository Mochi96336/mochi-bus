import { describe, expect, it } from 'vitest'
import { operationEnabledCities } from '../instance/operations-plan.mjs'
import { scheduledCitiesAt } from './scheduled-cities.mjs'
import {
  latestClosedSnapshotScheduleDate,
  scheduledCitiesForTaipeiDate,
  scheduledSnapshotWindow,
  scopeSnapshotSchedule,
  SNAPSHOT_SUPPORTED_CITIES_BY_TAIPEI_WEEKDAY,
  taipeiLocalTimeAsUtc,
} from './snapshot-schedule.mjs'
import { snapshotWindowIdentity } from './window-contract.mjs'

const scheduleDates = [
  '2026-07-19',
  '2026-07-20',
  '2026-07-21',
  '2026-07-22',
  '2026-07-23',
  '2026-07-24',
  '2026-07-25',
]

describe('snapshot schedule contract', () => {
  it('keeps the complete supported Taipei-weekday schedule stable', () => {
    expect(SNAPSHOT_SUPPORTED_CITIES_BY_TAIPEI_WEEKDAY).toEqual([
      ['Taoyuan', 'YilanCounty', 'HualienCounty', 'TaitungCounty'],
      ['Taipei', 'NewTaipei'],
      ['Chiayi', 'Keelung', 'Hsinchu', 'HsinchuCounty'],
      ['Tainan', 'MiaoliCounty', 'NantouCounty', 'PenghuCounty', 'KinmenCounty', 'LienchiangCounty'],
      ['ChiayiCounty', 'ChanghuaCounty', 'PingtungCounty'],
      ['Taichung'],
      ['Kaohsiung', 'YunlinCounty'],
    ])
    expect(SNAPSHOT_SUPPORTED_CITIES_BY_TAIPEI_WEEKDAY.flat()).toHaveLength(22)
  })

  it('filters the live schedule to the current instance without moving weekdays', () => {
    const enabled = new Set(operationEnabledCities())
    for (const [weekday, date] of scheduleDates.entries()) {
      expect(scheduledCitiesForTaipeiDate(date)).toEqual(
        SNAPSHOT_SUPPORTED_CITIES_BY_TAIPEI_WEEKDAY[weekday].filter((city) => enabled.has(city)),
      )
    }

    expect(scopeSnapshotSchedule(
      SNAPSHOT_SUPPORTED_CITIES_BY_TAIPEI_WEEKDAY,
      ['Chiayi', 'Taichung'],
    )).toEqual([
      [],
      [],
      ['Chiayi'],
      [],
      [],
      ['Taichung'],
      [],
    ])
    expect(() => scopeSnapshotSchedule(
      SNAPSHOT_SUPPORTED_CITIES_BY_TAIPEI_WEEKDAY,
      ['Atlantis'],
    )).toThrow('Enabled city is missing from snapshot schedule: Atlantis')
  })

  it('maps UTC Sunday 23:45 to Taipei Monday 07:45 without runner timezone state', () => {
    const now = new Date('2026-07-19T23:45:00.000Z')
    const enabled = new Set(operationEnabledCities())
    expect(scheduledCitiesAt(now)).toEqual(
      SNAPSHOT_SUPPORTED_CITIES_BY_TAIPEI_WEEKDAY[1].filter((city) => enabled.has(city)),
    )
    expect(latestClosedSnapshotScheduleDate(now)).toBe('2026-07-20')
  })

  it('keeps a delayed pre-close run attached to the previous closed date', () => {
    expect(latestClosedSnapshotScheduleDate(new Date('2026-07-20T23:29:59.000Z'))).toBe('2026-07-20')
    expect(latestClosedSnapshotScheduleDate(new Date('2026-07-20T23:30:00.000Z'))).toBe('2026-07-21')
  })

  it('produces one deterministic scheduled window for an enabled city', () => {
    const city = operationEnabledCities()[0]
    const weekday = SNAPSHOT_SUPPORTED_CITIES_BY_TAIPEI_WEEKDAY.findIndex((cities) => cities.includes(city))
    const scheduleDate = scheduleDates[weekday]
    const expected = scheduledSnapshotWindow(city, scheduleDate)
    expect(expected).toEqual({
      windowId: `v1:${city}:${scheduleDate}:0317`,
      scheduledAt: taipeiLocalTimeAsUtc(scheduleDate, 3, 17).toISOString(),
      runKind: 'scheduled',
    })
    expect(snapshotWindowIdentity({
      city,
      now: new Date(new Date(expected.scheduledAt).getTime() + 60_000),
    })).toEqual(expected)
  })
})
