import type {
  TelemetryFailureClass,
  TelemetryTdxOperation,
} from '../../observability/telemetry'
import {
  TDXServiceError,
  observeTDXResponseSuccess,
  transportFailureClass,
} from './error-classification'
import { dataCircuitKey, dataRateLimitCircuitKey } from './circuit-breaker'
import {
  TDXPayloadTooLargeError,
  logTDXResponseTooLarge,
  readJsonResponse,
  type TDXResponseObservation,
} from './bounded-response'

const DEFAULT_MAX_SINGLEFLIGHT_ENTRIES = 128

export type TDXUpstreamOutcome =
  | {
      ok: true
      data: unknown
      status: number
      receivedBytes: number
      declaredBytes?: number
      retryCount: number
      initialFailureClass?: TelemetryFailureClass
    }
  | {
      ok: false
      error: TDXServiceError
      retryCount: number
      initialFailureClass?: TelemetryFailureClass
    }

export type TDXUpstreamRequest = {
  url: URL
  maxResponseBytes: number
  operation?: TelemetryTdxOperation
  token: string
  isShared: boolean
  credentialKey: string
  ttlSeconds: number
  validatesPayload: boolean
}

export type TDXUpstreamResult = {
  outcome: TDXUpstreamOutcome
  leader: boolean
  circuitKey: string
  resource: string
}

export type TDXUpstreamUsageEvent = Readonly<{
  message: 'tdx_upstream_usage'
  operation: TelemetryTdxOperation | 'unclassified'
  resource: string
  scope: string
  credentialScope: 'shared' | 'byok'
  result: 'success' | 'http_error' | 'transport_error' | 'payload_error'
  status: number | null
  attempt: number
  receivedBytes: number | null
  declaredBytes: number | null
  failureClass: TelemetryFailureClass | 'none'
}>

export type TDXUpstreamDataClientDependencies = {
  requestTimeoutMs: number
  assertCircuitsClosed: (keys: readonly string[]) => void
  recordCircuitFailure: (key: string, error: TDXServiceError, retryAfter?: string | null) => void
  recordCircuitSuccess: (key: string) => void
  responseError: (
    context: string,
    response: Response,
    isShared: boolean,
    observation: Pick<TDXResponseObservation, 'operation' | 'resource'>,
  ) => Promise<TDXServiceError>
  fetcher?: typeof fetch
  maxSingleflightEntries?: number
  usageLogger?: (event: TDXUpstreamUsageEvent) => void
}

// Upstream data ownership lives here. This boundary owns request timeout, one-retry policy,
// response parsing and data singleflight. Availability circuits are scoped by operation and TDX
// service area. Credential-wide rate-limit/quota cooldown gates realtime requests, while static
// route/stop metadata remains available for degraded presentation and fallback station order.
export function createTDXUpstreamDataClient(dependencies: TDXUpstreamDataClientDependencies): {
  fetchUpstream: (request: TDXUpstreamRequest) => Promise<TDXUpstreamResult>
  resetTDXUpstreamState: () => void
} {
  const dataFlights = new Map<string, Promise<TDXUpstreamOutcome>>()
  const maxSingleflightEntries = dependencies.maxSingleflightEntries ?? DEFAULT_MAX_SINGLEFLIGHT_ENTRIES

  const fetchUpstream = async (request: TDXUpstreamRequest): Promise<TDXUpstreamResult> => {
    const resource = tdxResponseResource(request.url)
    const circuitKey = dataCircuitKey(
      request.credentialKey,
      request.operation ?? resource,
      tdxResponseScope(request.url),
    )
    const rateLimitCircuitKey = dataRateLimitCircuitKey(request.credentialKey)
    const observesCredentialCooldown = usesCredentialCooldown(request.operation, resource)
    const flightKey = dataFlightKey(request)
    const existingFlight = dataFlights.get(flightKey)
    if (!existingFlight) {
      dependencies.assertCircuitsClosed(observesCredentialCooldown
        ? [rateLimitCircuitKey, circuitKey]
        : [circuitKey])
    }

    const { promise, leader } = joinSingleflight(
      dataFlights,
      flightKey,
      maxSingleflightEntries,
      () => fetchTDXUpstream(
        request,
        circuitKey,
        rateLimitCircuitKey,
        resource,
        observesCredentialCooldown,
      ),
    )
    return {
      outcome: await promise,
      leader,
      circuitKey,
      resource,
    }
  }

  const fetchTDXUpstream = async (
    request: TDXUpstreamRequest,
    circuitKey: string,
    rateLimitCircuitKey: string,
    resource: string,
    observesCredentialCooldown: boolean,
  ): Promise<TDXUpstreamOutcome> => {
    let retryCount = 0
    let initialFailureClass: TelemetryFailureClass | undefined

    const observeUsage = (
      result: TDXUpstreamUsageEvent['result'],
      details: Pick<TDXUpstreamUsageEvent, 'status' | 'receivedBytes' | 'declaredBytes' | 'failureClass'>,
    ) => {
      const event: TDXUpstreamUsageEvent = Object.freeze({
        message: 'tdx_upstream_usage',
        operation: request.operation ?? 'unclassified',
        resource,
        scope: tdxResponseScope(request.url),
        credentialScope: request.isShared ? 'shared' : 'byok',
        result,
        status: details.status,
        attempt: retryCount + 1,
        receivedBytes: details.receivedBytes,
        declaredBytes: details.declaredBytes,
        failureClass: details.failureClass,
      })
      try {
        if (dependencies.usageLogger) dependencies.usageLogger(event)
        else console.info(JSON.stringify(event))
      } catch {
        // Quota observability is fail-open and must never affect upstream resolution.
      }
    }

    while (true) {
      let response: Response
      try {
        response = await (dependencies.fetcher ?? fetch)(request.url, {
          headers: { Authorization: `Bearer ${request.token}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(dependencies.requestTimeoutMs),
        })
      } catch (error) {
        const serviceError = new TDXServiceError('TDX request failed', undefined, {
          cause: error,
          failureKind: transportFailureClass(error),
        })
        observeUsage('transport_error', {
          status: null,
          receivedBytes: null,
          declaredBytes: null,
          failureClass: serviceError.failureKind ?? 'unknown',
        })
        if (shouldRetryResolution(serviceError, request.operation, retryCount)) {
          retryCount += 1
          initialFailureClass = serviceError.failureKind
          continue
        }
        // A transport failure cannot confirm a credential cooldown. Release a half-open realtime
        // credential probe and let the scoped availability circuit own the failure.
        if (observesCredentialCooldown) dependencies.recordCircuitSuccess(rateLimitCircuitKey)
        dependencies.recordCircuitFailure(circuitKey, serviceError)
        return { ok: false, error: serviceError, retryCount, initialFailureClass }
      }

      if (!response.ok) {
        const error = await dependencies.responseError('TDX request failed', response, request.isShared, {
          operation: request.operation,
          resource,
        })
        observeUsage('http_error', {
          status: response.status,
          receivedBytes: null,
          declaredBytes: responseContentLength(response),
          failureClass: error.failureKind ?? 'unknown',
        })
        if (error.rateLimited) dependencies.recordCircuitSuccess(circuitKey)
        else if (observesCredentialCooldown) dependencies.recordCircuitSuccess(rateLimitCircuitKey)
        if (shouldRetryResolution(error, request.operation, retryCount)) {
          retryCount += 1
          initialFailureClass = error.failureKind
          continue
        }
        const failureKey = error.rateLimited ? rateLimitCircuitKey : circuitKey
        dependencies.recordCircuitFailure(failureKey, error, response.headers.get('Retry-After'))
        return { ok: false, error, retryCount, initialFailureClass }
      }
      observeTDXResponseSuccess(request.isShared)
      if (observesCredentialCooldown) dependencies.recordCircuitSuccess(rateLimitCircuitKey)

      try {
        const parsed = await readJsonResponse(response, request.maxResponseBytes)
        observeUsage('success', {
          status: response.status,
          receivedBytes: parsed.receivedBytes,
          declaredBytes: parsed.declaredBytes ?? null,
          failureClass: 'none',
        })
        return {
          ok: true,
          data: parsed.data,
          status: response.status,
          receivedBytes: parsed.receivedBytes,
          declaredBytes: parsed.declaredBytes,
          retryCount,
          initialFailureClass,
        }
      } catch (error) {
        const serviceError = error instanceof TDXPayloadTooLargeError
          ? error
          : new TDXServiceError('TDX response is invalid JSON', 502, {
              cause: error,
              failureKind: 'invalid_json',
            })
        observeUsage('payload_error', {
          status: response.status,
          receivedBytes: serviceError instanceof TDXPayloadTooLargeError
            ? serviceError.receivedBytes ?? null
            : null,
          declaredBytes: serviceError instanceof TDXPayloadTooLargeError
            ? serviceError.declaredBytes ?? responseContentLength(response)
            : responseContentLength(response),
          failureClass: serviceError.failureKind ?? 'unknown',
        })
        if (serviceError instanceof TDXPayloadTooLargeError) {
          dependencies.recordCircuitSuccess(circuitKey)
          logTDXResponseTooLarge(serviceError, {
            operation: request.operation,
            resource,
            credentialScope: request.isShared ? 'shared' : 'byok',
          })
        } else {
          dependencies.recordCircuitFailure(circuitKey, serviceError)
        }
        return { ok: false, error: serviceError, retryCount, initialFailureClass }
      }
    }
  }

  return {
    fetchUpstream,
    resetTDXUpstreamState: () => dataFlights.clear(),
  }
}

function dataFlightKey(request: TDXUpstreamRequest): string {
  return [
    request.credentialKey,
    request.operation ?? 'default',
    request.maxResponseBytes,
    request.ttlSeconds,
    request.validatesPayload ? 'validated' : 'unvalidated',
    request.url.toString(),
  ].join('\0')
}

function joinSingleflight<T>(
  flights: Map<string, Promise<T>>,
  key: string,
  maxEntries: number,
  create: () => Promise<T>,
): { promise: Promise<T>; leader: boolean } {
  const existing = flights.get(key)
  if (existing) return { promise: existing, leader: false }

  const promise = create()
  if (flights.size < maxEntries) {
    flights.set(key, promise)
    void promise.finally(() => {
      if (flights.get(key) === promise) flights.delete(key)
    }).catch(() => undefined)
  }
  return { promise, leader: true }
}

function shouldRetryResolution(
  error: TDXServiceError,
  operation: TelemetryTdxOperation | undefined,
  retryCount: number,
): boolean {
  return Boolean(operation)
    && retryCount === 0
    && (error.failureKind === 'timeout'
      || error.failureKind === 'network_error'
      || error.failureKind === 'upstream_5xx')
}

function usesCredentialCooldown(
  operation: TelemetryTdxOperation | undefined,
  resource: string,
): boolean {
  return operation === 'place_arrivals'
    || operation === 'vehicle_positions'
    || operation === 'journey_eta'
    || resource === 'EstimatedTimeOfArrival'
    || resource === 'RealTimeByFrequency'
    || resource === 'Vehicle'
}

function tdxResponseResource(url: URL): string {
  const segments = url.pathname.split('/').filter(Boolean)
  const busIndex = segments.indexOf('Bus')
  const resource = busIndex >= 0 ? segments[busIndex + 1] : undefined
  return resource && [
    'EstimatedTimeOfArrival',
    'RealTimeByFrequency',
    'Route',
    'Schedule',
    'Shape',
    'Stop',
    'StopOfRoute',
    'Vehicle',
  ].includes(resource)
    ? resource
    : 'other'
}

function tdxResponseScope(url: URL): string {
  const segments = url.pathname.split('/').filter(Boolean)
  const busIndex = segments.indexOf('Bus')
  const scopeType = busIndex >= 0 ? segments[busIndex + 2] : undefined
  if (scopeType === 'City' && segments[busIndex + 3]) return `City/${segments[busIndex + 3]}`
  if (scopeType === 'InterCity') return 'InterCity'
  return 'global'
}

function responseContentLength(response: Response): number | null {
  const value = response.headers.get('Content-Length')
  if (value === null) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}
