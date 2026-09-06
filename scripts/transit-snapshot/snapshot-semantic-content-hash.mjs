import { createHash } from 'node:crypto'

const WEEKDAYS = Object.freeze([
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
])

export function snapshotSemanticContentHash({
  format,
  routes,
  patterns,
  stops,
  places,
  patternStops,
  schedules,
}) {
  if (!Number.isSafeInteger(format) || format <= 0) throw new Error('Snapshot semantic hash format is invalid')
  const payload = {
    format,
    routes: sortedMapValues(routes, routeSemantic, (item) => item.uid),
    patterns: sortedValues(patterns, patternSemantic, (item) => item.id),
    stops: sortedMapValues(stops, stopSemantic, (item) => item.uid),
    places: sortedMapValues(places, placeSemantic, (item) => item.id),
    patternStops: sortedValues(patternStops, patternStopSemantic, patternStopIdentity),
    schedules: sortedScheduleRoutes(schedules),
  }
  return createHash('sha256').update(stableStringify(payload)).digest('hex')
}

function routeSemantic(route) {
  return {
    uid: textOrNull(route?.uid),
    name: textOrNull(route?.name),
    departure: textOrNull(route?.departure),
    destination: textOrNull(route?.destination),
  }
}

function patternSemantic(pattern) {
  return {
    id: textOrNull(pattern?.id),
    routeUid: textOrNull(pattern?.routeUid),
    subrouteUid: textOrNull(pattern?.subrouteUid),
    subrouteName: textOrNull(pattern?.subrouteName),
    direction: numberOrNull(pattern?.direction),
    departure: textOrNull(pattern?.departure),
    destination: textOrNull(pattern?.destination),
    coordinates: Array.isArray(pattern?.shapeFeature?.geometry?.coordinates)
      ? pattern.shapeFeature.geometry.coordinates
      : null,
  }
}

function stopSemantic(stop) {
  return {
    uid: textOrNull(stop?.uid),
    name: textOrNull(stop?.name),
    normalized: textOrNull(stop?.normalized),
    lat: numberOrNull(stop?.lat),
    lon: numberOrNull(stop?.lon),
    placeId: textOrNull(stop?.placeId),
  }
}

function placeSemantic(place) {
  return {
    id: textOrNull(place?.id),
    name: textOrNull(place?.name),
    normalized: textOrNull(place?.normalized),
    lat: numberOrNull(place?.lat),
    lon: numberOrNull(place?.lon),
  }
}

function patternStopSemantic(item) {
  return {
    patternId: textOrNull(item?.patternId),
    stopUid: textOrNull(item?.stopUid),
    placeId: textOrNull(item?.placeId),
    sequence: numberOrNull(item?.sequence),
  }
}

function patternStopIdentity(item) {
  return [item.patternId, item.sequence, item.stopUid, item.placeId].map((value) => String(value ?? '')).join('\0')
}

function sortedScheduleRoutes(schedules) {
  if (!(schedules instanceof Map)) throw new Error('Snapshot semantic hash schedules must be a Map')
  return [...schedules.entries()]
    .map(([routeUid, items]) => ({
      routeUid: String(routeUid),
      items: sortedValues(Array.isArray(items) ? items : [], scheduleSemantic),
    }))
    .sort((left, right) => left.routeUid.localeCompare(right.routeUid))
}

function scheduleSemantic(schedule) {
  return {
    SubRouteUID: textOrNull(schedule?.SubRouteUID),
    Direction: numberOrNull(schedule?.Direction),
    Timetables: sortedValues(schedule?.Timetables ?? [], timetableSemantic),
    Frequencys: sortedValues(schedule?.Frequencys ?? [], frequencySemantic),
  }
}

function timetableSemantic(timetable) {
  return {
    ServiceDay: serviceDaySemantic(timetable?.ServiceDay),
    StopTimes: sortedValues(timetable?.StopTimes ?? [], stopTimeSemantic, stopTimeIdentity),
  }
}

function stopTimeSemantic(stopTime) {
  return {
    StopUID: textOrNull(stopTime?.StopUID),
    StopSequence: numberOrNull(stopTime?.StopSequence),
    ArrivalTime: textOrNull(stopTime?.ArrivalTime),
    DepartureTime: textOrNull(stopTime?.DepartureTime),
  }
}

function stopTimeIdentity(item) {
  return [item.StopSequence, item.StopUID, item.ArrivalTime, item.DepartureTime]
    .map((value) => String(value ?? '')).join('\0')
}

function frequencySemantic(frequency) {
  return {
    StartTime: textOrNull(frequency?.StartTime),
    EndTime: textOrNull(frequency?.EndTime),
    MinHeadwayMins: numberOrNull(frequency?.MinHeadwayMins),
    MaxHeadwayMins: numberOrNull(frequency?.MaxHeadwayMins),
    ServiceDay: serviceDaySemantic(frequency?.ServiceDay),
  }
}

function serviceDaySemantic(serviceDay) {
  return Object.fromEntries(WEEKDAYS.map((day) => [day, numberOrNull(serviceDay?.[day])]))
}

function sortedMapValues(value, project, identity) {
  if (!(value instanceof Map)) throw new Error('Snapshot semantic hash collection must be a Map')
  return [...value.values()].map(project).sort((left, right) => compareProjected(left, right, identity))
}

function sortedValues(value, project, identity) {
  if (!Array.isArray(value)) return []
  return value.map(project).sort((left, right) => compareProjected(left, right, identity))
}

function compareProjected(left, right, identity) {
  const leftKey = identity ? identity(left) : stableStringify(left)
  const rightKey = identity ? identity(right) : stableStringify(right)
  return leftKey.localeCompare(rightKey)
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value))
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]))
  }
  return value
}

function textOrNull(value) {
  return typeof value === 'string' ? value : null
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
