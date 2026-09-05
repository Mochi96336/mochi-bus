import { createHash } from 'node:crypto'
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

export const SNAPSHOT_PROBE_SCHEMA_VERSION = 1
export const SNAPSHOT_PROBE_CASE_VERSION = 1
export const SNAPSHOT_PROBE_HARD_CHECK_COUNT = 11
export const SNAPSHOT_PROBE_FAILURE_CLASSES = Object.freeze([
  'none',
  'active_pointer_missing',
  'active_pointer_invalid',
  'active_rows_empty',
  'route_without_pattern',
  'routing_authority_read_failed',
  'routing_authority_incomplete',
  'routing_authority_invalid',
  'manifest_missing',
  'manifest_read_failed',
  'manifest_version_mismatch',
  'manifest_count_mismatch',
  'network_missing',
  'network_version_mismatch',
  'public_routes_failed',
  'public_schema_invalid',
  'public_version_mismatch',
  'public_count_mismatch',
  'route_sample_failed',
  'place_bundle_sample_failed',
  'state_pointer_mismatch',
  'previous_unavailable',
  'shape_sample_unavailable',
  'schedule_sample_unavailable',
  'probe_record_write_failed',
  'unknown',
])

export const SNAPSHOT_PROBE_DIAGNOSTIC_WARNINGS = Object.freeze([
  'state_pointer_mismatch',
  'previous_unavailable',
  'shape_sample_unavailable',
  'schedule_sample_unavailable',
])

export const SNAPSHOT_PROBE_FAILURE_STAGES = Object.freeze([
  'route_request',
  'route_schema',
  'route_version',
  'route_variant',
  'route_stops',
  'place_request',
  'place_schema',
  'place_version',
  'place_pattern',
])

export const SNAPSHOT_PROBE_REQUEST_FAILURE_REASONS = Object.freeze([
  'http_error',
  'timeout',
  'body_limit',
  'json_parse',
  'stream_failure',
  'network_failure',
  'unknown',
])

const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const CORE_COUNT_FIELDS = ['routes', 'patterns', 'stops', 'places', 'patternStops']

const ACTIVE_SQL = `
SELECT active_version, imported_at
FROM dataset_versions
WHERE city_code = ?
LIMIT 1
`

const COUNTS_SQL = `
SELECT
  (SELECT COUNT(*) FROM routes WHERE version = ? AND city_code = ?) AS routes,
  (SELECT COUNT(*) FROM patterns WHERE version = ? AND city_code = ?) AS patterns,
  (SELECT COUNT(*) FROM stops WHERE version = ? AND city_code = ?) AS stops,
  (SELECT COUNT(*) FROM stop_places WHERE version = ? AND city_code = ?) AS places,
  (SELECT COUNT(*) FROM pattern_stops ps
    JOIN patterns p ON p.version = ps.version AND p.pattern_id = ps.pattern_id
    WHERE ps.version = ? AND p.city_code = ?) AS pattern_stops,
  (SELECT COUNT(*) FROM routes r
    WHERE r.version = ? AND r.city_code = ?
      AND NOT EXISTS (
        SELECT 1 FROM patterns p
        WHERE p.version = r.version AND p.city_code = r.city_code AND p.route_uid = r.route_uid
      )) AS route_without_pattern,
  (SELECT COUNT(*) FROM patterns p
    WHERE p.version = ? AND p.city_code = ?
      AND EXISTS (
        SELECT 1 FROM pattern_stops ps
        WHERE ps.version = p.version AND ps.pattern_id = p.pattern_id
      )) AS sample_count
`

const LOW_CARD_COUNTS_SQL = `
SELECT
  (SELECT COUNT(*) FROM routes WHERE version = ? AND city_code = ?) AS routes,
  (SELECT COUNT(*) FROM patterns WHERE version = ? AND city_code = ?) AS patterns,
  (SELECT COUNT(*) FROM stop_places WHERE version = ? AND city_code = ?) AS places,
  (SELECT COUNT(*) FROM routes r
    WHERE r.version = ? AND r.city_code = ?
      AND NOT EXISTS (
        SELECT 1 FROM patterns p
        WHERE p.version = r.version AND p.city_code = r.city_code AND p.route_uid = r.route_uid
      )) AS route_without_pattern
`

const SAMPLE_SQL = `
SELECT p.pattern_id, p.route_uid, r.route_name, p.shape_key,
  (SELECT ps.place_id FROM pattern_stops ps
    WHERE ps.version = p.version AND ps.pattern_id = p.pattern_id
    ORDER BY ps.stop_sequence, ps.place_id LIMIT 1) AS place_id
FROM patterns p
JOIN routes r ON r.version = p.version AND r.city_code = p.city_code AND r.route_uid = p.route_uid
WHERE p.version = ? AND p.city_code = ?
  AND EXISTS (
    SELECT 1 FROM pattern_stops ps
    WHERE ps.version = p.version AND ps.pattern_id = p.pattern_id
  )
ORDER BY p.pattern_id, p.route_uid
LIMIT 1 OFFSET ?
`

const R2_SAMPLE_SQL = `
SELECT p.pattern_id, p.route_uid, r.route_name, p.shape_key
FROM patterns p
JOIN routes r ON r.version = p.version AND r.city_code = p.city_code AND r.route_uid = p.route_uid
WHERE p.version = ? AND p.city_code = ? AND p.pattern_id = ?
LIMIT 1
`

export async function probeActiveSnapshot({
  city,
  windowId,
  state,
  query,
  r2,
  publicApi,
  now = () => new Date(),
  probeCaseVersion = SNAPSHOT_PROBE_CASE_VERSION,
  diagnosticSink = defaultDiagnosticSink,
}) {
  const startedAt = now()
  const sampleCaseId = deterministicSampleCaseId(city, windowId, probeCaseVersion)
  let activeVersion = null
  let previousVersion = null
  let hardChecksPassed = 0

  try {
    let activeRows
    try {
      activeRows = await query(ACTIVE_SQL, [city])
    } catch {
      throw probeFailure('unknown')
    }
    if (!activeRows[0]?.active_version) throw probeFailure('active_pointer_missing')
    activeVersion = String(activeRows[0].active_version)
    if (!SAFE_VERSION.test(activeVersion)) throw probeFailure('active_pointer_invalid')
    hardChecksPassed += 1

    const authority = await readRoutingAuthority({ query, r2, city, version: activeVersion })
    const counts = authority.counts
    if (!CORE_COUNT_FIELDS.every((field) => Number.isInteger(counts[field]) && counts[field] > 0)) {
      throw probeFailure('active_rows_empty')
    }
    hardChecksPassed += 1
    if (counts.routeWithoutPattern !== 0) throw probeFailure('route_without_pattern')
    hardChecksPassed += 1

    const prefix = snapshotPrefix(activeVersion, city)
    let manifest
    try {
      manifest = await r2.getManifest(`${prefix}manifest.json`)
    } catch {
      throw probeFailure('manifest_read_failed')
    }
    if (!manifest) throw probeFailure('manifest_missing')
    if (manifest.schemaVersion !== 2 || manifest.city !== city || manifest.version !== activeVersion) {
      throw probeFailure('manifest_version_mismatch')
    }
    hardChecksPassed += 1
    if (!sameCoreCounts(manifest.counts, counts)
      || Number(manifest.counts?.placeBundles) < 1
      || !manifestHasCoreArtifactClasses(manifest.artifacts, prefix)) {
      throw probeFailure('manifest_count_mismatch')
    }
    if (authority.mode === 'r2') {
      try {
        routingManifestRootBinding(manifest.artifacts, authority.manifestObservations)
      } catch {
        throw probeFailure('routing_authority_invalid')
      }
    }
    hardChecksPassed += 1

    const networkKey = `${prefix}network.json`
    const networkArtifact = Array.isArray(manifest.artifacts)
      ? manifest.artifacts.find((artifact) => artifact?.key === networkKey)
      : undefined
    let networkHead
    try {
      networkHead = await r2.head(networkKey)
    } catch {
      throw probeFailure('network_missing')
    }
    if (!artifactHeadMatches(networkHead, networkArtifact)) {
      throw probeFailure('network_missing')
    }
    hardChecksPassed += 1
    let networkPrefix
    try {
      networkPrefix = await r2.readPrefix(networkKey, 65_536)
    } catch {
      throw probeFailure('network_version_mismatch')
    }
    if (!networkPrefixMatches(networkPrefix, city, activeVersion)) {
      throw probeFailure('network_version_mismatch')
    }
    hardChecksPassed += 1

    let routes
    try {
      routes = await publicApi.getJson(`/api/v1/map/routes?city=${encodeURIComponent(city)}&snapshot=${encodeURIComponent(activeVersion)}&probe=${encodeURIComponent(windowId)}`)
    } catch {
      throw probeFailure('public_routes_failed')
    }
    if (routes?.schemaVersion !== 2 || routes?.source !== 'snapshot' || !Array.isArray(routes.routes)) {
      throw probeFailure('public_schema_invalid')
    }
    if (routes.snapshotVersion !== activeVersion) throw probeFailure('public_version_mismatch')
    hardChecksPassed += 1
    if (routes.routes.length !== counts.routes) throw probeFailure('public_count_mismatch')
    hardChecksPassed += 1

    const sampleIndex = deterministicSampleIndex(city, windowId, probeCaseVersion, counts.sampleCount)
    let sampleRows
    try {
      sampleRows = authority.mode === 'r2'
        ? await query(R2_SAMPLE_SQL, [activeVersion, city, authority.patternEntries[sampleIndex].patternId])
        : await query(SAMPLE_SQL, [activeVersion, city, sampleIndex])
    } catch {
      throw probeFailure('route_sample_failed')
    }
    const sample = authority.mode === 'r2'
      ? await attachR2SamplePlace(sampleRows[0], authority.patternEntries[sampleIndex], r2, city, activeVersion)
      : sampleRows[0]
    if (!validSample(sample)) throw probeFailure('route_sample_failed')

    const emitSampleFailure = (
      failureStage,
      failureClass,
      observedSnapshotVersion = null,
      requestFailureReason = null,
    ) => {
      emitProbeDiagnostic(diagnosticSink, {
        city,
        windowId,
        sampleCaseId,
        samplePatternId: sample.pattern_id,
        sampleRouteUid: sample.route_uid,
        expectedSnapshotVersion: activeVersion,
        observedSnapshotVersion,
        attempt: 1,
        failureStage,
        failureClass,
        requestFailureReason,
      })
    }

    let route
    try {
      route = await publicApi.getJson(`/api/v1/map/route?city=${encodeURIComponent(city)}&route=${encodeURIComponent(sample.route_name)}&routeUid=${encodeURIComponent(sample.route_uid)}&patternId=${encodeURIComponent(sample.pattern_id)}&snapshot=${encodeURIComponent(activeVersion)}&probe=${encodeURIComponent(windowId)}`)
    } catch (error) {
      emitSampleFailure(
        'route_request',
        'route_sample_failed',
        null,
        classifyProbeRequestFailure(error),
      )
      throw probeFailure('route_sample_failed')
    }
    if (route?.schemaVersion !== 1 || route?.source !== 'snapshot' || !Array.isArray(route.variants)) {
      emitSampleFailure('route_schema', 'route_sample_failed', route?.snapshotVersion)
      throw probeFailure('route_sample_failed')
    }
    if (route.snapshotVersion !== activeVersion) {
      emitSampleFailure('route_version', 'route_sample_failed', route.snapshotVersion)
      throw probeFailure('route_sample_failed')
    }
    const variant = route.variants.find((candidate) => candidate?.variantKey === sample.pattern_id)
    if (!variant || variant.routeUid !== sample.route_uid) {
      emitSampleFailure('route_variant', 'route_sample_failed', route.snapshotVersion)
      throw probeFailure('route_sample_failed')
    }
    if (!Array.isArray(variant.stops?.features) || variant.stops.features.length < 2) {
      emitSampleFailure('route_stops', 'route_sample_failed', route.snapshotVersion)
      throw probeFailure('route_sample_failed')
    }
    hardChecksPassed += 1

    let place
    try {
      place = await publicApi.getJson(`/api/v1/map/place/${encodeURIComponent(sample.place_id)}/arrivals?city=${encodeURIComponent(city)}&snapshot=${encodeURIComponent(activeVersion)}&probe=${encodeURIComponent(windowId)}`)
    } catch (error) {
      emitSampleFailure(
        'place_request',
        'place_bundle_sample_failed',
        null,
        classifyProbeRequestFailure(error),
      )
      throw probeFailure('place_bundle_sample_failed')
    }
    if (place?.schemaVersion !== 1
      || place?.scheduleSource !== 'place-bundle'
      || !Array.isArray(place.routes)) {
      emitSampleFailure('place_schema', 'place_bundle_sample_failed', place?.snapshotVersion)
      throw probeFailure('place_bundle_sample_failed')
    }
    if (place.snapshotVersion !== activeVersion) {
      emitSampleFailure('place_version', 'place_bundle_sample_failed', place.snapshotVersion)
      throw probeFailure('place_bundle_sample_failed')
    }
    if (!place.routes.some((candidate) =>
      candidate?.variantKey === sample.pattern_id && candidate?.routeUid === sample.route_uid)) {
      emitSampleFailure('place_pattern', 'place_bundle_sample_failed', place.snapshotVersion)
      throw probeFailure('place_bundle_sample_failed')
    }
    hardChecksPassed += 1

    const diagnostics = await probeDiagnostics({
      city,
      activeVersion,
      state,
      sample,
      query,
      r2,
    })
    previousVersion = diagnostics.previousVersion
    const result = diagnostics.warnings.length ? 'degraded' : 'success'
    const failureClass = diagnostics.warnings[0] ?? 'none'
    return probeResult({
      city, windowId, activeVersion, previousVersion, sampleCaseId, probeCaseVersion,
      activeProbeAt: now().toISOString(), result, failureClass,
      rollbackAvailable: diagnostics.rollbackAvailable,
      hardChecksPassed, diagnosticWarnings: diagnostics.warnings,
      latencyBucket: latencyBucket(now().getTime() - startedAt.getTime()),
    })
  } catch (error) {
    const failureClass = error instanceof SnapshotProbeFailure ? error.failureClass : 'unknown'
    return probeResult({
      city, windowId,
      activeVersion: typeof activeVersion === 'string' && SAFE_VERSION.test(activeVersion) ? activeVersion : null,
      previousVersion: typeof previousVersion === 'string' && SAFE_VERSION.test(previousVersion) ? previousVersion : null,
      sampleCaseId, probeCaseVersion,
      activeProbeAt: now().toISOString(), result: 'error', failureClass,
      rollbackAvailable: false, hardChecksPassed, diagnosticWarnings: [],
      latencyBucket: latencyBucket(now().getTime() - startedAt.getTime()),
    })
  }
}

export function deterministicSampleIndex(city, windowId, probeCaseVersion, candidateCount) {
  if (!Number.isInteger(candidateCount) || candidateCount < 1) throw probeFailure('route_sample_failed')
  const digest = createHash('sha256').update(`${city}\n${windowId}\n${probeCaseVersion}`).digest()
  return digest.readUInt32BE(0) % candidateCount
}

export function deterministicSampleCaseId(city, windowId, probeCaseVersion) {
  return `case_${createHash('sha256').update(`${city}\n${windowId}\n${probeCaseVersion}`).digest('hex').slice(0, 12)}`
}

export function classifyProbeRequestFailure(error) {
  if (error instanceof ProbeResponseReadError) return error.reason
  if (error instanceof SyntaxError) return 'json_parse'
  const name = error instanceof Error ? error.name : ''
  if (name === 'AbortError' || name === 'TimeoutError') return 'timeout'
  const message = error instanceof Error ? error.message : ''
  if (message === 'Public snapshot probe request failed') return 'http_error'
  if (message === 'Bounded response is too large') return 'body_limit'
  if (message === 'Bounded response has no body') return 'stream_failure'
  if (error instanceof TypeError) return 'network_failure'
  return 'unknown'
}

export function createSnapshotProbeDiagnostic(value) {
  if (!value || typeof value !== 'object') throw new Error('Invalid snapshot probe diagnostic')
  if (!SNAPSHOT_PROBE_FAILURE_STAGES.includes(value.failureStage)) {
    throw new Error('Invalid snapshot probe diagnostic stage')
  }
  if (!SNAPSHOT_PROBE_FAILURE_CLASSES.includes(value.failureClass) || value.failureClass === 'none') {
    throw new Error('Invalid snapshot probe diagnostic failure')
  }
  const attempt = Number(value.attempt)
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 12) {
    throw new Error('Invalid snapshot probe diagnostic attempt')
  }
  const requestFailureReason = value.requestFailureReason ?? null
  if (requestFailureReason !== null
    && !SNAPSHOT_PROBE_REQUEST_FAILURE_REASONS.includes(requestFailureReason)) {
    throw new Error('Invalid snapshot probe request failure reason')
  }
  return Object.freeze({
    event: 'snapshot_probe_diagnostic',
    city: safeIdentifier(value.city),
    windowId: safeIdentifier(value.windowId),
    sampleCaseId: safeIdentifier(value.sampleCaseId),
    samplePatternHash: boundedHash(value.samplePatternId),
    sampleRouteHash: boundedHash(value.sampleRouteUid),
    expectedSnapshotVersion: safeIdentifier(value.expectedSnapshotVersion),
    observedSnapshotVersion: safeNullableIdentifier(value.observedSnapshotVersion),
    attempt,
    failureStage: value.failureStage,
    failureClass: value.failureClass,
    requestFailureReason,
  })
}

export function artifactHeadMatches(head, artifact) {
  if (!head || !artifact) return false
  const expectedBytes = Number(artifact.bytes)
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1) return false
  if (head.size === null || head.size === undefined) return true
  const observedBytes = Number(head.size)
  return Number.isSafeInteger(observedBytes) && observedBytes === expectedBytes
}

export function networkPrefixMatches(prefix, city, version) {
  if (typeof prefix !== 'string') return false
  const compact = prefix.replace(/\s/g, '')
  return compact.startsWith(`{"schemaVersion":1,"city":${JSON.stringify(city)},"version":${JSON.stringify(version)},`)
}

export async function readBoundedResponseJson(response, maximumBytes) {
  const text = await readBoundedResponseText(response, maximumBytes)
  try {
    return JSON.parse(text)
  } catch {
    throw new ProbeResponseReadError('json_parse')
  }
}

export async function readBoundedResponseText(response, maximumBytes) {
  return new TextDecoder().decode(await readBoundedResponseBytes(response, maximumBytes))
}

export async function readBoundedResponseBytes(response, maximumBytes) {
  if (!response.body) throw new ProbeResponseReadError('stream_failure')
  const declaredLength = Number(response.headers.get('Content-Length'))
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body.cancel().catch(() => undefined)
    throw new ProbeResponseReadError('body_limit')
  }
  const reader = response.body.getReader()
  const chunks = []
  let bytes = 0
  try {
    while (true) {
      let result
      try {
        result = await reader.read()
      } catch {
        throw new ProbeResponseReadError('stream_failure')
      }
      const { done, value } = result
      if (done) break
      bytes += value.byteLength
      if (bytes > maximumBytes) throw new ProbeResponseReadError('body_limit')
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  const merged = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return merged
}

export function validateProbeResult(value) {
  if (!value || typeof value !== 'object') throw new Error('Invalid snapshot probe result')
  const result = value.activeProbeResult ?? value.result
  const failureClass = value.probeFailureClass ?? value.failureClass
  if (!['success', 'degraded', 'error'].includes(result)) throw new Error('Invalid snapshot probe result')
  if (!SNAPSHOT_PROBE_FAILURE_CLASSES.includes(failureClass)) throw new Error('Invalid snapshot probe failure class')
  if (result === 'success' ? failureClass !== 'none' : failureClass === 'none') {
    throw new Error('Snapshot probe result and failure class conflict')
  }
  if (!Array.isArray(value.diagnosticWarnings)
    || value.diagnosticWarnings.some((warning) => !SNAPSHOT_PROBE_DIAGNOSTIC_WARNINGS.includes(warning))) {
    throw new Error('Invalid snapshot probe diagnostics')
  }
  if (!Number.isInteger(value.hardChecksPassed)
    || value.hardChecksPassed < 0
    || value.hardChecksPassed > SNAPSHOT_PROBE_HARD_CHECK_COUNT) {
    throw new Error('Invalid snapshot probe check count')
  }
  return Object.freeze({
    probeSchemaVersion: SNAPSHOT_PROBE_SCHEMA_VERSION,
    city: safeIdentifier(value.city),
    windowId: safeIdentifier(value.windowId),
    activeVersion: nullableIdentifier(value.activeVersion),
    previousVersion: nullableIdentifier(value.previousVersion),
    activeProbeAt: validIso(value.activeProbeAt),
    activeProbeResult: result,
    probeFailureClass: failureClass,
    rollbackAvailable: value.rollbackAvailable === true,
    probeCaseVersion: positiveInteger(value.probeCaseVersion),
    sampleCaseId: safeIdentifier(value.sampleCaseId),
    hardChecksPassed: value.hardChecksPassed,
    diagnosticWarnings: Object.freeze([...new Set(value.diagnosticWarnings)].sort()),
    latencyBucket: safeIdentifier(value.latencyBucket),
  })
}

async function readCounts(query, city, version) {
  let rows
  try {
    rows = await query(COUNTS_SQL, [
      version, city, version, city, version, city, version, city,
      version, city, version, city, version, city,
    ])
  } catch {
    throw probeFailure('unknown')
  }
  const row = rows[0]
  if (!row) throw probeFailure('active_rows_empty')
  return {
    routes: Number(row.routes),
    patterns: Number(row.patterns),
    stops: Number(row.stops),
    places: Number(row.places),
    patternStops: Number(row.pattern_stops),
    routeWithoutPattern: Number(row.route_without_pattern),
    sampleCount: Number(row.sample_count),
  }
}

async function readRoutingAuthority({ query, r2, city, version }) {
  const keys = routingCompletionManifestKeys(version, city)
  let heads
  try {
    heads = await Promise.all(keys.map((key) => r2.head(key)))
  } catch {
    throw probeFailure('routing_authority_read_failed')
  }
  const present = heads.filter(Boolean).length
  if (present === 0) return { mode: 'd1', counts: await readCounts(query, city, version) }
  if (present !== keys.length) throw probeFailure('routing_authority_incomplete')

  let bodies
  try {
    bodies = await Promise.all(keys.map((key) => r2.getBytes(key, MAX_ROUTING_MANIFEST_BYTES)))
    if (bodies.some((body) => !body)) throw new Error('Routing manifest disappeared during read')
    if (bodies.some((body) => Buffer.from(body).byteLength > MAX_ROUTING_MANIFEST_BYTES)) {
      throw new Error('Routing manifest exceeds read limit')
    }
    if (heads.some((head, index) => head.size !== null && head.size !== undefined
      && Number(head.size) !== Buffer.from(bodies[index]).byteLength)) {
      throw new Error('Routing manifest changed during read')
    }
  } catch {
    throw probeFailure('routing_authority_read_failed')
  }
  let authority
  try {
    const parsed = bodies.map((body) => JSON.parse(Buffer.from(body).toString('utf8')))
    authority = parseRoutingAuthorityManifests(parsed, city, version)
  } catch {
    throw probeFailure('routing_authority_invalid')
  }

  let rows
  try {
    rows = await query(LOW_CARD_COUNTS_SQL, [version, city, version, city, version, city, version, city])
  } catch {
    throw probeFailure('unknown')
  }
  const row = rows[0]
  const counts = {
    routes: Number(row?.routes), patterns: Number(row?.patterns), places: Number(row?.places),
    stops: authority.counts.stops, patternStops: authority.counts.patternStops,
    routeWithoutPattern: Number(row?.route_without_pattern), sampleCount: authority.counts.patterns,
  }
  if (counts.patterns !== authority.counts.patterns || counts.places !== authority.counts.places) {
    throw probeFailure('routing_authority_invalid')
  }
  return {
    mode: 'r2', counts, patternEntries: authority.patternEntries,
    manifestObservations: routingManifestObservations(keys, bodies),
  }
}

async function attachR2SamplePlace(sample, entry, r2, city, version) {
  if (entry.bytes > MAX_PATTERN_STOP_ARTIFACT_BYTES) throw probeFailure('route_sample_failed')
  let stops
  try {
    const body = await r2.getBytes(entry.key, entry.bytes)
    if (!body) throw new Error('Pattern artifact missing')
    stops = parsePatternStopArtifact(parseJsonArtifactBytes(body, entry), city, version, entry)
  } catch {
    throw probeFailure('route_sample_failed')
  }
  return sample ? { ...sample, place_id: stops[0].placeId } : sample
}

async function probeDiagnostics({ city, activeVersion, state, sample, query, r2 }) {
  const warnings = []
  if (state?.version !== activeVersion) warnings.push('state_pointer_mismatch')
  const previousVersion = typeof state?.previousVersion === 'string' && SAFE_VERSION.test(state.previousVersion)
    ? state.previousVersion
    : null
  let rollbackAvailable = state?.version === activeVersion && previousVersion !== null && previousVersion !== activeVersion
  if (rollbackAvailable) {
    try {
      const { counts } = await readRoutingAuthority({ query, r2, city, version: previousVersion })
      const prefix = snapshotPrefix(previousVersion, city)
      const manifest = await r2.getManifest(`${prefix}manifest.json`)
      const networkKey = `${prefix}network.json`
      const networkArtifact = Array.isArray(manifest?.artifacts)
        ? manifest.artifacts.find((artifact) => artifact?.key === networkKey)
        : undefined
      const network = await r2.head(networkKey)
      const networkPrefix = await r2.readPrefix(networkKey, 65_536)
      rollbackAvailable = CORE_COUNT_FIELDS.every((field) => counts[field] > 0)
        && counts.routeWithoutPattern === 0
        && manifest?.schemaVersion === 2
        && manifest?.version === previousVersion
        && manifest?.city === city
        && sameCoreCounts(manifest?.counts, counts)
        && Number(manifest?.counts?.placeBundles) > 0
        && manifestHasCoreArtifactClasses(manifest?.artifacts, prefix)
        && artifactHeadMatches(network, networkArtifact)
        && networkPrefixMatches(networkPrefix, city, previousVersion)
    } catch {
      rollbackAvailable = false
    }
  }
  if (!rollbackAvailable) warnings.push('previous_unavailable')

  try {
    if (!await r2.head(String(sample.shape_key))) warnings.push('shape_sample_unavailable')
  } catch {
    warnings.push('shape_sample_unavailable')
  }
  try {
    const scheduleKey = `${snapshotPrefix(activeVersion, city)}schedules/${sample.route_uid}.json`
    if (!await r2.head(scheduleKey)) warnings.push('schedule_sample_unavailable')
  } catch {
    warnings.push('schedule_sample_unavailable')
  }
  return { previousVersion, rollbackAvailable, warnings: [...new Set(warnings)] }
}

function sameCoreCounts(manifestCounts, counts) {
  return Boolean(manifestCounts) && CORE_COUNT_FIELDS.every((field) => Number(manifestCounts[field]) === counts[field])
}

function manifestHasCoreArtifactClasses(artifacts, prefix) {
  return Array.isArray(artifacts)
    && artifacts.some((artifact) => artifact?.key === `${prefix}network.json`)
    && artifacts.some((artifact) => artifact?.key?.startsWith(`${prefix}shapes/`))
    && artifacts.some((artifact) => artifact?.key?.startsWith(`${prefix}schedules/`))
    && artifacts.some((artifact) => artifact?.key?.startsWith(`${prefix}places/`))
}

function validSample(value) {
  return value && ['pattern_id', 'route_uid', 'route_name', 'shape_key', 'place_id']
    .every((field) => typeof value[field] === 'string' && value[field].length > 0)
}

function snapshotPrefix(version, city) {
  return `snapshots/${version}/cities/${city}/`
}

function probeResult(value) {
  return validateProbeResult(value)
}

class SnapshotProbeFailure extends Error {
  constructor(failureClass) {
    super('Snapshot active probe failed')
    this.failureClass = failureClass
  }
}

class ProbeResponseReadError extends Error {
  constructor(reason) {
    super('Snapshot probe response read failed')
    this.reason = reason
  }
}

function probeFailure(failureClass) {
  return new SnapshotProbeFailure(SNAPSHOT_PROBE_FAILURE_CLASSES.includes(failureClass) ? failureClass : 'unknown')
}

function emitProbeDiagnostic(sink, value) {
  try {
    sink(createSnapshotProbeDiagnostic(value))
  } catch {
    // Probe diagnostics are fail-open and cannot change the hard-check result.
  }
}

function defaultDiagnosticSink(record) {
  console.log(JSON.stringify(record))
}

function boundedHash(value) {
  return `sha256_${createHash('sha256').update(String(value)).digest('hex').slice(0, 16)}`
}

function safeNullableIdentifier(value) {
  return typeof value === 'string' && SAFE_VERSION.test(value) ? value : null
}

function safeIdentifier(value) {
  const text = String(value)
  if (!SAFE_VERSION.test(text)) throw new Error('Invalid snapshot probe identifier')
  return text
}

function nullableIdentifier(value) {
  return value === null || value === undefined || value === '' ? null : safeIdentifier(value)
}

function validIso(value) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new Error('Invalid snapshot probe time')
  return new Date(value).toISOString()
}

function positiveInteger(value) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1) throw new Error('Invalid snapshot probe version')
  return number
}

function latencyBucket(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return 'unknown'
  if (milliseconds < 50) return 'lt_50ms'
  if (milliseconds < 200) return '50_199ms'
  if (milliseconds < 1_000) return '200_999ms'
  if (milliseconds < 3_000) return '1_3s'
  if (milliseconds <= 6_000) return '3_6s'
  return 'gt_6s'
}
