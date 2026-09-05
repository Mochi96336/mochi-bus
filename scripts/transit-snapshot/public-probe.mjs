import { networkPrefixMatches } from './active-probe.mjs'
import {
  PUBLIC_PROBE_CASE_VERSION,
  PUBLIC_PROBE_HARD_CHECK_COUNT,
  PUBLIC_PROBE_NETWORK_PREFIX_BYTES,
  publicSampleCaseId,
  validatePublicProbeResult,
} from './public-probe-contract.mjs'

const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const LOW_CARD_COUNT_FIELDS = ['routes', 'patterns', 'places']

// Public-network evidence chain: GitHub runner → DNS/TLS → Worker release →
// public API → active snapshot → route/StopUID/place/journey contract. D1 is
// deliberately limited to low-cardinality catalogue reference data; the public
// surface itself must prove that high-cardinality routing/lookup artifacts work.
export async function probePublicSurface({
  city,
  probeDate,
  reference,
  publicApi,
  now = () => new Date(),
  probeCaseVersion = PUBLIC_PROBE_CASE_VERSION,
}) {
  const startedAt = now()
  const sampleCaseId = publicSampleCaseId(city, probeDate, probeCaseVersion)
  let activeVersion = null
  let observedVersion = null
  let hardChecksPassed = 0

  try {
    if (!reference?.activeVersion) throw hardFailure('active_pointer_missing')
    activeVersion = String(reference.activeVersion)
    if (!SAFE_VERSION.test(activeVersion)) throw hardFailure('active_pointer_invalid')
    hardChecksPassed += 1

    const counts = reference.counts ?? {}
    if (!LOW_CARD_COUNT_FIELDS.every((field) => Number.isInteger(counts[field]) && counts[field] > 0)) {
      throw hardFailure('active_rows_empty')
    }
    hardChecksPassed += 1
    if (counts.routeWithoutPattern !== 0) throw hardFailure('route_without_pattern')
    hardChecksPassed += 1

    const routes = await publicJson(publicApi, `/api/v1/map/routes?city=${encodeURIComponent(city)}`, 'public_routes_failed')
    if (routes?.schemaVersion !== 2 || !Array.isArray(routes.routes)) throw hardFailure('public_schema_invalid')
    hardChecksPassed += 1
    if (routes.source !== 'snapshot') throw hardFailure('public_source_not_snapshot')
    hardChecksPassed += 1
    if (routes.snapshotVersion !== activeVersion) {
      observedVersion = nullableVersion(routes.snapshotVersion)
      throw hardFailure('public_version_mismatch')
    }
    observedVersion = activeVersion
    hardChecksPassed += 1
    if (routes.routes.length !== counts.routes) throw hardFailure('public_count_mismatch')
    hardChecksPassed += 1

    const sample = reference.sample
    if (!validSample(sample)) throw hardFailure('route_sample_failed')
    const route = await publicJson(publicApi,
      `/api/v1/map/route?city=${encodeURIComponent(city)}&route=${encodeURIComponent(sample.routeName)}&routeUid=${encodeURIComponent(sample.routeUid)}&patternId=${encodeURIComponent(sample.patternId)}`,
      'route_sample_failed')
    const variant = Array.isArray(route?.variants)
      ? route.variants.find((candidate) => candidate?.variantKey === sample.patternId)
      : undefined
    if (route?.schemaVersion !== 1 || route?.source !== 'snapshot' || !variant || variant.stops?.features?.length < 2) {
      throw hardFailure('route_sample_failed')
    }
    const firstStop = variant.stops.features.find((feature) => validStopFeature(feature))
    if (!firstStop) throw hardFailure('route_sample_failed')
    const stopUid = firstStop.properties.stopUid
    const stopSequence = Number(firstStop.properties.sequence)
    const stopPlace = await publicJson(publicApi,
      `/api/v1/map/stop-place?city=${encodeURIComponent(city)}&stopUid=${encodeURIComponent(stopUid)}`,
      'route_sample_failed')
    const placeId = stopPlace?.place?.placeId
    if (stopPlace?.schemaVersion !== 1
      || stopPlace?.city !== city
      || stopPlace?.stopUid !== stopUid
      || typeof placeId !== 'string' || !placeId) {
      throw hardFailure('route_sample_failed')
    }
    const resolvedSample = Object.freeze({ ...sample, placeId, stopSequence })
    hardChecksPassed += 1

    const arrivals = await publicJson(publicApi, `/api/v1/map/place/${encodeURIComponent(placeId)}/arrivals?city=${encodeURIComponent(city)}`, 'place_bundle_sample_failed')
    if (arrivals?.schemaVersion !== 1
      || arrivals?.scheduleSource !== 'place-bundle'
      || arrivals?.snapshotVersion !== activeVersion
      || !Array.isArray(arrivals.routes)
      || !arrivals.routes.some((candidate) => candidate?.variantKey === sample.patternId)) {
      throw hardFailure('place_bundle_sample_failed')
    }
    hardChecksPassed += 1

    // 64 KiB bounded prefix instead of a full network download: Taipei and
    // NewTaipei network payloads are tens of megabytes.
    let networkPrefix
    try {
      networkPrefix = await publicApi.readPrefix(`/api/v1/map/network?city=${encodeURIComponent(city)}`, PUBLIC_PROBE_NETWORK_PREFIX_BYTES)
    } catch (error) {
      throw rateLimitedOr(error, 'network_missing')
    }
    if (!networkPrefixMatches(networkPrefix, city, activeVersion)) throw hardFailure('network_version_mismatch')
    hardChecksPassed += 1

    const warnings = await realtimeDiagnostics({ city, sample: resolvedSample, arrivals, publicApi, sampleCaseId })
    return validatePublicProbeResult({
      city,
      probeDate,
      evaluatedAt: now().toISOString(),
      status: warnings.length ? 'realtime_degraded' : 'healthy',
      activeVersion,
      observedVersion,
      failureClass: warnings[0] ?? 'none',
      hardChecksPassed,
      realtimeWarnings: warnings,
      probeCaseVersion,
      sampleCaseId,
      latencyBucket: latencyBucket(now().getTime() - startedAt.getTime()),
    })
  } catch (error) {
    const failure = error instanceof PublicProbeFailure ? error : new PublicProbeFailure('unknown', 'unknown')
    return validatePublicProbeResult({
      city,
      probeDate,
      evaluatedAt: now().toISOString(),
      status: failure.kind === 'hard' ? 'hard_failed' : 'unknown',
      activeVersion: nullableVersion(activeVersion),
      observedVersion: nullableVersion(observedVersion),
      failureClass: failure.failureClass,
      hardChecksPassed: failure.kind === 'hard' ? Math.min(hardChecksPassed, PUBLIC_PROBE_HARD_CHECK_COUNT - 1) : hardChecksPassed,
      realtimeWarnings: [],
      probeCaseVersion,
      sampleCaseId,
      latencyBucket: latencyBucket(now().getTime() - startedAt.getTime()),
    })
  }
}

// Realtime plane runs only after hard health passed. Everything here is a
// yellow diagnostic: TDX 429/quota/timeout, schedule-only arrivals, stale
// replay, unknown journey estimates, and vehicle feed trouble never turn the
// city's snapshot health red. Failures inside this plane also never throw.
async function realtimeDiagnostics({ city, sample, arrivals, publicApi, sampleCaseId }) {
  const warnings = new Set()

  if (arrivals.warning || arrivals.realtime?.rateLimited === true) warnings.add('realtime_upstream_degraded')
  const sources = arrivals.routes.map((route) => route?.source)
  if (sources.some((source) => source === 'stale-realtime')) warnings.add('realtime_stale_replay')
  if (Number(arrivals.realtime?.candidates) > 0
    && !sources.some((source) => source === 'realtime' || source === 'stale-realtime')) {
    warnings.add('realtime_schedule_only')
  }

  // One fixed synthetic journey case per city per day; never one per route.
  try {
    const journey = await publicApi.postJson('/api/v1/map/journey-eta', {
      city,
      legs: [{ key: `probe:${sampleCaseId}`, patternId: sample.patternId, sequence: sample.stopSequence }],
    })
    if (journey?.warning) warnings.add('realtime_upstream_degraded')
    const estimate = Array.isArray(journey?.estimates) ? journey.estimates[0] : undefined
    if (journey?.schemaVersion !== 1 || !estimate || estimate.source === 'none') {
      warnings.add('journey_estimate_unknown')
    }
  } catch {
    warnings.add('journey_estimate_unknown')
  }

  try {
    const vehicles = await publicApi.getJson(`/api/v1/map/vehicles?city=${encodeURIComponent(city)}&route=${encodeURIComponent(sample.routeName)}`)
    // An empty vehicles list is legal data (no bus on the road right now).
    if (vehicles?.schemaVersion !== 1 || !Array.isArray(vehicles.vehicles) || vehicles.warning) {
      warnings.add('vehicles_upstream_degraded')
    }
  } catch {
    warnings.add('vehicles_upstream_degraded')
  }

  return [...warnings].sort()
}

async function publicJson(publicApi, path, failureClass) {
  try {
    return await publicApi.getJson(path)
  } catch (error) {
    throw rateLimitedOr(error, failureClass)
  }
}

function rateLimitedOr(error, failureClass) {
  if (error instanceof PublicProbeFailure) return error
  // 429 comes from our own rate limiter, not from broken city data: the
  // evidence is incomplete, so the city stays unknown instead of red.
  return error?.status === 429
    ? new PublicProbeFailure('probe_rate_limited', 'infrastructure')
    : new PublicProbeFailure(failureClass, 'hard')
}

function hardFailure(failureClass) {
  return new PublicProbeFailure(failureClass, 'hard')
}

class PublicProbeFailure extends Error {
  constructor(failureClass, kind) {
    super('Public surface probe failed')
    this.failureClass = failureClass
    this.kind = kind
  }
}

function validSample(value) {
  return Boolean(value)
    && ['patternId', 'routeUid', 'routeName']
      .every((field) => typeof value[field] === 'string' && value[field].length > 0)
}

function validStopFeature(value) {
  return Boolean(value?.properties)
    && typeof value.properties.stopUid === 'string'
    && value.properties.stopUid.length > 0
    && Number.isInteger(Number(value.properties.sequence))
    && Number(value.properties.sequence) >= 0
}

function nullableVersion(value) {
  return typeof value === 'string' && SAFE_VERSION.test(value) ? value : null
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
