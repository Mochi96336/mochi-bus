import { appendFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { loadOperationalResources } from '../instance/operational-resources.mjs'
import { loadOperationsPlan } from '../instance/operations-plan.mjs'
import { classifyProbeRequestFailure } from './active-probe.mjs'
import { resolvePublicProbeBaseUrl } from './public-probe-origin.mjs'
import {
  publicProbeBodyLimitDetail,
  readPublicProbeJson,
} from './public-probe-response.mjs'
import { enabledSnapshotCitiesInScheduleOrder, taipeiDate, validDateOnly } from './snapshot-schedule.mjs'
import {
  createPublicProbeEvent,
  deterministicPublicCaseIndex,
  PUBLIC_PROBE_CASE_VERSION,
  publicProbeFailureResult,
  withPublicProbeLatency,
} from './public-probe-contract.mjs'
import { probePublicSurface } from './public-probe.mjs'
import { createD1PublicProbeStore, publicProbeRunId } from './public-probe-d1.mjs'

const OPERATIONS_PLAN = loadOperationsPlan()
export const PUBLIC_PROBE_CITIES = enabledSnapshotCitiesInScheduleOrder(OPERATIONS_PLAN.enabledCities)
// Production checks every enabled city's snapshot plane daily, but only four
// cities run TDX-backed realtime diagnostics each day. A deterministic rolling
// window covers all 22 cities within six days without spending shared quota on
// the same nationwide realtime sweep every morning.
export const PUBLIC_PROBE_REALTIME_SAMPLE_SIZE = 4
// The expensive rate-limit bucket allows 30 requests/minute per IP. Snapshot-
// only cities still read arrivals + network; sampled cities additionally run
// journey ETA. Pacing keeps the whole sweep under the public rate limit.
export const PUBLIC_PROBE_EXPENSIVE_INTERVAL_MS = 2_500

const HEALTHY_STATUSES = new Set(['healthy', 'snapshot_healthy', 'realtime_degraded'])
const EXPENSIVE_PATH = /^\/api\/v1\/map\/(?:network|journey-eta$|place\/[^/]+\/arrivals)/
const DAY_MS = 24 * 60 * 60 * 1000
const HTTP_RESPONSE_KINDS = new Set(['json', 'html', 'other', 'missing'])
const ROUTE_SAMPLE_DETAIL_STAGES = new Set([
  'reference_sample_invalid',
  'route_fetch_pending',
  'route_fetch_failed',
  'route_response_invalid',
  'variant_missing',
  'variant_stops_invalid',
  'first_stop_invalid',
  'stop_place_pending',
  'stop_place_fetch_failed',
  'stop_place_invalid',
  'complete',
])

export async function runPublicProbe({
  env = process.env,
  now = () => new Date(),
  monotonic = () => performance.now(),
  store,
  publicApi,
  cities = PUBLIC_PROBE_CITIES,
  // Library callers keep the previous full-realtime behavior unless they opt
  // into rotation. The production CLI below explicitly uses the four-city cap.
  realtimeSampleSize = cities.length,
  emitter = (event) => console.log(JSON.stringify(event)),
  realtimeDetailEmitter = () => undefined,
  routeSampleDetailEmitter = () => undefined,
  summaryWriter = writePublicProbeSummary,
}) {
  const evaluatedAt = now().toISOString()
  const probeDate = taipeiDate(new Date(evaluatedAt))
  const realtimeCities = publicProbeRealtimeCities(cities, probeDate, realtimeSampleSize)
  const runId = publicProbeRunId({
    workflowRunId: nullableString(env.GITHUB_RUN_ID),
    workflowRunAttempt: env.GITHUB_RUN_ATTEMPT ?? 1,
    evaluatedAt,
  })
  let infrastructureFailed = false
  try {
    await store.startRun({ probeRunId: runId, evaluatedAt, probeDate })
  } catch {
    infrastructureFailed = true
    safeLog('public_probe_run_start_write_failed', null, runId)
  }

  const results = []
  for (const city of cities) {
    const started = monotonic()
    let result
    try {
      const reference = await readCityReference(store, city, probeDate)
      const routeSampleObserver = createRouteSampleObserver({ publicApi, city, sample: reference.sample })
      result = await probePublicSurface({
        city,
        probeDate,
        reference,
        publicApi: routeSampleObserver.publicApi,
        now,
        realtimeDetailEmitter,
        realtimeSampled: realtimeCities.has(city),
      })
      if (result.failureClass === 'route_sample_failed') {
        emitFailOpen(routeSampleObserver.detail(result.sampleCaseId), routeSampleDetailEmitter)
      }
    } catch {
      result = publicProbeFailureResult({
        city, probeDate, evaluatedAt: now().toISOString(), failureClass: 'reference_unavailable',
      })
    }
    result = withPublicProbeLatency(result, monotonic() - started)
    try {
      await store.completeCity(runId, result)
    } catch {
      infrastructureFailed = true
      result = withPublicProbeLatency(publicProbeFailureResult({
        city, probeDate, evaluatedAt: result.evaluatedAt, failureClass: 'record_write_failed',
      }), monotonic() - started)
      safeLog('public_probe_city_write_failed', city, runId)
    }
    emitFailOpen(createPublicProbeEvent(result, fullGitSha(env.GITHUB_SHA)), emitter)
    results.push(result)
  }

  const failed = results.filter((result) => !HEALTHY_STATUSES.has(result.status))
  const completedAt = now().toISOString()
  try {
    await store.completeRun({
      probeRunId: runId,
      evaluatedAt,
      completedAt,
      result: failed.length || infrastructureFailed ? 'failed' : 'success',
      failureCount: Math.max(failed.length, infrastructureFailed ? 1 : 0),
    })
  } catch {
    infrastructureFailed = true
    safeLog('public_probe_run_complete_write_failed', null, runId)
  }

  const summary = Object.freeze({
    publicProbeSchemaVersion: 1,
    probeRunId: runId,
    evaluatedAt,
    probeDate,
    realtimeSampledCities: Object.freeze([...realtimeCities]),
    results: Object.freeze([...results]),
  })
  try {
    await summaryWriter(summary)
  } catch {
    infrastructureFailed = true
    safeLog('public_probe_summary_write_failed', null, runId)
  }
  return Object.freeze({
    summary,
    ok: !infrastructureFailed && failed.length === 0,
    failedCities: Object.freeze(failed.map((result) => result.city)),
  })
}

export function publicProbeRealtimeCities(cities, probeDate, sampleSize) {
  const ordered = [...cities]
  if (ordered.length === 0) return new Set()
  const requested = Number.isFinite(sampleSize) ? Math.floor(sampleSize) : ordered.length
  const size = Math.max(0, Math.min(ordered.length, requested))
  if (size === 0) return new Set()
  if (size === ordered.length) return new Set(ordered)

  const date = validDateOnly(probeDate)
  const dayIndex = Math.floor(Date.parse(`${date}T00:00:00Z`) / DAY_MS)
  // Advancing by the sample size gives contiguous, non-overlapping windows
  // until wrapping. With 22 cities and size 4, every city is sampled in six days.
  const start = ((dayIndex * size) % ordered.length + ordered.length) % ordered.length
  return new Set(Array.from({ length: size }, (_, offset) => ordered[(start + offset) % ordered.length]))
}

async function readCityReference(store, city, probeDate) {
  const base = await store.readReference(city)
  if (!base?.activeVersion || !base.counts || base.counts.sampleCount < 1) {
    return Object.freeze({ ...base, sample: null })
  }
  const index = deterministicPublicCaseIndex(city, probeDate, PUBLIC_PROBE_CASE_VERSION, base.counts.sampleCount)
  const sample = await store.readSample(city, base.activeVersion, index)
  return Object.freeze({ ...base, sample })
}

// Observe the existing request/response chain without adding network reads or
// changing probe health semantics. When the core probe returns the intentionally
// broad route_sample_failed class, this records only bounded phase/failure labels.
export function createRouteSampleObserver({ publicApi, city, sample }) {
  let expectedStopUid = null
  let stage = validRouteSample(sample) ? 'route_fetch_pending' : 'reference_sample_invalid'
  let requestFailureDetail = null

  const observedApi = Object.freeze({
    async getJson(path) {
      if (path.startsWith('/api/v1/map/route?')) {
        try {
          const response = await publicApi.getJson(path)
          const observed = classifyRouteSampleResponse(response, sample)
          expectedStopUid = observed.expectedStopUid
          requestFailureDetail = null
          stage = observed.stage
          return response
        } catch (error) {
          requestFailureDetail = classifyPublicProbeRequestFailureDetail(error)
          stage = 'route_fetch_failed'
          throw error
        }
      }
      if (path.startsWith('/api/v1/map/stop-place?')) {
        try {
          const response = await publicApi.getJson(path)
          requestFailureDetail = null
          stage = validObservedStopPlace(response, city, expectedStopUid)
            ? 'complete'
            : 'stop_place_invalid'
          return response
        } catch (error) {
          requestFailureDetail = classifyPublicProbeRequestFailureDetail(error)
          stage = 'stop_place_fetch_failed'
          throw error
        }
      }
      return await publicApi.getJson(path)
    },
    async postJson(path, body) {
      return await publicApi.postJson(path, body)
    },
    async readPrefix(path, maximumBytes) {
      return await publicApi.readPrefix(path, maximumBytes)
    },
  })

  return Object.freeze({
    publicApi: observedApi,
    detail(sampleCaseId) {
      const observedStage = ROUTE_SAMPLE_DETAIL_STAGES.has(stage) ? stage : 'route_fetch_pending'
      return Object.freeze({
        message: 'public_probe_route_sample_detail',
        city,
        sampleCaseId,
        stage: observedStage,
        ...((observedStage === 'route_fetch_failed' || observedStage === 'stop_place_fetch_failed')
          ? (requestFailureDetail ?? { requestFailureReason: 'unknown' })
          : {}),
      })
    },
  })
}

export function classifyPublicProbeRequestFailure(error) {
  if (error instanceof PublicApiError) return 'http_error'
  return classifyProbeRequestFailure(error)
}

export function classifyPublicProbeRequestFailureDetail(error) {
  const requestFailureReason = classifyPublicProbeRequestFailure(error)
  const responseSizeDetail = requestFailureReason === 'body_limit'
    ? publicProbeBodyLimitDetail(error)
    : null
  const httpStatusDetail = requestFailureReason === 'http_error' && error instanceof PublicApiError
    ? {
        requestHttpStatusClass: publicProbeHttpStatusClass(error.status),
        requestHttpResponseKind: error.responseKind,
      }
    : null
  return Object.freeze({
    requestFailureReason,
    ...(responseSizeDetail ?? {}),
    ...(httpStatusDetail ?? {}),
  })
}

function publicProbeHttpStatusClass(status) {
  if (!Number.isInteger(status) || status < 200 || status > 599) return 'none'
  return `${Math.floor(status / 100)}xx`
}

function publicProbeHttpResponseKind(value) {
  if (typeof value !== 'string' || value.trim() === '') return 'missing'
  const mediaType = value.split(';', 1)[0].trim().toLowerCase()
  if (mediaType === 'application/json' || mediaType.endsWith('+json')) return 'json'
  if (mediaType === 'text/html' || mediaType === 'application/xhtml+xml') return 'html'
  return 'other'
}

function classifyRouteSampleResponse(route, sample) {
  if (route?.schemaVersion !== 1 || route?.source !== 'snapshot' || !Array.isArray(route?.variants)) {
    return Object.freeze({ stage: 'route_response_invalid', expectedStopUid: null })
  }
  const variant = route.variants.find((candidate) =>
    candidate?.variantKey === sample?.patternId && candidate?.routeUid === sample?.routeUid)
  if (!variant) return Object.freeze({ stage: 'variant_missing', expectedStopUid: null })
  if (!Array.isArray(variant.stops?.features) || variant.stops.features.length < 2) {
    return Object.freeze({ stage: 'variant_stops_invalid', expectedStopUid: null })
  }
  const firstStop = variant.stops.features.find(validObservedStopFeature)
  if (!firstStop) return Object.freeze({ stage: 'first_stop_invalid', expectedStopUid: null })
  return Object.freeze({
    stage: 'stop_place_pending',
    expectedStopUid: firstStop.properties.stopUid,
  })
}

function validRouteSample(value) {
  return Boolean(value)
    && ['patternId', 'routeUid', 'routeName']
      .every((field) => typeof value[field] === 'string' && value[field].length > 0)
}

function validObservedStopFeature(value) {
  return Boolean(value?.properties)
    && typeof value.properties.stopUid === 'string'
    && value.properties.stopUid.length > 0
    && Number.isInteger(Number(value.properties.sequence))
    && Number(value.properties.sequence) >= 0
}

function validObservedStopPlace(value, city, stopUid) {
  return value?.schemaVersion === 1
    && value?.city === city
    && value?.stopUid === stopUid
    && typeof value?.place?.placeId === 'string'
    && value.place.placeId.length > 0
}

export function createPublicApiAdapter({
  baseUrl,
  fetchImpl = fetch,
  expensiveIntervalMs = PUBLIC_PROBE_EXPENSIVE_INTERVAL_MS,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  monotonic = () => Date.now(),
}) {
  if (!baseUrl) throw new Error('Missing public probe base URL')
  let lastExpensiveAt = null

  async function paced(path) {
    if (!EXPENSIVE_PATH.test(new URL(path, baseUrl).pathname)) return
    if (lastExpensiveAt !== null) {
      const wait = expensiveIntervalMs - (monotonic() - lastExpensiveAt)
      if (wait > 0) await sleep(wait)
    }
    lastExpensiveAt = monotonic()
  }

  async function request(path, init) {
    await paced(path)
    const response = await fetchImpl(new URL(path, baseUrl), {
      ...init,
      signal: AbortSignal.timeout(20_000),
      cache: 'no-store',
    })
    if (!response.ok) {
      const responseKind = publicProbeHttpResponseKind(response.headers.get('Content-Type'))
      await response.body?.cancel().catch(() => undefined)
      throw new PublicApiError(response.status, responseKind)
    }
    return response
  }

  return Object.freeze({
    async getJson(path) {
      return await readPublicProbeJson(await request(path), 2 * 1024 * 1024)
    },
    async postJson(path, body) {
      return await readPublicProbeJson(await request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }), 2 * 1024 * 1024)
    },
    async readPrefix(path, maximumBytes) {
      const response = await request(path, { headers: { Range: `bytes=0-${maximumBytes - 1}` } })
      return await readResponsePrefix(response, maximumBytes)
    },
  })
}

export async function readResponsePrefix(response, maximumBytes) {
  if (!response.body) throw new Error('Prefix response has no body')
  const reader = response.body.getReader()
  const chunks = []
  let bytes = 0
  try {
    while (bytes < maximumBytes) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      bytes += value.byteLength
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  const merged = new Uint8Array(Math.min(bytes, maximumBytes))
  let offset = 0
  for (const chunk of chunks) {
    const slice = chunk.subarray(0, Math.min(chunk.byteLength, merged.byteLength - offset))
    merged.set(slice, offset)
    offset += slice.byteLength
    if (offset >= merged.byteLength) break
  }
  return new TextDecoder().decode(merged)
}

export class PublicApiError extends Error {
  constructor(status, responseKind = 'missing') {
    super(`Public API responded ${status}`)
    this.status = status
    this.responseKind = HTTP_RESPONSE_KINDS.has(responseKind) ? responseKind : 'missing'
  }
}

export function publicProbeSummaryMarkdown(summary) {
  const groups = [
    ['Healthy (realtime sampled)', 'healthy'],
    ['Snapshot healthy (realtime not sampled)', 'snapshot_healthy'],
    ['Realtime degraded', 'realtime_degraded'],
    ['Hard failed', 'hard_failed'],
    ['Unknown', 'unknown'],
    ['Record write failed', 'record_write_failed'],
  ]
  return [
    '## Public network probe',
    '',
    `- Probe date: ${summary.probeDate} (Asia/Taipei)`,
    `- Evaluated at: ${summary.evaluatedAt}`,
    `- Realtime sampled: ${(summary.realtimeSampledCities ?? []).join(', ') || 'none'}`,
    '',
    '| City | Status | Active | Observed | Hard checks | Warnings | Failure | Latency |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...summary.results.map((item) => `| ${item.city} | ${item.status} | ${item.activeVersion ?? 'none'} | ${item.observedVersion ?? 'none'} | ${item.hardChecksPassed}/10 | ${item.realtimeWarnings.join(', ') || 'none'} | ${item.failureClass} | ${item.latencyBucket} |`),
    '',
    ...groups.map(([label, status]) => `- ${label}: ${summary.results.filter((item) => item.status === status).map((item) => item.city).join(', ') || 'none'}`),
    '',
  ].join('\n')
}

export function emitFailOpen(event, emitter) {
  try {
    emitter(event)
    return true
  } catch {
    return false
  }
}

async function writePublicProbeSummary(summary) {
  const markdown = publicProbeSummaryMarkdown(summary)
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown)
  console.log(JSON.stringify({
    message: 'public_probe_batch_completed',
    probeDate: summary.probeDate,
    realtimeSampledCities: summary.realtimeSampledCities ?? [],
    groups: Object.fromEntries(summary.results.map((item) => [item.city, item.status])),
  }))
}

function storeFromEnvironment(env, resources) {
  return createD1PublicProbeStore({
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: env.CLOUDFLARE_API_TOKEN,
    databaseId: env.TRANSIT_DATABASE_ID ?? resources.d1DatabaseId,
  })
}

function nullableString(value) {
  return value === undefined || value === null || String(value).trim() === '' ? null : String(value).trim()
}

function fullGitSha(value) {
  const text = nullableString(value)
  return text && /^[a-f0-9]{40}$/.test(text) ? text : null
}

function safeLog(message, city, probeRunIdValue) {
  console.error(JSON.stringify({ message, city, probeRunId: probeRunIdValue }))
}

async function main() {
  const plan = loadOperationsPlan()
  if (!plan.checks.publicProbe) {
    console.log(JSON.stringify({ message: 'instance_operation_disabled', operation: 'publicProbe' }))
    return
  }
  const resources = loadOperationalResources()
  const result = await runPublicProbe({
    store: storeFromEnvironment(process.env, resources),
    publicApi: createPublicApiAdapter({
      baseUrl: resolvePublicProbeBaseUrl({ env: process.env }),
    }),
    realtimeSampleSize: PUBLIC_PROBE_REALTIME_SAMPLE_SIZE,
    realtimeDetailEmitter: (event) => console.log(JSON.stringify(event)),
    routeSampleDetailEmitter: (event) => console.log(JSON.stringify(event)),
  })
  process.exitCode = result.ok ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
