import { createHash } from 'node:crypto'

export const MAX_ROUTING_MANIFEST_BYTES = 16 * 1024 * 1024
export const MAX_PATTERN_STOP_ARTIFACT_BYTES = 2 * 1024 * 1024

const SHA256 = /^[a-f0-9]{64}$/

export function routingCompletionManifestKeys(version, city) {
  const prefix = snapshotPrefix(version, city)
  return Object.freeze([
    `${prefix}pattern-stops-export.json`,
    `${prefix}place-routing-export.json`,
    `${prefix}transfer-routing-export.json`,
    `${prefix}stop-lookup-export.json`,
  ])
}

export function parseRoutingAuthorityManifests(values, city, version) {
  if (!Array.isArray(values) || values.length !== 4) throw new Error('Routing manifest set is incomplete')
  const keys = routingCompletionManifestKeys(version, city)
  const [pattern, place, transfer, stop] = values
  exactIdentity(pattern, 'pattern-stop-export', city, version)
  exactIdentity(place, 'place-routing-export', city, version)
  exactIdentity(transfer, 'transfer-routing-export', city, version)
  exactIdentity(stop, 'stop-lookup-export', city, version)

  const patternCount = positiveInteger(pattern.patterns, 'pattern patterns')
  const patternStopCount = positiveInteger(pattern.patternStops, 'pattern occurrences')
  const patternEntries = descriptors(pattern.artifacts, patternCount, 'pattern artifacts', (entry, index) => {
    const patternId = identifier(entry?.patternId, `pattern artifact ${index} id`)
    return Object.freeze({
      patternId,
      key: exactKey(entry?.key, `${snapshotPrefix(version, city)}patterns/${patternId}/stops.json`),
      stops: minimumInteger(entry?.stops, 2, `pattern artifact ${index} stops`),
      ...fingerprint(entry, `pattern artifact ${index}`),
    })
  })
  unique(patternEntries, (entry) => entry.patternId, 'pattern artifact')
  if (sum(patternEntries, 'stops') !== patternStopCount) throw new Error('Pattern occurrence count mismatch')

  if (place.upstreamPatternStopManifest !== keys[0]) throw new Error('Place routing upstream mismatch')
  const placeCount = positiveInteger(place.places, 'place count')
  if (positiveInteger(place.patterns, 'place patterns') !== patternCount
    || positiveInteger(place.occurrences, 'place occurrences') !== patternStopCount) {
    throw new Error('Place routing count mismatch')
  }
  const placeEntries = descriptors(place.artifacts, placeCount, 'place artifacts', (entry, index) => {
    const placeId = identifier(entry?.placeId, `place artifact ${index} id`)
    return Object.freeze({
      placeId,
      key: exactKey(entry?.key, `${snapshotPrefix(version, city)}routing/places/${placeId}.json`),
      patterns: positiveInteger(entry?.patterns, `place artifact ${index} patterns`),
      occurrences: positiveInteger(entry?.occurrences, `place artifact ${index} occurrences`),
      ...fingerprint(entry, `place artifact ${index}`),
    })
  })
  unique(placeEntries, (entry) => entry.placeId, 'place artifact')
  if (sum(placeEntries, 'occurrences') !== patternStopCount) throw new Error('Place occurrence count mismatch')

  if (transfer.upstreamPlaceRoutingManifest !== keys[1]) throw new Error('Transfer routing upstream mismatch')
  if (positiveInteger(transfer.places, 'transfer places') !== placeCount
    || positiveInteger(transfer.patterns, 'transfer patterns') !== patternCount
    || positiveInteger(transfer.occurrences, 'transfer occurrences') !== patternStopCount) {
    throw new Error('Transfer routing count mismatch')
  }
  const transferShardCount = boundedInteger(transfer.shardCount, 1, 32, 'transfer shard count')
  const transferShards = descriptors(transfer.shards, transferShardCount, 'transfer shards', (entry, index) => {
    const shard = boundedInteger(entry?.shard, 0, transferShardCount - 1, `transfer shard ${index}`)
    return Object.freeze({
      shard,
      key: exactKey(entry?.key, `${snapshotPrefix(version, city)}routing/transfers/shards/${padShard(shard)}.json`),
      patterns: nonNegativeInteger(entry?.patterns, `transfer shard ${index} patterns`),
      occurrences: nonNegativeInteger(entry?.occurrences, `transfer shard ${index} occurrences`),
      ...fingerprint(entry, `transfer shard ${index}`),
    })
  })
  unique(transferShards, (entry) => entry.shard, 'transfer shard')
  if (sum(transferShards, 'patterns') !== patternCount
    || sum(transferShards, 'occurrences') !== patternStopCount) throw new Error('Transfer shard count mismatch')
  const patternShards = descriptors(transfer.patternShards, patternCount, 'pattern shard map', (entry, index) => ({
    patternId: identifier(entry?.patternId, `pattern shard ${index} id`),
    shard: boundedInteger(entry?.shard, 0, transferShardCount - 1, `pattern shard ${index}`),
  }))
  unique(patternShards, (entry) => entry.patternId, 'pattern shard')
  const authorityPatternIds = new Set(patternEntries.map((entry) => entry.patternId))
  if (patternShards.some((entry) => !authorityPatternIds.has(entry.patternId))) {
    throw new Error('Transfer pattern shard identity mismatch')
  }

  if (stop.upstreamPlaceRoutingManifest !== keys[1]) throw new Error('Stop lookup upstream mismatch')
  const stopCount = positiveInteger(stop.stops, 'stop count')
  if (positiveInteger(stop.places, 'stop lookup places') !== placeCount
    || positiveInteger(stop.occurrences, 'stop lookup occurrences') !== patternStopCount) {
    throw new Error('Stop lookup count mismatch')
  }
  const stopShardCount = boundedInteger(stop.shardCount, 1, 32, 'stop shard count')
  const stopShards = descriptors(stop.shards, stopShardCount, 'stop shards', (entry, index) => {
    const shard = boundedInteger(entry?.shard, 0, stopShardCount - 1, `stop shard ${index}`)
    return Object.freeze({
      shard,
      key: exactKey(entry?.key, `${snapshotPrefix(version, city)}routing/stops/shards/${padShard(shard)}.json`),
      stops: nonNegativeInteger(entry?.stops, `stop shard ${index} stops`),
      ...fingerprint(entry, `stop shard ${index}`),
    })
  })
  unique(stopShards, (entry) => entry.shard, 'stop shard')
  if (sum(stopShards, 'stops') !== stopCount) throw new Error('Stop shard count mismatch')

  return Object.freeze({
    keys,
    counts: Object.freeze({ patterns: patternCount, patternStops: patternStopCount, places: placeCount, stops: stopCount }),
    patternEntries: Object.freeze(patternEntries),
  })
}

export function parsePatternStopArtifact(value, city, version, descriptor) {
  if (!value || typeof value !== 'object' || value.schemaVersion !== 1
    || value.city !== city || value.version !== version || value.patternId !== descriptor.patternId
    || !Array.isArray(value.stops) || value.stops.length !== descriptor.stops) {
    throw new Error('Pattern stop artifact identity mismatch')
  }
  let previousSequence = -1
  const stops = value.stops.map((raw, index) => {
    if (!raw || typeof raw !== 'object') throw new Error(`Invalid pattern stop ${index}`)
    const stopSequence = nonNegativeInteger(raw.stopSequence, `pattern stop ${index} sequence`)
    if (stopSequence <= previousSequence) throw new Error('Pattern stop sequence is not strictly increasing')
    previousSequence = stopSequence
    const latitude = Number(raw.latitude)
    const longitude = Number(raw.longitude)
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) throw new Error('Pattern stop coordinate is invalid')
    return Object.freeze({
      stopUid: identifier(raw.stopUid, `pattern stop ${index} UID`),
      placeId: identifier(raw.placeId, `pattern stop ${index} place`),
      stopSequence,
      name: identifier(raw.name, `pattern stop ${index} name`),
      latitude,
      longitude,
    })
  })
  return Object.freeze(stops)
}

export function parseJsonArtifactBytes(body, descriptor) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body)
  if (bytes.byteLength !== descriptor?.bytes
    || createHash('sha256').update(bytes).digest('hex') !== descriptor?.sha256) {
    throw new Error('Routing artifact fingerprint mismatch')
  }
  return JSON.parse(bytes.toString('utf8'))
}

export function routingManifestObservations(keys, bodies) {
  if (!Array.isArray(keys) || !Array.isArray(bodies) || keys.length !== 4 || bodies.length !== 4) {
    throw new Error('Routing manifest observations are incomplete')
  }
  return Object.freeze(bodies.map((body, index) => {
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body)
    return Object.freeze({
      key: keys[index],
      bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
  }))
}

export function routingManifestRootBinding(artifacts, observations) {
  const byKey = new Map(Array.isArray(artifacts) ? artifacts.map((entry) => [entry?.key, entry]) : [])
  const bound = observations.filter((entry) => byKey.has(entry.key))
  if (bound.length === 0) return 'legacy-backfill'
  if (bound.length !== observations.length) throw new Error('Root manifest has a partial routing authority binding')
  for (const observed of observations) {
    const expected = byKey.get(observed.key)
    if (Number(expected?.bytes) !== observed.bytes || expected?.sha256 !== observed.sha256) {
      throw new Error('Root manifest routing authority fingerprint mismatch')
    }
  }
  return 'root-bound'
}

function exactIdentity(value, kind, city, version) {
  if (!value || typeof value !== 'object' || value.schemaVersion !== 1
    || value.kind !== kind || value.city !== city || value.version !== version) {
    throw new Error(`Invalid ${kind} identity`)
  }
}

function descriptors(value, expectedLength, name, map) {
  if (!Array.isArray(value) || value.length !== expectedLength) throw new Error(`Invalid ${name}`)
  return value.map(map)
}

function fingerprint(value, name) {
  const bytes = positiveInteger(value?.bytes, `${name} bytes`)
  if (typeof value?.sha256 !== 'string' || !SHA256.test(value.sha256)) throw new Error(`Invalid ${name} SHA-256`)
  return { bytes, sha256: value.sha256 }
}

function unique(values, key, name) {
  if (new Set(values.map(key)).size !== values.length) throw new Error(`Duplicate ${name}`)
}

function exactKey(value, expected) {
  if (value !== expected) throw new Error('Routing artifact key mismatch')
  return value
}

function identifier(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid ${name}`)
  return value
}

function positiveInteger(value, name) {
  return minimumInteger(value, 1, name)
}

function nonNegativeInteger(value, name) {
  return minimumInteger(value, 0, name)
}

function minimumInteger(value, minimum, name) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`Invalid ${name}`)
  return value
}

function boundedInteger(value, minimum, maximum, name) {
  const number = minimumInteger(value, minimum, name)
  if (number > maximum) throw new Error(`Invalid ${name}`)
  return number
}

function sum(values, field) {
  return values.reduce((total, value) => total + value[field], 0)
}

function padShard(value) {
  return String(value).padStart(2, '0')
}

function snapshotPrefix(version, city) {
  return `snapshots/${version}/cities/${city}/`
}
