import { createHash } from 'node:crypto'
import { assertScheduledCity, validDateOnly } from './snapshot-schedule.mjs'

export const PUBLIC_PROBE_SCHEMA_VERSION = 1
export const PUBLIC_PROBE_EVENT_SCHEMA_VERSION = 7
// A6b rotates independently from the publisher-side probe (A5b) so the two
// probes never permanently sample the same route/place case.
export const PUBLIC_PROBE_CASE_VERSION = 1
export const PUBLIC_PROBE_HARD_CHECK_COUNT = 10
export const PUBLIC_PROBE_NETWORK_PREFIX_BYTES = 65_536

export const PUBLIC_PROBE_STATUSES = Object.freeze([
  'healthy',
  'snapshot_healthy',
  'realtime_degraded',
  'hard_failed',
  'unknown',
  'record_write_failed',
])

// Hard snapshot health: these classes may mean the city's published data is
// actually broken, and are allowed to turn the city red.
export const PUBLIC_PROBE_HARD_FAILURE_CLASSES = Object.freeze([
  'active_pointer_missing',
  'active_pointer_invalid',
  'active_rows_empty',
  'route_without_pattern',
  'public_routes_failed',
  'public_schema_invalid',
  'public_source_not_snapshot',
  'public_version_mismatch',
  'public_count_mismatch',
  'route_sample_failed',
  'place_bundle_sample_failed',
  'network_missing',
  'network_version_mismatch',
])

// Probe infrastructure problems: evidence is incomplete, so the city is
// unknown — never red — and the job itself fails.
export const PUBLIC_PROBE_INFRASTRUCTURE_FAILURE_CLASSES = Object.freeze([
  'reference_unavailable',
  'probe_rate_limited',
  'record_write_failed',
  'unknown',
])

// Realtime/degraded diagnostics: yellow only. Schedule-only arrivals, unknown
// journey estimates, and upstream TDX trouble never fail snapshot hard health.
export const PUBLIC_PROBE_REALTIME_WARNINGS = Object.freeze([
  'realtime_upstream_degraded',
  'realtime_schedule_only',
  'realtime_stale_replay',
  'journey_estimate_unknown',
  'vehicles_upstream_degraded',
])

export const PUBLIC_PROBE_FAILURE_CLASSES = Object.freeze([
  'none',
  ...PUBLIC_PROBE_HARD_FAILURE_CLASSES,
  ...PUBLIC_PROBE_INFRASTRUCTURE_FAILURE_CLASSES,
  ...PUBLIC_PROBE_REALTIME_WARNINGS,
])

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const FULL_SHA = /^[a-f0-9]{40}$/

export function deterministicPublicCaseIndex(city, probeDate, probeCaseVersion, candidateCount) {
  if (!Number.isInteger(candidateCount) || candidateCount < 1) throw new Error('Invalid public probe candidate count')
  return publicCaseDigest(city, probeDate, probeCaseVersion).readUInt32BE(0) % candidateCount
}

export function publicSampleCaseId(city, probeDate, probeCaseVersion) {
  return `pub_${publicCaseDigest(city, probeDate, probeCaseVersion).toString('hex').slice(0, 12)}`
}

function publicCaseDigest(city, probeDate, probeCaseVersion) {
  // The literal 'public' prefix keeps this rotation series disjoint from the
  // publisher probe's `${city}\n${windowId}\n${version}` series.
  return createHash('sha256').update(`public\n${city}\n${validDateOnly(probeDate)}\n${probeCaseVersion}`).digest()
}

export function validatePublicProbeResult(value) {
  if (!value || typeof value !== 'object') throw new Error('Invalid public probe result')
  assertScheduledCity(value.city)
  if (!PUBLIC_PROBE_STATUSES.includes(value.status)) throw new Error('Invalid public probe status')
  if (!PUBLIC_PROBE_FAILURE_CLASSES.includes(value.failureClass)) throw new Error('Invalid public probe failure class')
  if (!Number.isInteger(value.hardChecksPassed)
    || value.hardChecksPassed < 0
    || value.hardChecksPassed > PUBLIC_PROBE_HARD_CHECK_COUNT) {
    throw new Error('Invalid public probe check count')
  }
  if (!Array.isArray(value.realtimeWarnings)
    || value.realtimeWarnings.some((warning) => !PUBLIC_PROBE_REALTIME_WARNINGS.includes(warning))) {
    throw new Error('Invalid public probe warnings')
  }
  const warnings = Object.freeze([...new Set(value.realtimeWarnings)].sort())

  const hardPassed = value.hardChecksPassed === PUBLIC_PROBE_HARD_CHECK_COUNT
  if (value.status === 'healthy'
    && !(value.failureClass === 'none' && warnings.length === 0 && hardPassed)) {
    throw new Error('Healthy public probe must pass every hard check without warnings')
  }
  if (value.status === 'snapshot_healthy'
    && !(value.failureClass === 'none' && warnings.length === 0 && hardPassed)) {
    throw new Error('Snapshot-only public probe must pass every hard check without realtime claims')
  }
  if (value.status === 'realtime_degraded'
    && !(hardPassed && warnings.length > 0 && value.failureClass === warnings[0])) {
    throw new Error('Degraded public probe must pass hard checks and carry warnings')
  }
  if (value.status === 'hard_failed'
    && !(PUBLIC_PROBE_HARD_FAILURE_CLASSES.includes(value.failureClass) && warnings.length === 0 && !hardPassed)) {
    throw new Error('Hard-failed public probe must name a hard failure class')
  }
  if (value.status === 'unknown'
    && !(PUBLIC_PROBE_INFRASTRUCTURE_FAILURE_CLASSES.includes(value.failureClass) && warnings.length === 0)) {
    throw new Error('Unknown public probe must name an infrastructure failure class')
  }
  if (value.status === 'record_write_failed'
    && !(value.failureClass === 'record_write_failed' && warnings.length === 0)) {
    throw new Error('Record-write-failed public probe has a fixed failure class')
  }

  return Object.freeze({
    publicProbeSchemaVersion: PUBLIC_PROBE_SCHEMA_VERSION,
    city: value.city,
    probeDate: validDateOnly(value.probeDate),
    evaluatedAt: validIso(value.evaluatedAt),
    status: value.status,
    activeVersion: nullableIdentifier(value.activeVersion),
    observedVersion: nullableIdentifier(value.observedVersion),
    failureClass: value.failureClass,
    hardChecksPassed: value.hardChecksPassed,
    realtimeWarnings: warnings,
    probeCaseVersion: positiveInteger(value.probeCaseVersion),
    sampleCaseId: safeIdentifier(value.sampleCaseId),
    latencyBucket: safeIdentifier(value.latencyBucket),
  })
}

export function publicProbeFailureResult({ city, probeDate, evaluatedAt, failureClass, probeCaseVersion = PUBLIC_PROBE_CASE_VERSION }) {
  const safeClass = PUBLIC_PROBE_INFRASTRUCTURE_FAILURE_CLASSES.includes(failureClass) ? failureClass : 'unknown'
  return validatePublicProbeResult({
    city,
    probeDate,
    evaluatedAt,
    status: safeClass === 'record_write_failed' ? 'record_write_failed' : 'unknown',
    activeVersion: null,
    observedVersion: null,
    failureClass: safeClass,
    hardChecksPassed: 0,
    realtimeWarnings: [],
    probeCaseVersion,
    sampleCaseId: publicSampleCaseId(city, probeDate, probeCaseVersion),
    latencyBucket: 'unknown',
  })
}

export function withPublicProbeLatency(result, milliseconds) {
  return validatePublicProbeResult({ ...result, latencyBucket: latencyBucket(milliseconds) })
}

export function createPublicProbeEvent(result, releaseSha = null) {
  const safe = validatePublicProbeResult(result)
  const snapshotOnly = safe.status === 'snapshot_healthy'
  const hardPassed = safe.status === 'healthy'
    || snapshotOnly
    || safe.status === 'realtime_degraded'
  return Object.freeze({
    eventSchema: PUBLIC_PROBE_EVENT_SCHEMA_VERSION,
    event: 'public_probe_completed',
    releaseSha: releaseSha && FULL_SHA.test(releaseSha) ? releaseSha : null,
    workerVersionId: null,
    workerCreatedAt: null,
    deploymentId: null,
    city: safe.city,
    operation: 'public_probe',
    // Snapshot-only coverage is deliberately degraded rather than reported as a
    // fully green telemetry event. partial_unknown distinguishes missing realtime
    // coverage from an actual realtime warning without inventing a failure class.
    result: safe.status === 'healthy' ? 'success' : hardPassed ? 'degraded' : 'error',
    source: hardPassed ? 'snapshot' : 'none',
    snapshotVersion: safe.activeVersion,
    httpStatusClass: 'none',
    latencyBucket: safe.latencyBucket,
    cacheResult: 'not_applicable',
    trafficClass: 'synthetic',
    sampleProbability: 1,
    failureClass: safe.failureClass,
    emptyReason: 'not_applicable',
    qualityBucket: snapshotOnly ? 'partial_unknown' : 'not_applicable',
    probeCaseVersion: safe.probeCaseVersion,
    sampleCaseId: safe.sampleCaseId,
    hardChecksPassed: safe.hardChecksPassed,
    diagnosticWarningCount: safe.realtimeWarnings.length,
  })
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

function validIso(value) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new Error('Invalid public probe time')
  return new Date(value).toISOString()
}

function safeIdentifier(value) {
  const text = String(value)
  if (!SAFE_IDENTIFIER.test(text)) throw new Error('Invalid public probe identifier')
  return text
}

function nullableIdentifier(value) {
  return value === null || value === undefined || value === '' ? null : safeIdentifier(value)
}

function positiveInteger(value) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1) throw new Error('Invalid public probe case version')
  return number
}
