import { tdxWarningMessages, type TDXWarning } from '../domain/tdx-warning'
import { getSnapshotSchedule } from '../infrastructure/transit/snapshot-repository'
import {
  TDXServiceError,
  classifyTDXWarning,
  isRejectedUserTdxToken,
  observeTDXResponseFailure,
  resetTDXRateLimitTracking,
  responseFailureClass,
  tdxWarningFromError,
} from './tdx/error-classification'
import {
  createTDXTokenClient,
  tdxCredentialScope,
  withUserTDXAccessToken,
  type TDXCredentialEnv,
} from './tdx/token-client'
import {
  createTDXCircuitBreaker,
  redactedCircuitKey,
} from './tdx/circuit-breaker'
import {
  TDX_ERROR_MAX_RESPONSE_BYTES,
  TDXPayloadTooLargeError,
  logTDXResponseSize,
  logTDXResponseTooLarge,
  parsedContentLength,
  readJsonResponse,
  readTextResponse,
  type TDXBoundedTextResponse,
  type TDXResponseObservation,
} from './tdx/bounded-response'
import { createTDXUpstreamDataClient } from './tdx/upstream-data-client'
import {
  createTDXResolutionCache,
  withTDXBackgroundTasks,
  type TDXEnv,
  type TDXResolutionOptions,
  type TDXResolvedData,
} from './tdx/resolution-cache'
import { createTDXBusRouteQueries } from './tdx/bus-route-queries'
import { createTDXCommuteRoutePresentation } from './tdx/commute-route-presentation'
import { tdxRealtimeCacheSeconds } from './tdx/realtime-cache-policy'
import { createTDXScheduleEndpoint, tdxTelemetryCity } from './tdx/schedule-endpoint'

export { formatETALabel, formatStopStatus, toETAResult } from './tdx/eta-formatting'
export type { BusETAItem, ETAResult } from './tdx/eta-formatting'
export {
  TDXServiceError,
  isRejectedUserTdxToken,
  resetTDXRateLimitTracking,
  tdxWarningFromError,
}
export { tdxCredentialScope, withUserTDXAccessToken } from './tdx/token-client'
export { withTDXBackgroundTasks }
export type { TDXEnv, TDXResolutionOptions, TDXResolvedData }
export {
  QueryResolutionError,
  mergeEquivalentStopGroups,
  tdxRouteScope,
} from './tdx/bus-route-queries'
export type {
  RouteCatalogItem,
  RouteStop,
  StopGroup,
  StopRouteSuggestion,
} from './tdx/bus-route-queries'
export type {
  RouteDetail,
  RouteDetailWithEtaStates,
  RouteEtaTone,
} from './tdx/commute-route-presentation'
export { isTDXRecordArray } from './tdx/schedule-endpoint'

export { tdxWarningMessages }
export type { TDXWarning }

// TDX 的 429 body 會說明是頻率超限還是額度用盡,記進 log 供事後判讀;內容絕不回給使用者。
// isShared 只有共用憑證的請求才是 true,決定這次結果要不要更新額度追蹤狀態。
async function tdxResponseError(
  context: string,
  response: Response,
  isShared: boolean,
  observation: Pick<TDXResponseObservation, 'operation' | 'resource'>,
): Promise<TDXServiceError> {
  const body: TDXBoundedTextResponse = await readTextResponse(
    response,
    TDX_ERROR_MAX_RESPONSE_BYTES,
    true,
  ).catch((): TDXBoundedTextResponse => ({
    text: '',
    receivedBytes: 0,
    declaredBytes: parsedContentLength(response.headers.get('Content-Length')),
    truncated: false,
  }))
  if (body.truncated) {
    console.error(JSON.stringify({
      message: 'tdx_error_body_truncated',
      operation: observation.operation ?? 'unclassified',
      resource: observation.resource,
      credentialScope: isShared ? 'shared' : 'byok',
      status: response.status,
      maxBytes: TDX_ERROR_MAX_RESPONSE_BYTES,
      receivedBytes: body.receivedBytes,
      declaredBytes: body.declaredBytes ?? null,
      sizeSource: body.limitSource ?? 'stream',
    }))
  }
  const warning = classifyTDXWarning(response.status, body.text)
  observeTDXResponseFailure(response.status, warning, isShared)
  console.error(JSON.stringify({
    message: 'tdx_upstream_error',
    context,
    status: response.status,
  }))
  const error = new TDXServiceError(`${context} (${response.status})`, response.status, {
    failureKind: responseFailureClass(response.status, warning),
  })
  error.warning = warning
  return error
}

// 測試用：模擬 isolate 重建，避免模組層快取讓案例彼此污染。
export function resetTDXTestState(): void {
  resetTDXRateLimitTracking()
  resetTDXTokenState()
  circuitBreaker.reset()
  upstreamDataClient.resetTDXUpstreamState()
}

const REQUEST_TIMEOUT_MS = 6000
const circuitBreaker = createTDXCircuitBreaker({
  onOpened: ({ key, warning, openMs }) => {
    console.error(JSON.stringify({
      message: 'tdx_circuit_opened',
      key: redactedCircuitKey(key),
      warning,
      openMs,
    }))
  },
})

const tokenClient = createTDXTokenClient({
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
  assertCircuitClosed: (key) => { circuitBreaker.assertClosed(key) },
  recordCircuitFailure: (key, error, retryAfter) => circuitBreaker.recordFailure(key, error, retryAfter),
  recordCircuitSuccess: circuitBreaker.recordSuccess,
  responseError: (context, response, isShared, observation) => (
    tdxResponseError(context, response, isShared, observation)
  ),
  readJsonResponse,
  isPayloadTooLargeError: (error): error is TDXServiceError => error instanceof TDXPayloadTooLargeError,
  logResponseTooLarge: (error, observation) => (
    logTDXResponseTooLarge(error as TDXPayloadTooLargeError, observation)
  ),
  logResponseSize: logTDXResponseSize,
})

export const getTDXToken = tokenClient.getTDXToken
const resetTDXTokenState = tokenClient.resetTDXTokenState

const upstreamDataClient = createTDXUpstreamDataClient({
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
  assertCircuitsClosed: (keys) => { circuitBreaker.assertAllClosed(keys) },
  recordCircuitFailure: (key, error, retryAfter) => circuitBreaker.recordFailure(key, error, retryAfter),
  recordCircuitSuccess: circuitBreaker.recordSuccess,
  responseError: (context, response, isShared, observation) => (
    tdxResponseError(context, response, isShared, observation)
  ),
})

const resolutionCache = createTDXResolutionCache({
  getTDXToken,
  fetchUpstream: upstreamDataClient.fetchUpstream,
  recordCircuitFailure: (key, error) => circuitBreaker.recordFailure(key, error),
  recordCircuitSuccess: circuitBreaker.recordSuccess,
})

export const fetchTDXJson = <T>(env: TDXEnv, url: URL, ttlSeconds: number, options?: TDXResolutionOptions<T>): Promise<T> => resolutionCache.fetchTDXJson(env, url, tdxRealtimeCacheSeconds(url, ttlSeconds, Boolean(env.TDX_USER_ACCESS_TOKEN)), options)
export const resolveTDXJson = <T>(env: TDXEnv, url: URL, ttlSeconds: number, options?: TDXResolutionOptions<T>): Promise<TDXResolvedData<T>> => resolutionCache.resolveTDXJson(env, url, tdxRealtimeCacheSeconds(url, ttlSeconds, Boolean(env.TDX_USER_ACCESS_TOKEN)), options)
const busRouteQueries = createTDXBusRouteQueries({
  fetchTDXJson,
  telemetryCity: tdxTelemetryCity,
})

export const resolveBusQuery = busRouteQueries.resolveBusQuery
export const getRouteStopGroups = busRouteQueries.getRouteStopGroups
export const getRouteCatalog = busRouteQueries.getRouteCatalog
export const getStopRouteSuggestions = busRouteQueries.getStopRouteSuggestions

const scheduleEndpoint = createTDXScheduleEndpoint({ fetchTDXJson })
export const getBusSchedule = scheduleEndpoint.getBusSchedule

const commuteRoutePresentation = createTDXCommuteRoutePresentation({
  fetchTDXJson,
  getRouteStopGroups: busRouteQueries.getRouteStopGroups,
  getBusSchedule,
  getSnapshotSchedule: (env, city, routeName, routeUid) => (
    getSnapshotSchedule(env, city, routeName, routeUid)
  ),
  now: () => new Date(),
})

export const getCommuteETA = commuteRoutePresentation.getCommuteETA
export const getRouteDetail = commuteRoutePresentation.getRouteDetail
