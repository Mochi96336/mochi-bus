import { extractShapeCoordinates } from './build-candidates.mjs'
import { contentHash } from './util.mjs'

const SUPPORTED_DIRECTIONS = new Set([0, 1, 2])

export function buildAmbiguityCandidateNameIndex(rawBundle) {
  const namesByCandidatePrefix = new Map()
  for (const source of Array.isArray(rawBundle?.sources) ? rawBundle.sources : []) {
    const sourceScope = source?.scope === 'intercity' ? 'intercity' : 'city'
    const city = sourceScope === 'city' && nonEmptyText(source?.city) ? source.city.trim() : null
    const prefix = sourceScope === 'intercity' ? 'intercity' : `city-${city}`

    for (const item of Array.isArray(source?.stopOfRoute) ? source.stopOfRoute : []) {
      const normalized = normalizePattern(item)
      if (!normalized) continue
      addCandidateName(
        namesByCandidatePrefix,
        `${prefix}:pattern:${contentHash({ sourceScope, city, normalized }).slice(0, 20)}`,
        localizedName(item?.SubRouteName),
      )
    }

    for (const item of Array.isArray(source?.shapes) ? source.shapes : []) {
      const normalized = normalizeShape(item)
      if (!normalized) continue
      addCandidateName(
        namesByCandidatePrefix,
        `${prefix}:shape:${contentHash({ sourceScope, city, normalized }).slice(0, 20)}`,
        localizedName(item?.SubRouteName),
      )
    }
  }
  return namesByCandidatePrefix
}

export function enrichAmbiguityViewerCandidateNames(report, namesByCandidatePrefix) {
  for (const partition of Array.isArray(report?.partitions) ? report.partitions : []) {
    for (const pattern of Array.isArray(partition?.patterns) ? partition.patterns : []) {
      applyCandidateNames(pattern, namesByCandidatePrefix)
    }
    for (const shape of Array.isArray(partition?.shapes) ? partition.shapes : []) {
      applyCandidateNames(shape, namesByCandidatePrefix)
    }
  }
  return report
}

function applyCandidateNames(candidate, index) {
  const candidateId = candidate?.patternId ?? candidate?.shapeId
  if (typeof candidateId !== 'string') return
  const names = [...(index.get(candidateId.replace(/:\d+$/, '')) ?? [])]
    .sort((a, b) => a.localeCompare(b, 'zh-Hant'))
  if (!names.length) return
  candidate.subRouteName = names.join('／')
  candidate.subRouteNameAlternatives = names
  candidate.subRouteNameConflict = names.length > 1
}

function addCandidateName(index, candidatePrefix, name) {
  if (!name) return
  let names = index.get(candidatePrefix)
  if (!names) {
    names = new Set()
    index.set(candidatePrefix, names)
  }
  names.add(name)
}

function normalizePattern(item) {
  const routeUid = requiredIdentity(item, 'RouteUID')
  const direction = strictDirection(item?.Direction)
  const subRouteUid = optionalIdentity(item, 'SubRouteUID')
  const stops = normalizeStops(item?.Stops)
  if (routeUid === null || direction === null || subRouteUid.invalid || stops === null) return null
  return { routeUid, direction, subRouteUid: subRouteUid.value, stops }
}

function normalizeShape(item) {
  const routeUid = requiredIdentity(item, 'RouteUID')
  const direction = strictDirection(item?.Direction)
  const subRouteUid = optionalIdentity(item, 'SubRouteUID')
  const decoded = extractShapeCoordinates(item)
  if (routeUid === null || direction === null || subRouteUid.invalid || decoded.failure) return null
  return { routeUid, direction, subRouteUid: subRouteUid.value, coordinates: decoded.coordinates }
}

function normalizeStops(value) {
  if (!Array.isArray(value) || value.length === 0) return null
  const records = []
  const sequences = new Set()
  for (let originalIndex = 0; originalIndex < value.length; originalIndex += 1) {
    const stop = value[originalIndex]
    const sequence = stop?.StopSequence
    if (!Number.isSafeInteger(sequence) || sequence <= 0 || sequences.has(sequence)) return null
    sequences.add(sequence)
    const coordinate = strictCoordinate(
      stop?.StopPosition?.PositionLon,
      stop?.StopPosition?.PositionLat,
    )
    const stopUid = optionalIdentity(stop, 'StopUID')
    if (!coordinate || stopUid.invalid) return null
    records.push({ sequence, originalIndex, stopUid: stopUid.value ?? undefined, coordinate })
  }
  records.sort((a, b) => a.sequence - b.sequence || a.originalIndex - b.originalIndex)
  return records.map(({ stopUid, coordinate }) => ({ stopUid, coordinate }))
}

function requiredIdentity(object, key) {
  if (!object || !Object.prototype.hasOwnProperty.call(object, key)) return null
  const value = object[key]
  if (typeof value !== 'string' || !value.trim()) return null
  return value.trim()
}

function optionalIdentity(object, key) {
  if (!object || !Object.prototype.hasOwnProperty.call(object, key) || object[key] === null) {
    return { value: null, invalid: false }
  }
  if (typeof object[key] !== 'string' || !object[key].trim()) {
    return { value: null, invalid: true }
  }
  return { value: object[key].trim(), invalid: false }
}

function strictDirection(value) {
  return typeof value === 'number'
    && Number.isFinite(value)
    && Number.isInteger(value)
    && SUPPORTED_DIRECTIONS.has(value)
    ? value
    : null
}

function strictCoordinate(longitude, latitude) {
  if (typeof longitude !== 'number' || typeof latitude !== 'number') return null
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null
  if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) return null
  return [longitude, latitude]
}

function localizedName(value) {
  if (nonEmptyText(value)) return value.trim()
  if (!value || typeof value !== 'object') return null
  for (const key of ['Zh_tw', 'ZhTw', 'zh_tw', 'En', 'en']) {
    if (nonEmptyText(value[key])) return value[key].trim()
  }
  return Object.values(value)
    .filter(nonEmptyText)
    .map((entry) => entry.trim())
    .sort((a, b) => a.localeCompare(b, 'zh-Hant'))[0] ?? null
}

function nonEmptyText(value) {
  return typeof value === 'string' && value.trim().length > 0
}
