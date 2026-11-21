import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  SCHEDULE_CARRY_FORWARD_MAX_BYTES,
  carryForwardSchedules,
  previousScheduleArtifactKey,
  shouldCarryForwardSchedules,
} from './schedule-carry-forward.mjs'

async function mapParallel(items, concurrency, worker) {
  let index = 0
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) await worker(items[index++])
  })
  await Promise.all(runners)
}

const schedule = (routeUid, direction = 0) => ({
  RouteUID: routeUid,
  Direction: direction,
  Timetables: [{ TripID: '1', StopTimes: [{ StopSequence: 1, ArrivalTime: '06:00' }] }],
})

function r2(objects) {
  return vi.fn(async (key) => (key in objects ? structuredClone(objects[key]) : null))
}

describe('shouldCarryForwardSchedules', () => {
  it('only triggers when the whole city schedule is empty but routes exist', () => {
    expect(shouldCarryForwardSchedules({ cityRouteUids: ['KHH1'], cityScheduleItems: [] })).toBe(true)
    expect(shouldCarryForwardSchedules({ cityRouteUids: ['KHH1'], cityScheduleItems: [schedule('KHH1')] })).toBe(false)
    expect(shouldCarryForwardSchedules({ cityRouteUids: [], cityScheduleItems: [] })).toBe(false)
  })
})

describe('carryForwardSchedules', () => {
  const version = '20260829T021227256Z'

  it('reuses each route schedule artifact from the published version', async () => {
    const readJson = r2({
      [previousScheduleArtifactKey(version, 'Kaohsiung', 'KHH1')]: [schedule('KHH1', 0), schedule('KHH1', 1)],
      [previousScheduleArtifactKey(version, 'Kaohsiung', 'KHH2')]: [schedule('KHH2')],
    })

    const result = await carryForwardSchedules({
      city: 'Kaohsiung',
      cityRouteUids: ['KHH1', 'KHH2', 'KHH-NEW'],
      previousVersion: version,
      readJson,
      mapParallel,
    })

    expect(result.items).toEqual([schedule('KHH1', 0), schedule('KHH1', 1), schedule('KHH2')])
    expect(result.report).toEqual({
      event: 'snapshot_schedule_carried_forward',
      city: 'Kaohsiung',
      outcome: 'carried_forward',
      sourceVersion: version,
      cityRoutes: 3,
      carriedRoutes: 2,
      missingRoutes: 1,
    })
    expect(readJson).toHaveBeenCalledWith('snapshots/20260829T021227256Z/cities/Kaohsiung/schedules/KHH1.json')
  })

  it('keeps a stable item order regardless of read completion order', async () => {
    const delays = { KHH1: 20, KHH2: 0, KHH3: 10 }
    const readJson = vi.fn(async (key) => {
      const routeUid = key.split('/').at(-1).replace('.json', '')
      await new Promise((resolve) => setTimeout(resolve, delays[routeUid]))
      return [schedule(routeUid)]
    })

    const result = await carryForwardSchedules({
      city: 'Kaohsiung',
      cityRouteUids: ['KHH1', 'KHH2', 'KHH3', 'KHH1'],
      previousVersion: version,
      readJson,
      mapParallel,
    })

    expect(result.items.map((item) => item.RouteUID)).toEqual(['KHH1', 'KHH2', 'KHH3'])
    expect(readJson).toHaveBeenCalledTimes(3)
  })

  it('drops foreign or malformed items from a previous artifact', async () => {
    const readJson = r2({
      [previousScheduleArtifactKey(version, 'Kaohsiung', 'KHH1')]: [schedule('KHH1'), schedule('KHH9'), null, 'x'],
      [previousScheduleArtifactKey(version, 'Kaohsiung', 'KHH2')]: { not: 'an array' },
    })

    const result = await carryForwardSchedules({
      city: 'Kaohsiung',
      cityRouteUids: ['KHH1', 'KHH2'],
      previousVersion: version,
      readJson,
      mapParallel,
    })

    expect(result.items).toEqual([schedule('KHH1')])
    expect(result.report).toMatchObject({ carriedRoutes: 1, missingRoutes: 1 })
  })

  it('does nothing without a published version', async () => {
    const readJson = vi.fn()
    const result = await carryForwardSchedules({
      city: 'Kaohsiung',
      cityRouteUids: ['KHH1'],
      previousVersion: undefined,
      readJson,
      mapParallel,
    })

    expect(result.items).toEqual([])
    expect(result.report).toMatchObject({ outcome: 'no_previous_version', sourceVersion: null, carriedRoutes: 0 })
    expect(readJson).not.toHaveBeenCalled()
  })

  it('reports when the published version has no schedules either', async () => {
    const result = await carryForwardSchedules({
      city: 'Kaohsiung',
      cityRouteUids: ['KHH1'],
      previousVersion: version,
      readJson: r2({}),
      mapParallel,
    })

    expect(result.items).toEqual([])
    expect(result.report).toMatchObject({ outcome: 'previous_empty', missingRoutes: 1 })
  })

  it('propagates R2 read failures instead of publishing a half-carried snapshot', async () => {
    const readJson = vi.fn(async () => { throw new Error('R2 GET failed (500)') })
    await expect(carryForwardSchedules({
      city: 'Kaohsiung',
      cityRouteUids: ['KHH1'],
      previousVersion: version,
      readJson,
      mapParallel,
    })).rejects.toThrow('R2 GET failed (500)')
  })
})

describe('publisher wiring', () => {
  const publisher = readFileSync(new URL('../sync-transit-snapshot-core.mjs', import.meta.url), 'utf8')

  it('carries forward city schedules before intercity merge and before hashing content', () => {
    const fetchIndex = publisher.indexOf("const scheduleItems = await get('Schedule')")
    const carryIndex = publisher.indexOf('shouldCarryForwardSchedules({ cityRouteUids, cityScheduleItems: scheduleItems })')
    const intercityIndex = publisher.indexOf("tdxGet('Schedule/InterCity')")
    const hashIndex = publisher.indexOf('const contentHash = hashContent(')

    expect(fetchIndex).toBeGreaterThanOrEqual(0)
    expect(carryIndex).toBeGreaterThan(fetchIndex)
    expect(intercityIndex).toBeGreaterThan(carryIndex)
    expect(hashIndex).toBeGreaterThan(carryIndex)
  })

  it('reads previous schedule artifacts with a limit sized for raw route timetables', () => {
    // 回歸：曾用 s3GetJson 預設 1 MiB 上限，高雄 1.7 MB 的路線時刻表被 body_limit 擋下。
    expect(publisher).toContain('readJson: (key) => s3GetJson(key, SCHEDULE_CARRY_FORWARD_MAX_BYTES)')
    expect(SCHEDULE_CARRY_FORWARD_MAX_BYTES).toBeGreaterThanOrEqual(16 * 1024 * 1024)
  })

  it('still validates the carried snapshot against the previous counts', () => {
    expect(publisher).toContain('const validation = validateSnapshot({')
  })
})
