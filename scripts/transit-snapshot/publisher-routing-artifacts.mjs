import { createHash } from 'node:crypto'
import {
  buildPatternStopArtifact,
  patternStopArtifactKey,
  patternStopExportManifestKey,
} from './export-pattern-stops.mjs'
import {
  buildPlaceRoutingArtifacts,
  isCircularRouteShape,
  placeRoutingExportManifestKey,
} from './export-place-routing.mjs'
import {
  buildTransferRoutingShards,
  DEFAULT_TRANSFER_SHARD_COUNT,
  transferRoutingExportManifestKey,
} from './export-transfer-routing.mjs'
import {
  buildStopLookupShards,
  DEFAULT_STOP_LOOKUP_SHARD_COUNT,
  stopLookupExportManifestKey,
} from './export-stop-lookup.mjs'

const JSON_CONTENT_TYPE = 'application/json'

export function routingCompletionManifestKeys(version, city) {
  return Object.freeze([
    patternStopExportManifestKey(version, city),
    placeRoutingExportManifestKey(version, city),
    transferRoutingExportManifestKey(version, city),
    stopLookupExportManifestKey(version, city),
  ])
}

export function buildPublisherRoutingArtifacts({
  city,
  version,
  routes,
  patterns,
  stops,
  places,
  patternStops,
  generatedAt = new Date().toISOString(),
}) {
  if (!city || !version) throw new Error('Publisher routing artifact metadata is required')
  if (!(routes instanceof Map) || routes.size === 0) throw new Error('Publisher route metadata is required')
  if (!Array.isArray(patterns) || patterns.length === 0) throw new Error('Publisher pattern metadata is required')
  if (!(stops instanceof Map) || stops.size === 0) throw new Error('Publisher stop metadata is required')
  if (!(places instanceof Map) || places.size === 0) throw new Error('Publisher place metadata is required')
  if (!Array.isArray(patternStops) || patternStops.length === 0) throw new Error('Publisher pattern stops are required')

  const patternById = new Map()
  for (const pattern of patterns) {
    if (!pattern?.id || patternById.has(pattern.id)) {
      throw new Error(`Duplicate or invalid publisher pattern ${pattern?.id ?? 'unknown'}`)
    }
    if (!routes.has(pattern.routeUid)) throw new Error(`Publisher pattern ${pattern.id} has no route metadata`)
    patternById.set(pattern.id, pattern)
  }

  const groupedRows = new Map([...patternById.keys()].map((patternId) => [patternId, []]))
  for (const item of patternStops) {
    const pattern = patternById.get(item?.patternId)
    const stop = stops.get(item?.stopUid)
    if (!pattern) throw new Error(`Publisher pattern stop references unknown pattern ${item?.patternId ?? 'unknown'}`)
    if (!stop) throw new Error(`Publisher pattern ${pattern.id} references unknown stop ${item?.stopUid ?? 'unknown'}`)
    if (!item?.placeId || stop.placeId !== item.placeId) {
      throw new Error(`Publisher pattern ${pattern.id} stop ${item?.stopUid ?? 'unknown'} place mismatch`)
    }
    groupedRows.get(pattern.id).push({
      pattern_id: pattern.id,
      stop_uid: item.stopUid,
      place_id: item.placeId,
      stop_sequence: item.sequence,
      stop_name: stop.name,
      latitude: stop.lat,
      longitude: stop.lon,
    })
  }

  const sortedPatterns = [...patterns].sort((left, right) => compareBinary(left.id, right.id))
  const patternArtifacts = []
  const resolvedPatterns = []
  for (const pattern of sortedPatterns) {
    const rows = groupedRows.get(pattern.id)
      .sort((left, right) => Number(left.stop_sequence) - Number(right.stop_sequence))
    const artifact = buildPatternStopArtifact({ city, version, patternId: pattern.id, rows })
    const task = jsonTask({
      key: patternStopArtifactKey(version, city, pattern.id),
      localPath: `routing/pattern-stops/${encodeURIComponent(pattern.id)}.json`,
      value: artifact,
    })
    patternArtifacts.push(Object.freeze({
      patternId: pattern.id,
      key: task.key,
      stops: artifact.stops.length,
      bytes: task.bytes,
      sha256: task.sha256,
      task,
    }))
    resolvedPatterns.push(Object.freeze({
      patternId: pattern.id,
      shapeKey: pattern.shapeKey,
      circular: isCircularRouteShape(pattern.shapeFeature?.geometry?.coordinates),
      artifact,
    }))
  }
  const patternStopCount = patternArtifacts.reduce((sum, item) => sum + item.stops, 0)
  if (patternArtifacts.length !== patterns.length || patternStopCount !== patternStops.length) {
    throw new Error(`Publisher pattern stop parity failed: ${patternArtifacts.length}/${patternStopCount}`)
  }

  const patternManifestKey = patternStopExportManifestKey(version, city)
  const patternManifest = Object.freeze({
    schemaVersion: 1,
    kind: 'pattern-stop-export',
    city,
    version,
    generatedAt,
    patterns: patternArtifacts.length,
    patternStops: patternStopCount,
    artifacts: patternArtifacts.map(({ task: _task, ...entry }) => entry),
  })
  const patternManifestTask = jsonTask({
    key: patternManifestKey,
    localPath: 'routing/manifests/pattern-stops.json',
    value: patternManifest,
  })

  const patternRows = sortedPatterns.map((pattern) => {
    const route = routes.get(pattern.routeUid)
    return {
      pattern_id: pattern.id,
      route_uid: pattern.routeUid,
      route_name: route.name,
      subroute_uid: pattern.subrouteUid,
      subroute_name: pattern.subrouteName,
      direction: pattern.direction,
      departure_name: pattern.departure,
      destination_name: pattern.destination,
      shape_key: pattern.shapeKey,
    }
  })
  const placeRows = [...places.values()]
    .sort((left, right) => compareBinary(left.id, right.id))
    .map((place) => ({
      place_id: place.id,
      place_name: place.name,
      latitude: place.lat,
      longitude: place.lon,
    }))
  const stagedPlaces = buildPlaceRoutingArtifacts({
    city,
    version,
    patterns: patternRows,
    places: placeRows,
    resolvedPatterns,
  })
  if (stagedPlaces.artifacts.length !== places.size || stagedPlaces.occurrences !== patternStops.length) {
    throw new Error(`Publisher place routing parity failed: ${stagedPlaces.artifacts.length}/${stagedPlaces.occurrences}`)
  }
  const placeArtifacts = stagedPlaces.artifacts.map((item) => {
    const task = jsonTask({
      key: item.key,
      localPath: `routing/places/${encodeURIComponent(item.placeId)}.json`,
      value: item.artifact,
    })
    return Object.freeze({ ...item, task, bytes: task.bytes, sha256: task.sha256 })
  })
  const placeManifestKey = placeRoutingExportManifestKey(version, city)
  const placeManifest = Object.freeze({
    schemaVersion: 1,
    kind: 'place-routing-export',
    city,
    version,
    generatedAt,
    upstreamPatternStopManifest: patternManifestKey,
    places: placeArtifacts.length,
    patterns: patternArtifacts.length,
    occurrences: stagedPlaces.occurrences,
    artifacts: placeArtifacts.map((item) => Object.freeze({
      placeId: item.placeId,
      key: item.key,
      patterns: item.patterns,
      occurrences: item.occurrences,
      bytes: item.bytes,
      sha256: item.sha256,
    })),
  })
  const placeManifestTask = jsonTask({
    key: placeManifestKey,
    localPath: 'routing/manifests/place-routing.json',
    value: placeManifest,
  })

  const placeArtifactValues = placeArtifacts.map((item) => item.artifact)
  const stagedTransfers = buildTransferRoutingShards({ city, version, placeArtifacts: placeArtifactValues })
  if (stagedTransfers.places !== places.size
    || stagedTransfers.patterns !== patterns.length
    || stagedTransfers.occurrences !== patternStops.length) {
    throw new Error(`Publisher transfer routing parity failed: ${stagedTransfers.places}/${stagedTransfers.patterns}/${stagedTransfers.occurrences}`)
  }
  const transferShards = stagedTransfers.shards.map((item) => {
    const task = jsonTask({
      key: item.key,
      localPath: `routing/transfer-shards/${String(item.shard).padStart(2, '0')}.json`,
      value: item.artifact,
    })
    return Object.freeze({ ...item, task, bytes: task.bytes, sha256: task.sha256 })
  })
  const transferManifestKey = transferRoutingExportManifestKey(version, city)
  const transferManifest = Object.freeze({
    schemaVersion: 1,
    kind: 'transfer-routing-export',
    city,
    version,
    generatedAt,
    upstreamPlaceRoutingManifest: placeManifestKey,
    shardCount: DEFAULT_TRANSFER_SHARD_COUNT,
    places: stagedTransfers.places,
    patterns: stagedTransfers.patterns,
    occurrences: stagedTransfers.occurrences,
    patternShards: stagedTransfers.patternShards,
    shards: transferShards.map((item) => Object.freeze({
      shard: item.shard,
      key: item.key,
      patterns: item.patterns,
      occurrences: item.occurrences,
      bytes: item.bytes,
      sha256: item.sha256,
    })),
  })
  const transferManifestTask = jsonTask({
    key: transferManifestKey,
    localPath: 'routing/manifests/transfer-routing.json',
    value: transferManifest,
  })

  const stagedStops = buildStopLookupShards({ city, version, placeArtifacts: placeArtifactValues })
  if (stagedStops.places !== places.size || stagedStops.occurrences !== patternStops.length) {
    throw new Error(`Publisher stop lookup parity failed: ${stagedStops.places}/${stagedStops.occurrences}`)
  }
  const stopShards = stagedStops.shards.map((item) => {
    const task = jsonTask({
      key: item.key,
      localPath: `routing/stop-shards/${String(item.shard).padStart(2, '0')}.json`,
      value: item.artifact,
    })
    return Object.freeze({ ...item, task, bytes: task.bytes, sha256: task.sha256 })
  })
  const stopManifestKey = stopLookupExportManifestKey(version, city)
  const stopManifest = Object.freeze({
    schemaVersion: 1,
    kind: 'stop-lookup-export',
    city,
    version,
    generatedAt,
    upstreamPlaceRoutingManifest: placeManifestKey,
    shardCount: DEFAULT_STOP_LOOKUP_SHARD_COUNT,
    places: stagedStops.places,
    stops: stagedStops.stops,
    occurrences: stagedStops.occurrences,
    shards: stopShards.map((item) => Object.freeze({
      shard: item.shard,
      key: item.key,
      stops: item.stops,
      bytes: item.bytes,
      sha256: item.sha256,
    })),
  })
  const stopManifestTask = jsonTask({
    key: stopManifestKey,
    localPath: 'routing/manifests/stop-lookup.json',
    value: stopManifest,
  })

  const tasks = [
    ...patternArtifacts.map((item) => item.task),
    ...placeArtifacts.map((item) => item.task),
    ...transferShards.map((item) => item.task),
    ...stopShards.map((item) => item.task),
    patternManifestTask,
    placeManifestTask,
    transferManifestTask,
    stopManifestTask,
  ]
  if (new Set(tasks.map((task) => task.key)).size !== tasks.length) {
    throw new Error('Publisher routing artifact keys are not unique')
  }

  return Object.freeze({
    tasks,
    completionManifestKeys: routingCompletionManifestKeys(version, city),
    counts: Object.freeze({
      patterns: patternArtifacts.length,
      patternStops: patternStopCount,
      places: placeArtifacts.length,
      transferShards: transferShards.length,
      stopLookupShards: stopShards.length,
      stops: stagedStops.stops,
    }),
  })
}

export function routingArtifactCleanupKeys({ city, versions, patterns = [], places = [] }) {
  if (!city || !(versions instanceof Set)) throw new Error('Routing cleanup metadata is required')
  const keys = []
  for (const row of patterns) {
    if (versions.has(row.version) && row.pattern_id) {
      keys.push(patternStopArtifactKey(row.version, city, row.pattern_id))
    }
  }
  for (const row of places) {
    if (versions.has(row.version) && row.place_id) {
      keys.push(`snapshots/${row.version}/cities/${city}/routing/places/${row.place_id}.json`)
    }
  }
  for (const oldVersion of versions) {
    for (let shard = 0; shard < DEFAULT_TRANSFER_SHARD_COUNT; shard += 1) {
      keys.push(`snapshots/${oldVersion}/cities/${city}/routing/transfers/shards/${String(shard).padStart(2, '0')}.json`)
    }
    for (let shard = 0; shard < DEFAULT_STOP_LOOKUP_SHARD_COUNT; shard += 1) {
      keys.push(`snapshots/${oldVersion}/cities/${city}/routing/stops/shards/${String(shard).padStart(2, '0')}.json`)
    }
    keys.push(...routingCompletionManifestKeys(oldVersion, city))
  }
  return Object.freeze([...new Set(keys)])
}

function jsonTask({ key, localPath, value }) {
  const body = JSON.stringify(value)
  return Object.freeze({
    key,
    localPath,
    body,
    bytes: Buffer.byteLength(body),
    sha256: createHash('sha256').update(body).digest('hex'),
    contentType: JSON_CONTENT_TYPE,
  })
}

function compareBinary(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}
