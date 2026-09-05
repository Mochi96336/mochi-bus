import {
  patternStopArtifactKey,
  patternStopExportManifestKey,
} from './export-pattern-stops.mjs'
import {
  placeRoutingArtifactKey,
  placeRoutingExportManifestKey,
} from './export-place-routing.mjs'
import {
  DEFAULT_TRANSFER_SHARD_COUNT,
  transferRoutingExportManifestKey,
  transferRoutingShardKey,
} from './export-transfer-routing.mjs'
import {
  DEFAULT_STOP_LOOKUP_SHARD_COUNT,
  stopLookupExportManifestKey,
  stopLookupShardKey,
} from './export-stop-lookup.mjs'
import { MAX_MANIFEST_READ_LIMIT } from './manifest-read-limit.mjs'

const MAX_SAFE_BYTES = Number.MAX_SAFE_INTEGER
const SHA256_PLACEHOLDER = 'f'.repeat(64)
const CONTENT_HASH_PLACEHOLDER = 'f'.repeat(64)
const WORKFLOW_RUN_PLACEHOLDER = '9'.repeat(64)

export function publisherManifestBudget({ city, version, routes, patterns, places, counts, quality }) {
  if (!city || !version || !(routes instanceof Map) || !Array.isArray(patterns) || !(places instanceof Map)) {
    throw new Error('Publisher manifest preflight metadata is incomplete')
  }
  const prefix = `snapshots/${version}/cities/${city}`
  const artifacts = []
  const add = (key, contentType = 'application/json') => artifacts.push({
    key,
    bytes: MAX_SAFE_BYTES,
    sha256: SHA256_PLACEHOLDER,
    contentType,
  })

  for (const pattern of patterns) {
    if (!pattern?.id || !pattern?.shapeKey) throw new Error('Publisher manifest preflight pattern identity is incomplete')
    add(pattern.shapeKey, 'application/geo+json')
  }
  for (const routeUid of routes.keys()) add(`${prefix}/schedules/${routeUid}.json`)
  for (const placeId of places.keys()) add(`${prefix}/places/${placeId}.json`)

  for (const pattern of patterns) add(patternStopArtifactKey(version, city, pattern.id))
  for (const placeId of places.keys()) add(placeRoutingArtifactKey(version, city, placeId))
  for (let shard = 0; shard < DEFAULT_TRANSFER_SHARD_COUNT; shard += 1) {
    add(transferRoutingShardKey(version, city, shard))
  }
  for (let shard = 0; shard < DEFAULT_STOP_LOOKUP_SHARD_COUNT; shard += 1) {
    add(stopLookupShardKey(version, city, shard))
  }
  add(patternStopExportManifestKey(version, city))
  add(placeRoutingExportManifestKey(version, city))
  add(transferRoutingExportManifestKey(version, city))
  add(stopLookupExportManifestKey(version, city))
  add(`${prefix}/network.json`)

  // Use deliberately long fixed-width values for fields whose final values are not available
  // until publication. This is an upper bound for the real schemaVersion 2 manifest, not an
  // optimistic estimate. If the bound cannot fit the validator's 16 MiB ceiling, fail before
  // the publisher stages any R2 objects or D1 rows.
  const upperBoundManifest = {
    schemaVersion: 2,
    city,
    version,
    contentHash: CONTENT_HASH_PLACEHOLDER,
    generatedAt: '9999-12-31T23:59:59.999Z',
    source: 'TDX',
    workflowRun: WORKFLOW_RUN_PLACEHOLDER,
    counts,
    quality,
    artifacts,
  }
  const bytes = Buffer.byteLength(JSON.stringify(upperBoundManifest))
  return Object.freeze({ bytes, artifacts: artifacts.length, limit: MAX_MANIFEST_READ_LIMIT })
}

export function assertPublisherManifestBudget(input) {
  const budget = publisherManifestBudget(input)
  if (budget.bytes > budget.limit) {
    throw new Error(`Snapshot manifest preflight exceeds ${budget.limit} bytes (${budget.bytes})`)
  }
  return budget
}
