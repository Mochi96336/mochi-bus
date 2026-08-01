import { operationEnabledCities } from '../instance/operations-plan.mjs'

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

export const SNAPSHOT_CITIES_BY_TAIPEI_WEEKDAY = scopeSnapshotSchedule(
  SNAPSHOT_SUPPORTED_CITIES_BY_TAIPEI_WEEKDAY,
  operationEnabledCities(),
)

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
const CITY_WEEKDAY = new Map(SNAPSHOT_CITIES_BY_TAIPEI_WEEKDAY.flatMap((cities, weekday) =>
  cities.map((city) => [city, weekday])))

export function scheduledCitiesForTaipeiDate(scheduleDate) {
  const date = validDateOnly(scheduleDate)
  return SNAPSHOT_CITIES_BY_TAIPEI_WEEKDAY[new Date(`${date}T00:00:00.000Z`).getUTCDay()]
}

export function scheduledSnapshotWindow(city, scheduleDate) {
  assertScheduledCity(city)
  const date = validDateOnly(scheduleDate)
  if (!scheduledCitiesForTaipeiDate(date).includes(city)) throw new Error('City is not scheduled for this date')
  return Object.freeze({
    windowId: `v1:${city}:${date}:0317`,
    scheduledAt: taipeiLocalTimeAsUtc(date, SNAPSHOT_SCHEDULE_HOUR, SNAPSHOT_SCHEDULE_MINUTE).toISOString(),
    runKind: 'scheduled',
  })
}

export function latestScheduledTaipeiDate(city, now = new Date()) {
  assertScheduledCity(city)
  const local = new Date(validDate(now).getTime() + TAIPEI_OFFSET_MS)
  const beforeSlot = local.getUTCHours() < SNAPSHOT_SCHEDULE_HOUR
    || (local.getUTCHours() === SNAPSHOT_SCHEDULE_HOUR && local.getUTCMinutes() < SNAPSHOT_SCHEDULE_MINUTE)
  let daysBack = (local.getUTCDay() - CITY_WEEKDAY.get(city) + 7) % 7
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

export function assertScheduledCity(city) {
  if (!CITY_WEEKDAY.has(city)) throw new Error('Snapshot city is not enabled for scheduled operations')
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
