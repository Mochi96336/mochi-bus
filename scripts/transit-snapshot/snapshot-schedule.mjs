import { loadOperationsPlan } from '../instance/operations-plan.mjs'

export const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000
export const SNAPSHOT_SCHEDULE_HOUR = 3
export const SNAPSHOT_SCHEDULE_MINUTE = 17
export const SNAPSHOT_WINDOW_CLOSE_HOUR = 7
export const SNAPSHOT_WINDOW_CLOSE_MINUTE = 30

export const SNAPSHOT_SUPPORTED_CITIES_BY_TAIPEI_WEEKDAY = Object.freeze([
  Object.freeze(['Taoyuan', 'YilanCounty', 'HualienCounty', 'TaitungCounty']),
  Object.freeze(['Taipei', 'NewTaipei']),
  Object.freeze(['Chiayi', 'Keelung', 'Hsinchu', 'HsinchuCounty']),
  Object.freeze(['Tainan', 'MiaoliCounty', 'NantouCounty', 'PenghuCounty', 'KinmenCounty', 'LienchiangCounty']),
  Object.freeze(['ChiayiCounty', 'ChanghuaCounty', 'PingtungCounty']),
  Object.freeze(['Taichung']),
  Object.freeze(['Kaohsiung', 'YunlinCounty']),
])

const OPERATIONS_PLAN = loadOperationsPlan()
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
const SUPPORTED_CITY_WEEKDAY = new Map(SNAPSHOT_SUPPORTED_CITIES_BY_TAIPEI_WEEKDAY.flatMap((cities, weekday) =>
  cities.map((city) => [city, weekday])))

export function scopeSnapshotSchedule(schedule, enabledCities) {
  if (!Array.isArray(schedule) || schedule.length !== 7) {
    throw new Error('Snapshot schedule must contain exactly seven Taipei weekdays')
  }
  const scheduledCities = schedule.flat()
  const scheduledCitySet = new Set(scheduledCities)
  if (scheduledCitySet.size !== scheduledCities.length) {
    throw new Error('Snapshot schedule must contain each city exactly once')
  }
  const enabledCitySet = new Set(enabledCities)
  if (enabledCitySet.size !== enabledCities.length) {
    throw new Error('Enabled snapshot cities must be unique')
  }
  for (const city of enabledCities) {
    if (!scheduledCitySet.has(city)) throw new Error(`Enabled city is missing from snapshot schedule: ${city}`)
  }
  return Object.freeze(schedule.map((cities) =>
    Object.freeze(cities.filter((city) => enabledCitySet.has(city)))))
}

export function enabledSnapshotCitiesInScheduleOrder(enabledCities) {
  return Object.freeze(scopeSnapshotSchedule(
    SNAPSHOT_SUPPORTED_CITIES_BY_TAIPEI_WEEKDAY,
    enabledCities,
  ).flat())
}

export function snapshotCitiesByTaipeiWeekday(plan = OPERATIONS_PLAN) {
  const weekly = scopeSnapshotSchedule(
    SNAPSHOT_SUPPORTED_CITIES_BY_TAIPEI_WEEKDAY,
    plan.enabledCities,
  )
  if (plan.snapshotSchedule === 'taipei-weekly-sharded') return weekly
  if (plan.snapshotSchedule === 'manual') {
    return Object.freeze(Array.from({ length: 7 }, () => Object.freeze([])))
  }
  if (plan.snapshotSchedule === 'daily') {
    const cities = enabledSnapshotCitiesInScheduleOrder(plan.enabledCities)
    return Object.freeze(Array.from({ length: 7 }, () => Object.freeze([...cities])))
  }
  throw new Error(`Unsupported snapshot schedule mode: ${plan.snapshotSchedule}`)
}

export const SNAPSHOT_CITIES_BY_TAIPEI_WEEKDAY = snapshotCitiesByTaipeiWeekday()

export function scheduledCitiesForTaipeiDate(scheduleDate, plan = OPERATIONS_PLAN) {
  const date = validDateOnly(scheduleDate)
  return snapshotCitiesByTaipeiWeekday(plan)[new Date(`${date}T00:00:00.000Z`).getUTCDay()]
}

export function scheduledSnapshotWindow(city, scheduleDate, plan = OPERATIONS_PLAN) {
  assertScheduledCity(city, plan)
  const date = validDateOnly(scheduleDate)
  if (!scheduledCitiesForTaipeiDate(date, plan).includes(city)) throw new Error('City is not scheduled for this date')
  return Object.freeze({
    windowId: `v1:${city}:${date}:0317`,
    scheduledAt: taipeiLocalTimeAsUtc(date, SNAPSHOT_SCHEDULE_HOUR, SNAPSHOT_SCHEDULE_MINUTE).toISOString(),
    runKind: 'scheduled',
  })
}

export function latestScheduledTaipeiDate(city, now = new Date(), plan = OPERATIONS_PLAN) {
  assertScheduledCity(city, plan)
  const local = new Date(validDate(now).getTime() + TAIPEI_OFFSET_MS)
  const beforeSlot = local.getUTCHours() < SNAPSHOT_SCHEDULE_HOUR
    || (local.getUTCHours() === SNAPSHOT_SCHEDULE_HOUR && local.getUTCMinutes() < SNAPSHOT_SCHEDULE_MINUTE)

  if (plan.snapshotSchedule === 'daily') {
    if (beforeSlot) local.setUTCDate(local.getUTCDate() - 1)
    return utcDateParts(local)
  }

  let daysBack = (local.getUTCDay() - SUPPORTED_CITY_WEEKDAY.get(city) + 7) % 7
  if (daysBack === 0 && beforeSlot) daysBack = 7
  local.setUTCDate(local.getUTCDate() - daysBack)
  return utcDateParts(local)
}

export function latestClosedSnapshotScheduleDate(now = new Date()) {
  const local = new Date(validDate(now).getTime() + TAIPEI_OFFSET_MS)
  const beforeClose = local.getUTCHours() < SNAPSHOT_WINDOW_CLOSE_HOUR
    || (local.getUTCHours() === SNAPSHOT_WINDOW_CLOSE_HOUR && local.getUTCMinutes() < SNAPSHOT_WINDOW_CLOSE_MINUTE)
  if (beforeClose) local.setUTCDate(local.getUTCDate() - 1)
  return utcDateParts(local)
}

export function taipeiDate(now = new Date()) {
  return utcDateParts(new Date(validDate(now).getTime() + TAIPEI_OFFSET_MS))
}

export function taipeiLocalTimeAsUtc(date, hour, minute) {
  const safeDate = validDateOnly(date)
  const [year, month, day] = safeDate.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day, hour, minute) - TAIPEI_OFFSET_MS)
}

export function assertScheduledCity(city, plan = OPERATIONS_PLAN) {
  if (plan.snapshotSchedule === 'manual') throw new Error('Scheduled snapshot operations are disabled for this instance')
  if (!plan.enabledCities.includes(city)) throw new Error('Snapshot city is not enabled for scheduled operations')
  if (!SUPPORTED_CITY_WEEKDAY.has(city)) throw new Error('Unsupported snapshot city')
}

export function validDateOnly(value) {
  if (typeof value !== 'string' || !DATE_ONLY.test(value)) throw new Error('Invalid snapshot schedule date')
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime()) || utcDateParts(parsed) !== value) throw new Error('Invalid snapshot schedule date')
  return value
}

function validDate(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error('Invalid timestamp')
  return date
}

function utcDateParts(value) {
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`
}
