import type { Context } from 'hono'
import { enabledCityCodes } from '../config'
import { CityNotEnabledError, CITY_NOT_ENABLED_CODE } from '../domain/city-availability'
import { QueryValidationError } from '../domain/bus-query'
import {
  TDX_ACCESS_TOKEN_REJECTED_CODE,
  TDX_ACCESS_TOKEN_REJECTED_MESSAGE,
} from '../domain/tdx-api-error'
import type { TransitBindings } from '../infrastructure/transit/snapshot-repository'
import {
  ApiInputError,
  apiInputErrorBody,
  parseTdxAccessToken,
} from '../lib/api-input'
import {
  isRejectedUserTdxToken,
  TDXServiceError,
  withTDXBackgroundTasks,
  withUserTDXAccessToken,
  type TDXEnv,
} from '../lib/tdx'
import {
  beginApiOperationTelemetry,
  type ApiOperationTracker,
} from '../observability/api-operation'
import { mapOperationErrorOutcome } from '../observability/map-api-outcomes'
import { releaseIdentity } from '../observability/release-identity'
import type {
  TelemetryCity,
  TelemetryFailureClass,
  TelemetryOperation,
} from '../observability/telemetry'

export type MapBindings = TDXEnv & TransitBindings & Pick<CloudflareBindings, 'CF_VERSION_METADATA'>

export type MapEnv = {
  Bindings: MapBindings
}

// Browser clients exchange credentials directly with TDX; the Worker receives only a short-lived token.
export function tdxEnv(c: Context<MapEnv>): MapBindings {
  const env = withUserTDXAccessToken(c.env, parseTdxAccessToken(c.req.header('Authorization')))
  try {
    const executionCtx = c.executionCtx
    return withTDXBackgroundTasks(env, (promise) => executionCtx.waitUntil(promise))
  } catch {
    return env
  }
}

export function telemetryCity(value: string | undefined): TelemetryCity | null {
  return value && enabledCityCodes.has(value) ? value as TelemetryCity : null
}

export function beginMapOperation(
  c: Context<MapEnv>,
  operation: TelemetryOperation,
  city: TelemetryCity | null,
): ApiOperationTracker {
  return beginApiOperationTelemetry({
    operation,
    city,
    trafficClass: 'user',
    releaseIdentity: releaseIdentity(c.env?.CF_VERSION_METADATA),
  })
}

function mapFailureClass(error: unknown, authorization?: string): TelemetryFailureClass {
  if (error instanceof QueryValidationError || error instanceof ApiInputError) return 'input_validation'
  if (isRejectedUserTdxToken(error, authorization)) return 'tdx_401'
  if (!(error instanceof TDXServiceError)) return 'unknown'
  if (error.status === 401) return 'tdx_401'
  if (error.warning === 'tdx-quota') return 'tdx_quota'
  if (error.status === 429 || error.warning === 'tdx-rate-limit') return 'tdx_429'
  if (error.status !== undefined && error.status >= 500) return 'tdx_5xx'
  const causeName = error.cause instanceof Error ? error.cause.name : ''
  if (causeName === 'AbortError' || causeName === 'TimeoutError') return 'tdx_timeout'
  return error.status === undefined ? 'network' : 'unknown'
}

// Endpoint handlers own fallback and degradation; this helper presents only terminal errors.
export function completeMapError(
  c: Context<MapEnv>,
  tracker: ApiOperationTracker,
  error: unknown,
  fallback: string,
  city?: TelemetryCity | null,
) {
  const response = mapJsonError(c, error, fallback)
  tracker.complete({
    ...mapOperationErrorOutcome(mapFailureClass(error, c.req.header('Authorization'))),
    httpStatus: response.status,
    ...(city === undefined ? {} : { city }),
  })
  return response
}

export function mapJsonError(c: Context<MapEnv>, error: unknown, fallback: string) {
  if (error instanceof ApiInputError) {
    return c.json(apiInputErrorBody(error), error.status, { 'Cache-Control': 'no-store' })
  }
  if (error instanceof CityNotEnabledError) {
    return c.json({ code: CITY_NOT_ENABLED_CODE, error: error.message }, 404, {
      'Cache-Control': 'no-store',
    })
  }
  if (isRejectedUserTdxToken(error, c.req.header('Authorization'))) {
    return c.json({
      code: TDX_ACCESS_TOKEN_REJECTED_CODE,
      error: TDX_ACCESS_TOKEN_REJECTED_MESSAGE,
    }, 401, { 'Cache-Control': 'no-store' })
  }
  const isQueryError = error instanceof QueryValidationError
  return c.json({ error: isQueryError ? error.message : fallback }, isQueryError ? 400 : 502, {
    'Cache-Control': 'no-store',
  })
}
