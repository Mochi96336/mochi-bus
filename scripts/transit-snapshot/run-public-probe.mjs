import { appendFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { loadOperationalResources } from '../instance/operational-resources.mjs'
import { loadOperationsPlan } from '../instance/operations-plan.mjs'
import { readBoundedResponseJson } from './active-probe.mjs'
import { resolvePublicProbeBaseUrl } from './public-probe-origin.mjs'
import { enabledSnapshotCitiesInScheduleOrder, taipeiDate } from './snapshot-schedule.mjs'
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
// The expensive rate-limit bucket allows 30 requests/minute per IP. Each city
// makes three expensive calls (arrivals, network, journey), so pacing them
// keeps a full enabled-city sweep well under the limit.
export const PUBLIC_PROBE_EXPENSIVE_INTERVAL_MS = 2_500

const HEALTHY_STATUSES = new Set(['healthy', 'realtime_degraded'])
const EXPENSIVE_PATH = /^\/api\/v1\/map\/(?:network|journey-eta$|place\/[^/]+\/arrivals)/

export async function runPublicProbe({
  env = process.env,
  now = () => new Date(),
  monotonic = () => performance.now(),
  store,
  publicApi,
  cities = PUBLIC_PROBE_CITIES,
  emitter = (event) => console.log(JSON.stringify(event)),
  summaryWriter = writePublicProbeSummary,
}) {
  const evaluatedAt = now().toISOString()
  const probeDate = taipeiDate(new Date(evaluatedAt))
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
      result = await probePublicSurface({ city, probeDate, reference, publicApi, now })
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

async function readCityReference(store, city, probeDate) {
  const base = await store.readReference(city)
  if (!base?.activeVersion || !base.counts || base.counts.sampleCount < 1) {
    return Object.freeze({ ...base, sample: null })
  }
  const index = deterministicPublicCaseIndex(city, probeDate, PUBLIC_PROBE_CASE_VERSION, base.counts.sampleCount)
  const sample = await store.readSample(city, base.activeVersion, index)
  return Object.freeze({ ...base, sample })
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
      await response.body?.cancel().catch(() => undefined)
      throw new PublicApiError(response.status)
    }
    return response
  }

  return Object.freeze({
    async getJson(path) {
      return await readBoundedResponseJson(await request(path), 2 * 1024 * 1024)
    },
    async postJson(path, body) {
      return await readBoundedResponseJson(await request(path, {
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
  constructor(status) {
    super(`Public API responded ${status}`)
    this.status = status
  }
}

export function publicProbeSummaryMarkdown(summary) {
  const groups = [
    ['Healthy', 'healthy'],
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
  })
  process.exitCode = result.ok ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
