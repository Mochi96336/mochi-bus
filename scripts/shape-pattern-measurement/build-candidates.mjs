import { contentHash, stableStringify } from './util.mjs'

const SUPPORTED_DIRECTIONS = new Set([0, 1, 2])

export function buildCandidatePartitions(rawBundle) {
  const partitions = new Map()
  const rejected = []
  const sources = Array.isArray(rawBundle?.sources) ? [...rawBundle.sources] : []
  for (const source of sources.sort(compareSource)) {
    const sourceScope = source?.scope === 'intercity' ? 'intercity' : 'city'
    const city = sourceScope === 'city' && nonEmptyText(source?.city) ? source.city.trim() : null
    for (const item of normalizeRecords(source?.stopOfRoute)) {
      const record = buildPatternRecord(item, sourceScope, city)
      if (record.reason) {
        rejected.push(rejection(record))
      } else {
        partitionFor(partitions, sourceScope, city, record.routeUid, record.direction).patternRecords.push(record)
      }
    }
    for (const item of normalizeRecords(source?.shapes)) {
      const record = buildShapeRecord(item, sourceScope, city)
      if (record.reason) {
        rejected.push(rejection(record))
      } else {
        partitionFor(partitions, sourceScope, city, record.routeUid, record.direction).shapeRecords.push(record)
      }
    }
  }

  const result = [...partitions.values()].map(finalizePartition).sort(comparePartition)
  return {
    partitions: result,
    rejected: rejected.sort(compareRejected),
    rejectionCounts: countBy(rejected, (entry) => `${entry.kind}:${entry.reason}`),
  }
}

function buildPatternRecord(item, sourceScope, city) {
  const routeUid = strictIdentity(item, 'RouteUID')
  const direction = strictDirection(item?.Direction)
  const subRouteUid = optionalIdentity(item, 'SubRouteUID')
  const orderedStops = buildOrderedStops(item?.Stops)
  const normalized = {
    routeUid: routeUid.value,
    direction: direction.value,
    subRouteUid: subRouteUid.value,
    stops: orderedStops.value,
  }
  const sourceHash = contentHash({ sourceScope, city, normalized })
  const reason = routeUid.reason ?? direction.reason ?? subRouteUid.reason ?? orderedStops.reason
  return {
    kind: 'pattern', sourceScope, city, routeUid: routeUid.value,
    direction: direction.value, subRouteUid: subRouteUid.value,
    sourceHash, sortKey: stableStringify(normalized), reason,
    makeCandidate: (ordinal) => ({
      patternId: `${scopePrefix(sourceScope, city)}:pattern:${sourceHash.slice(0, 20)}:${ordinal}`,
      routeUid: routeUid.value,
      subRouteUid: subRouteUid.value,
      direction: direction.value,
      stops: orderedStops.value,
    }),
  }
}

function buildShapeRecord(item, sourceScope, city) {
  const routeUid = strictIdentity(item, 'RouteUID')
  const direction = strictDirection(item?.Direction)
  const subRouteUid = optionalIdentity(item, 'SubRouteUID')
  const decoded = extractShapeCoordinates(item)
  const normalized = {
    routeUid: routeUid.value,
    direction: direction.value,
    subRouteUid: subRouteUid.value,
    coordinates: decoded.coordinates,
  }
  const sourceHash = contentHash({ sourceScope, city, normalized })
  const reason = routeUid.reason ?? direction.reason ?? subRouteUid.reason ?? decoded.failure
  return {
    kind: 'shape', sourceScope, city, routeUid: routeUid.value,
    direction: direction.value, subRouteUid: subRouteUid.value,
    sourceHash, sortKey: stableStringify(normalized), reason,
    makeCandidate: (ordinal) => ({
      shapeId: `${scopePrefix(sourceScope, city)}:shape:${sourceHash.slice(0, 20)}:${ordinal}`,
      routeUid: routeUid.value,
      subRouteUid: subRouteUid.value,
      direction: direction.value,
      coordinates: decoded.coordinates,
      measurement: {
        rawCoordinateCount: decoded.rawCoordinateCount,
        updateTime: optionalText(item?.UpdateTime),
      },
    }),
  }
}

function buildOrderedStops(value) {
  if (!Array.isArray(value) || value.length === 0) return invalid('missing-stops', [])
  const records = []
  const sequences = new Set()
  for (let index = 0; index < value.length; index += 1) {
    const stop = value[index]
    const sequence = stop?.StopSequence
    if (!Number.isSafeInteger(sequence)) return invalid('invalid-stop-sequence', [])
    if (sequence <= 0) return invalid('non-positive-stop-sequence', [])
    if (sequences.has(sequence)) return invalid('duplicate-stop-sequence', [])
    sequences.add(sequence)
    const coordinate = strictCoordinate(
      stop?.StopPosition?.PositionLon,
      stop?.StopPosition?.PositionLat,
    )
    if (!coordinate) return invalid('invalid-stop-coordinate', [])
    const stopUid = optionalIdentity(stop, 'StopUID')
    if (stopUid.reason) return invalid('invalid-stop-uid', [])
    records.push({
      sequence,
      originalIndex: index,
      stopUid: stopUid.value ?? undefined,
      coordinate,
    })
  }
  records.sort((a, b) => a.sequence - b.sequence || a.originalIndex - b.originalIndex)
  return valid(records.map(({ stopUid, coordinate }) => ({ stopUid, coordinate })))
}

export function extractShapeCoordinates(item) {
  const direct = item?.Coordinates ?? item?.Geometry?.Coordinates ?? item?.Shape?.Coordinates
  if (Array.isArray(direct)) {
    if (direct.length < 2) return { coordinates: [], rawCoordinateCount: direct.length, failure: 'invalid-coordinates' }
    const coordinates = []
    for (const point of direct) {
      if (!Array.isArray(point) || point.length < 2) {
        return { coordinates: [], rawCoordinateCount: direct.length, failure: 'invalid-coordinates' }
      }
      const coordinate = strictCoordinate(point[0], point[1])
      if (!coordinate) return { coordinates: [], rawCoordinateCount: direct.length, failure: 'invalid-coordinates' }
      coordinates.push(coordinate)
    }
    return { coordinates, rawCoordinateCount: direct.length, failure: null }
  }
  if (typeof item?.EncodedPolyline === 'string' && item.EncodedPolyline.length > 0) {
    try {
      const coordinates = decodePolyline(item.EncodedPolyline)
      if (coordinates.length < 2 || coordinates.some((point) => !strictCoordinate(point[0], point[1]))) {
        return { coordinates: [], rawCoordinateCount: coordinates.length, failure: 'invalid-encoded-polyline' }
      }
      return { coordinates, rawCoordinateCount: coordinates.length, failure: null }
    } catch {
      return { coordinates: [], rawCoordinateCount: 0, failure: 'invalid-encoded-polyline' }
    }
  }
  return { coordinates: [], rawCoordinateCount: 0, failure: 'missing-coordinates' }
}

export function decodePolyline(encoded) {
  let index = 0
  let latitude = 0
  let longitude = 0
  const coordinates = []
  while (index < encoded.length) {
    const lat = decodeComponent(encoded, index)
    index = lat.next
    const lon = decodeComponent(encoded, index)
    index = lon.next
    latitude += lat.delta
    longitude += lon.delta
    const coordinate = [longitude / 1e5, latitude / 1e5]
    if (!strictCoordinate(coordinate[0], coordinate[1])) throw new Error('polyline coordinate out of range')
    coordinates.push(coordinate)
  }
  return coordinates
}

function decodeComponent(encoded, start) {
  let index = start
  let result = 0
  let shift = 0
  while (index < encoded.length) {
    const value = encoded.charCodeAt(index) - 63
    if (value < 0 || value > 63) throw new Error('invalid polyline character')
    index += 1
    result |= (value & 0x1f) << shift
    shift += 5
    if (value < 0x20) {
      return { delta: (result & 1) ? ~(result >> 1) : (result >> 1), next: index }
    }
    if (shift > 30) throw new Error('polyline component overflow')
  }
  throw new Error('truncated polyline')
}

function finalizePartition(partition) {
  const patterns = materializeRecords(partition.patternRecords, 'pattern')
  const shapes = materializeRecords(partition.shapeRecords, 'shape')
  const patternIdentities = identityCounts(patterns)
  const shapeIdentities = identityCounts(shapes)
  const duplicateIdentityCount = [...patternIdentities.values(), ...shapeIdentities.values()]
    .reduce((sum, count) => sum + Math.max(0, count - 1), 0)
  const completePatternIdentities = new Set([...patternIdentities.keys()].filter(Boolean))
  const completeShapeIdentities = new Set([...shapeIdentities.keys()].filter(Boolean))
  const contradictoryIdentityCount = [...completePatternIdentities]
    .filter((identity) => completeShapeIdentities.size > 0 && !completeShapeIdentities.has(identity)).length
  return {
    key: partition.key,
    sourceScope: partition.sourceScope,
    city: partition.city,
    routeUid: partition.routeUid,
    direction: partition.direction,
    patterns,
    shapes,
    partitionId: contentHash({
      sourceScope: partition.sourceScope, city: partition.city,
      routeUid: partition.routeUid, direction: partition.direction,
    }).slice(0, 24),
    stats: {
      patternCount: patterns.length,
      shapeCount: shapes.length,
      minSideCount: Math.min(patterns.length, shapes.length),
      completeIdentityCount: [...patternIdentities.keys()].filter(Boolean).length
        + [...shapeIdentities.keys()].filter(Boolean).length,
      duplicateIdentityCount,
      contradictoryIdentityCount,
      candidateMultiplicity: patterns.length * shapes.length,
    },
  }
}

function materializeRecords(records) {
  const ordered = [...records].sort((a, b) => a.sortKey.localeCompare(b.sortKey) || a.sourceHash.localeCompare(b.sourceHash))
  const counts = new Map()
  return ordered.map((record) => {
    const ordinal = (counts.get(record.sourceHash) ?? 0) + 1
    counts.set(record.sourceHash, ordinal)
    return record.makeCandidate(ordinal)
  })
}

function partitionFor(partitions, sourceScope, city, routeUid, direction) {
  const key = `${sourceScope}\0${city ?? ''}\0${routeUid}\0${direction}`
  let partition = partitions.get(key)
  if (!partition) {
    partition = { key, sourceScope, city, routeUid, direction, patternRecords: [], shapeRecords: [] }
    partitions.set(key, partition)
  }
  return partition
}

function strictDirection(value) {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && SUPPORTED_DIRECTIONS.has(value)
    ? valid(value)
    : invalid('unsupported-direction', null)
}

function strictCoordinate(longitude, latitude) {
  if (typeof longitude !== 'number' || typeof latitude !== 'number') return null
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null
  if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) return null
  return [longitude, latitude]
}

function strictIdentity(object, key) {
  if (!object || !Object.prototype.hasOwnProperty.call(object, key)) return invalid(`missing-${camelToKebab(key)}`, '')
  const value = object[key]
  if (typeof value !== 'string') return invalid(`invalid-${camelToKebab(key)}`, '')
  const normalized = value.trim()
  return normalized ? valid(normalized) : invalid(`empty-${camelToKebab(key)}`, '')
}

function optionalIdentity(object, key) {
  if (!object || !Object.prototype.hasOwnProperty.call(object, key) || object[key] === null) return valid(null)
  if (typeof object[key] !== 'string') return invalid(`invalid-${camelToKebab(key)}`, null)
  const normalized = object[key].trim()
  return normalized ? valid(normalized) : invalid(`empty-${camelToKebab(key)}`, null)
}

function nonEmptyText(value) { return typeof value === 'string' && value.trim().length > 0 }
function optionalText(value) { return nonEmptyText(value) ? value.trim() : null }
function normalizeRecords(value) { return Array.isArray(value) ? value : [] }
function valid(value) { return { value, reason: null } }
function invalid(reason, value) { return { value, reason } }
function rejection(record) {
  return {
    kind: record.kind,
    sourceScope: record.sourceScope,
    city: record.city,
    reason: record.reason,
    sourceHash: record.sourceHash,
  }
}
function scopePrefix(scope, city) { return scope === 'intercity' ? 'intercity' : `city-${city}` }
function identityCounts(candidates) {
  const counts = new Map()
  for (const candidate of candidates) {
    const identity = candidate.subRouteUid ? `${candidate.routeUid}\0${candidate.direction}\0${candidate.subRouteUid}` : ''
    counts.set(identity, (counts.get(identity) ?? 0) + 1)
  }
  return counts
}
function countBy(records, selector) {
  const result = {}
  for (const record of records) {
    const key = selector(record)
    result[key] = (result[key] ?? 0) + 1
  }
  return Object.fromEntries(Object.entries(result).sort())
}
function camelToKebab(value) { return value.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase() }
function compareSource(a, b) { return `${a?.scope ?? ''}\0${a?.city ?? ''}`.localeCompare(`${b?.scope ?? ''}\0${b?.city ?? ''}`) }
function comparePartition(a, b) { return a.key.localeCompare(b.key) }
function compareRejected(a, b) { return stableStringify(a).localeCompare(stableStringify(b)) }
