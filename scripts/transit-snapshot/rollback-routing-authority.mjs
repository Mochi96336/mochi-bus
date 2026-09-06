import {
  MAX_PATTERN_STOP_ARTIFACT_BYTES,
  MAX_ROUTING_MANIFEST_BYTES,
  parseJsonArtifactBytes,
  parsePatternStopArtifact,
  parseRoutingAuthorityManifests,
  routingCompletionManifestKeys,
  routingManifestObservations,
  routingManifestRootBinding,
} from './routing-authority-contract.mjs'

export async function readRollbackRoutingAuthority({ city, version, r2 }) {
  const keys = routingCompletionManifestKeys(version, city)
  const heads = await Promise.all(keys.map((key) => r2.head(key)))
  const present = heads.filter(Boolean).length
  if (present === 0) return Object.freeze({ mode: 'd1' })
  if (present !== keys.length) throw new Error('Snapshot routing authority is incomplete')

  const bodies = await Promise.all(keys.map((key) => r2.getBytes(key, MAX_ROUTING_MANIFEST_BYTES)))
  if (bodies.some((body) => !body)) throw new Error('Snapshot routing authority disappeared during read')
  if (bodies.some((body) => Buffer.from(body).byteLength > MAX_ROUTING_MANIFEST_BYTES)) {
    throw new Error('Snapshot routing authority exceeds read limit')
  }
  if (heads.some((head, index) => head.size !== null && head.size !== undefined
    && Number(head.size) !== Buffer.from(bodies[index]).byteLength)) {
    throw new Error('Snapshot routing authority changed during read')
  }

  const values = bodies.map((body) => JSON.parse(Buffer.from(body).toString('utf8')))
  const authority = parseRoutingAuthorityManifests(values, city, version)
  const sampleEntry = [...authority.patternEntries]
    .sort((left, right) => left.patternId.localeCompare(right.patternId))[0]
  if (!sampleEntry || sampleEntry.bytes > MAX_PATTERN_STOP_ARTIFACT_BYTES) {
    throw new Error('Snapshot routing sample is unavailable')
  }
  const sampleBody = await r2.getBytes(sampleEntry.key, sampleEntry.bytes)
  if (!sampleBody) throw new Error('Snapshot routing sample is unavailable')
  const stops = parsePatternStopArtifact(
    parseJsonArtifactBytes(sampleBody, sampleEntry),
    city,
    version,
    sampleEntry,
  )

  return Object.freeze({
    mode: 'r2',
    counts: authority.counts,
    sample: Object.freeze({ patternId: sampleEntry.patternId, placeId: stops[0].placeId }),
    manifestObservations: routingManifestObservations(keys, bodies),
  })
}

export function bindRollbackRoutingAuthority(manifestArtifacts, authority) {
  if (authority?.mode !== 'r2') return 'legacy-d1'
  return routingManifestRootBinding(manifestArtifacts, authority.manifestObservations)
}
