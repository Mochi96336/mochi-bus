import { defaultCity, supportedCityCodes } from '../config'
import type { ApiErrorStatus } from '../presentation/api-error'
import {
  beginApiOperationTelemetry,
  type ApiOperationTracker,
} from './api-operation'
import { releaseIdentity } from './release-identity'
import type {
  TelemetryCity,
  TelemetryFailureClass,
  TelemetryOperation,
  TelemetryResult,
  TelemetrySource,
} from './telemetry'

type BusSourceOutcome = Readonly<{
  result: TelemetryResult
  source: TelemetrySource
}>

/**
 * Bus/setup APIs predate the map observability boundary. Keep their completion
 * telemetry on the same api_operation_completed contract instead of inventing a
 * second event shape just for snapshot fallback measurement.
 */
export function beginBusApiOperation(
  operation: TelemetryOperation,
  requestedCity: string | undefined,
  versionMetadata: CloudflareBindings['CF_VERSION_METADATA'] | undefined,
): ApiOperationTracker {
  const normalizedCity = requestedCity?.trim() || defaultCity
  const city = supportedCityCodes.has(normalizedCity)
    ? normalizedCity as TelemetryCity
    : null
  return beginApiOperationTelemetry({
    operation,
    city,
    trafficClass: 'user',
    releaseIdentity: releaseIdentity(versionMetadata),
  })
}

/**
 * Static setup reads have an exact authority split: active snapshot or legacy
 * TDX static discovery. A successful legacy read is still degraded relative to
 * the snapshot-first contract because it consumes the fallback path we want to
 * measure and eventually make rare.
 */
export function busStaticLookupOutcome(snapshotUsed: boolean, itemCount: number): BusSourceOutcome {
  if (snapshotUsed) {
    return { result: itemCount > 0 ? 'success' : 'empty', source: 'snapshot' }
  }
  return { result: itemCount > 0 ? 'degraded' : 'empty', source: 'tdx_static' }
}

/**
 * stop-routes combines snapshot static identity with optional realtime ETA, so
 * its snapshot path is mixed rather than pretending the whole response is
 * static. The legacy discovery branch remains an explicit fallback source.
 */
export function busStopRoutesOutcome(snapshotUsed: boolean, itemCount: number): BusSourceOutcome {
  if (snapshotUsed) {
    return { result: itemCount > 0 ? 'success' : 'empty', source: 'mixed' }
  }
  return { result: itemCount > 0 ? 'degraded' : 'empty', source: 'fallback' }
}

export function completeBusApiError(tracker: ApiOperationTracker, status: ApiErrorStatus): boolean {
  return tracker.complete({
    result: 'error',
    source: 'none',
    httpStatus: status,
    failureClass: busApiFailureClass(status),
  })
}

function busApiFailureClass(status: ApiErrorStatus): TelemetryFailureClass {
  if (status === 400 || status === 404) return 'input_validation'
  if (status === 401) return 'tdx_401'
  if (status === 429) return 'tdx_429'
  return 'unknown'
}
