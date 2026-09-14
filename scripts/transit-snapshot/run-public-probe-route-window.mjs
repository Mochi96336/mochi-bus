import { pathToFileURL } from 'node:url'
import { loadOperationalResources } from '../instance/operational-resources.mjs'
import { loadOperationsPlan } from '../instance/operations-plan.mjs'
import { resolvePublicProbeBaseUrl } from './public-probe-origin.mjs'
import { createD1PublicProbeStore } from './public-probe-d1.mjs'
import { readPublicProbeJson } from './public-probe-response.mjs'
import {
  createPublicApiAdapter,
  PUBLIC_PROBE_REALTIME_SAMPLE_SIZE,
  PublicApiError,
  runPublicProbe,
} from './run-public-probe.mjs'

const ROUTE_PATH = '/api/v1/map/route'
export const ROUTE_RESPONSE_MAX_BYTES = 4 * 1024 * 1024

export function createRouteWindowPublicApi({
  baseUrl,
  fetchImpl = fetch,
  expensiveIntervalMs,
  sleep,
  monotonic,
}) {
  const base = createPublicApiAdapter({
    baseUrl,
    fetchImpl,
    ...(expensiveIntervalMs === undefined ? {} : { expensiveIntervalMs }),
    ...(sleep === undefined ? {} : { sleep }),
    ...(monotonic === undefined ? {} : { monotonic }),
  })

  return Object.freeze({
    ...base,
    async getJson(path) {
      if (new URL(path, baseUrl).pathname !== ROUTE_PATH) return await base.getJson(path)
      const response = await fetchImpl(new URL(path, baseUrl), {
        signal: AbortSignal.timeout(20_000),
        cache: 'no-store',
      })
      if (!response.ok) {
        const responseKind = publicResponseKind(response.headers.get('Content-Type'))
        await response.body?.cancel().catch(() => undefined)
        throw new PublicApiError(response.status, responseKind)
      }
      return await readPublicProbeJson(response, ROUTE_RESPONSE_MAX_BYTES)
    },
  })
}

function publicResponseKind(value) {
  if (typeof value !== 'string' || value.trim() === '') return 'missing'
  const mediaType = value.split(';', 1)[0].trim().toLowerCase()
  if (mediaType === 'application/json' || mediaType.endsWith('+json')) return 'json'
  if (mediaType === 'text/html' || mediaType === 'application/xhtml+xml') return 'html'
  return 'other'
}

function storeFromEnvironment(env, resources) {
  return createD1PublicProbeStore({
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: env.CLOUDFLARE_API_TOKEN,
    databaseId: env.TRANSIT_DATABASE_ID ?? resources.d1DatabaseId,
  })
}

async function main() {
  const plan = loadOperationsPlan()
  if (!plan.checks.publicProbe) {
    console.log(JSON.stringify({ message: 'instance_operation_disabled', operation: 'publicProbe' }))
    return
  }
  const resources = loadOperationalResources()
  const baseUrl = resolvePublicProbeBaseUrl({ env: process.env })
  const result = await runPublicProbe({
    store: storeFromEnvironment(process.env, resources),
    publicApi: createRouteWindowPublicApi({ baseUrl }),
    realtimeSampleSize: PUBLIC_PROBE_REALTIME_SAMPLE_SIZE,
    realtimeDetailEmitter: (event) => console.log(JSON.stringify(event)),
    routeSampleDetailEmitter: (event) => console.log(JSON.stringify(event)),
  })
  process.exitCode = result.ok ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
