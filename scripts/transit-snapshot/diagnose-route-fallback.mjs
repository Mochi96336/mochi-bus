import { loadOperationalResources } from '../instance/operational-resources.mjs'
import {
  deterministicPublicCaseIndex,
  PUBLIC_PROBE_CASE_VERSION,
  publicSampleCaseId,
} from './public-probe-contract.mjs'
import { createD1PublicProbeStore } from './public-probe-d1.mjs'
import { resolvePublicProbeBaseUrl } from './public-probe-origin.mjs'
import { taipeiDate } from './snapshot-schedule.mjs'

const CITY = 'Hsinchu'
const ATTEMPTS = 4
const FALLBACK_REASONS = new Set([
  'manifest_missing',
  'manifest_read_failed',
  'routing_authority_incomplete',
  'routing_authority_invalid',
  'r2',
])

const resources = loadOperationalResources()
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim()
const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim()
if (!accountId || !apiToken) throw new Error('Missing route fallback diagnostic D1 credentials')

const store = createD1PublicProbeStore({
  accountId,
  apiToken,
  databaseId: process.env.TRANSIT_DATABASE_ID?.trim() || resources.d1DatabaseId,
})
const probeDate = taipeiDate(new Date())
const reference = await store.readReference(CITY)
if (!reference?.activeVersion || !reference.counts || reference.counts.sampleCount < 1) {
  throw new Error('Hsinchu public probe reference is unavailable')
}
const sampleIndex = deterministicPublicCaseIndex(
  CITY,
  probeDate,
  PUBLIC_PROBE_CASE_VERSION,
  reference.counts.sampleCount,
)
const sample = await store.readSample(CITY, reference.activeVersion, sampleIndex)
if (!sample?.routeName) throw new Error('Hsinchu public probe sample is unavailable')

const baseUrl = resolvePublicProbeBaseUrl({ env: process.env })
const sampleCaseId = publicSampleCaseId(CITY, probeDate, PUBLIC_PROBE_CASE_VERSION)

for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
  const url = new URL('/api/v1/map/route', baseUrl)
  url.searchParams.set('city', CITY)
  url.searchParams.set('route', sample.routeName)
  url.searchParams.set('_diagnosticAttempt', String(attempt))

  let response
  try {
    response = await fetch(url, {
      cache: 'no-store',
      signal: AbortSignal.timeout(20_000),
    })
    const rawFallbackReason = response.headers.get('X-Mochi-Snapshot-Fallback-Reason')
    const fallbackReason = rawFallbackReason && FALLBACK_REASONS.has(rawFallbackReason)
      ? rawFallbackReason
      : null
    console.log(JSON.stringify({
      message: 'route_fallback_diagnostic',
      city: CITY,
      sampleCaseId,
      attempt,
      httpStatusClass: statusClass(response.status),
      responseKind: responseKind(response.headers.get('content-type')),
      fallbackReason,
    }))
  } catch (error) {
    console.log(JSON.stringify({
      message: 'route_fallback_diagnostic',
      city: CITY,
      sampleCaseId,
      attempt,
      httpStatusClass: 'none',
      responseKind: 'missing',
      fallbackReason: null,
      requestFailure: requestFailure(error),
    }))
  } finally {
    await response?.body?.cancel().catch(() => undefined)
  }
  if (attempt < ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 500))
}

function statusClass(status) {
  return Number.isInteger(status) && status >= 100 && status <= 599
    ? `${Math.floor(status / 100)}xx`
    : 'none'
}

function responseKind(value) {
  const mediaType = String(value ?? '').split(';', 1)[0].trim().toLowerCase()
  if (!mediaType) return 'missing'
  if (mediaType === 'application/json' || mediaType.endsWith('+json')) return 'json'
  if (mediaType === 'text/html' || mediaType === 'application/xhtml+xml') return 'html'
  return 'other'
}

function requestFailure(error) {
  const name = error instanceof Error ? error.name : ''
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout'
  if (error instanceof TypeError) return 'network_failure'
  return 'unknown'
}
