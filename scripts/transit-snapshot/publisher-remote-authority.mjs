import {
  MAX_ROUTING_MANIFEST_BYTES,
  parseJsonArtifactBytes,
  parseRoutingAuthorityManifests,
  routingCompletionManifestKeys,
  routingManifestObservations,
  routingManifestRootBinding,
} from './routing-authority-contract.mjs'

const HIGH_CARD_COUNT_FIELDS = Object.freeze(['patterns', 'patternStops', 'places', 'stops'])

export function validatePublisherRemoteRoutingAuthority({
  city,
  version,
  expectedCounts,
  rootArtifacts,
  manifestBodies,
}) {
  const keys = routingCompletionManifestKeys(version, city)
  if (!Array.isArray(manifestBodies) || manifestBodies.length !== keys.length) {
    throw new Error('Publisher routing authority is incomplete')
  }
  const byKey = new Map(Array.isArray(rootArtifacts)
    ? rootArtifacts.map((artifact) => [artifact?.key, artifact]) : [])
  const values = keys.map((key, index) => {
    const descriptor = byKey.get(key)
    if (!descriptor || !Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 1
      || descriptor.bytes > MAX_ROUTING_MANIFEST_BYTES) {
      throw new Error('Publisher routing authority descriptor is invalid')
    }
    return parseJsonArtifactBytes(manifestBodies[index], descriptor)
  })
  const authority = parseRoutingAuthorityManifests(values, city, version)
  const observations = routingManifestObservations(keys, manifestBodies)
  if (routingManifestRootBinding(rootArtifacts, observations) !== 'root-bound') {
    throw new Error('Publisher routing authority is not root-bound')
  }

  for (const field of HIGH_CARD_COUNT_FIELDS) {
    if (!expectedCounts || authority.counts[field] !== expectedCounts[field]) {
      throw new Error(`Remote R2 ${field} count mismatch`)
    }
  }

  // The root manifest already lists every staged artifact. Bind every pattern
  // artifact descriptor carried by the completion proof back to that same root
  // so the high-cardinality route evidence cannot point at a different object.
  for (const entry of authority.patternEntries) {
    const root = byKey.get(entry.key)
    if (Number(root?.bytes) !== entry.bytes || root?.sha256 !== entry.sha256) {
      throw new Error('Root manifest pattern artifact fingerprint mismatch')
    }
  }
  const sampleArtifact = [...authority.patternEntries]
    .sort((left, right) => left.patternId.localeCompare(right.patternId))[0]
  if (!sampleArtifact) throw new Error('Publisher routing sample is unavailable')

  return Object.freeze({
    counts: authority.counts,
    sampleArtifact,
  })
}
