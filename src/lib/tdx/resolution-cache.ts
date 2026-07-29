import { cacheMatchFailOpen, cachePutFailOpen, type BackgroundTaskScheduler } from '../edge-cache'
import { memoryCacheGet, memoryCacheSet } from '../memory-cache'
import { releaseIdentity } from '../../observability/release-identity'
import { beginTDXResolutionTelemetry } from '../../observability/tdx-resolution'
import type {
  TelemetryCity,
  TelemetryFailureClass,
  TelemetrySink,
  TelemetryTdxOperation,
  TelemetryTrafficClass,
} from '../../observability/telemetry'
import {
  TDXServiceError,
  asTDXServiceError,
} from './error-classification'
import {
  logTDXResponseSize,
  readJsonResponse,
  responseByteLimit,
} from './bounded-response'
import type {
  TDXCredentialEnv,
  TDXTokenResult,
} from './token-client'
import type {
  TDXUpstreamRequest,
  TDXUpstreamResult,
} from './upstream-data-client'

export type TDXTelemetryContext = {
  trafficClass?: TelemetryTrafficClass
  sampleProbability?: number
  now?: () => number
  random?: () => number
  emitter?: TelemetrySink
}

export type TDXEnv = TDXCredentialEnv & {
  TDX_BACKGROUND_TASKS?: BackgroundTaskScheduler
  CF_VERSION_METADATA?: CloudflareBindings['CF_VERSION_METADATA']
  TDX_TELEMETRY?: TDXTelemetryContext
}

export type TDXResolutionOptions<T> = {
  operation?: TelemetryTdxOperation
  city?: TelemetryCity | null
  validate?: (value: unknown) => value is T
  staleFallback?: (error: TDXServiceError) => Promise<{ data: T; dataAgeMilliseconds?: number } | undefined>
  blockedFailureClass?: TelemetryFailureClass
  maxResponseBytes?: number
}

export type TDXResolvedData<T> = {
  data: T
  resolution: 'memory' | 'edge' | 'upstream' | 'stale_replay'
  degraded: boolean
}

export type TDXResolutionCacheDependencies = {
  getTDXToken: (env: TDXCredentialEnv) => Promise<TDXTokenResult>
  fetchUpstream: (request: TDXUpstreamRequest) => Promise<TDXUpstreamResult>
  recordCircuitFailure: (key: string, error: TDXServiceError) => void
  recordCircuitSuccess: (key: string) => void
}

type TDXCacheEntry<T> = { data: T; cachedAt?: number }

// Logical resolution ownership lives here. This boundary chooses memory, edge, upstream or stale data,
// validates endpoint schemas, completes resolution telemetry and owns cache identity/writes. It never
// owns credential state or HTTP retry; token, bounded parsing and circuit transitions remain delegated.
export function createTDXResolutionCache(dependencies: TDXResolutionCacheDependencies): {
  fetchTDXJson: <T>(
    env: TDXEnv,
    url: URL,
    ttlSeconds: number,
    options?: TDXResolutionOptions<T>,
  ) => Promise<T>
  resolveTDXJson: <T>(
    env: TDXEnv,
    url: URL,
    ttlSeconds: number,
    options?: TDXResolutionOptions<T>,
  ) => Promise<TDXResolvedData<T>>
} {
  const resolveTDXJson = async <T>(
    env: TDXEnv,
    url: URL,
    ttlSeconds: number,
    options: TDXResolutionOptions<T> = {},
  ): Promise<TDXResolvedData<T>> => {
    const now = telemetryNow(env)
    const maxResponseBytes = responseByteLimit(options.maxResponseBytes)
    const credentialScope = env.TDX_USER_ACCESS_TOKEN ? 'byok' as const : 'shared' as const
    const tracker = options.operation ? beginTDXResolutionTelemetry({
      tdxOperation: options.operation,
      credentialScope,
      city: options.city ?? null,
      trafficClass: env.TDX_TELEMETRY?.trafficClass ?? 'user',
      releaseIdentity: releaseIdentity(env.CF_VERSION_METADATA),
      sampleProbability: env.TDX_TELEMETRY?.sampleProbability,
      now: env.TDX_TELEMETRY?.now,
      random: env.TDX_TELEMETRY?.random,
      emitter: env.TDX_TELEMETRY?.emitter,
    }) : undefined
    let retryCount = 0
    let initialFailureClass: TelemetryFailureClass | undefined

    const completeData = (
      data: T,
      resolution: TDXResolvedData<T>['resolution'],
      dataAgeMilliseconds: number | undefined,
      upstreamStatus?: number,
    ): TDXResolvedData<T> => {
      tracker?.complete({
        resolution,
        result: isEmptyPayload(data) ? 'empty' : resolution === 'stale_replay' ? 'degraded' : 'success',
        failureClass: resolution === 'stale_replay' ? initialFailureClass ?? 'unknown' : 'none',
        initialFailureClass,
        retryCount,
        dataAgeMilliseconds,
        upstreamStatus,
      })
      return { data, resolution, degraded: resolution === 'stale_replay' }
    }

    const finishFailure = async (
      error: TDXServiceError,
      attemptedUpstream: boolean,
    ): Promise<TDXResolvedData<T>> => {
      const failureClass = error.failureKind ?? 'unknown'
      if (options.staleFallback) {
        try {
          const stale = await options.staleFallback(error)
          if (stale !== undefined && !isEmptyPayload(stale.data)) {
            initialFailureClass ??= failureClass
            return completeData(
              stale.data,
              'stale_replay',
              stale.dataAgeMilliseconds,
              attemptedUpstream ? error.status : undefined,
            )
          }
        } catch {
          // Stale fallback is fail-open for the original TDX failure; it never replaces the cause.
        }
      }
      tracker?.complete({
        resolution: failureClass === 'circuit_open' ? 'circuit_open' : attemptedUpstream ? 'upstream' : 'none',
        result: 'error',
        failureClass,
        initialFailureClass,
        retryCount,
        dataAgeMilliseconds: null,
        upstreamStatus: attemptedUpstream ? error.status : undefined,
      })
      throw error
    }

    const memoryKey = `tdx/${maxResponseBytes ?? 'unbounded'}/${url.toString()}`
    const memoized = memoryCacheGet<TDXCacheEntry<T>>(memoryKey)
    if (memoized !== undefined && validPayload(memoized.data, options.validate)) {
      return completeData(
        memoized.data,
        'memory',
        memoized.cachedAt === undefined ? undefined : Math.max(0, now() - memoized.cachedAt),
      )
    }

    const edgeCache = (caches as CacheStorage & { default: Cache }).default
    const cacheKey = new Request(`https://mochi-cache.invalid/tdx/${encodeURIComponent(url.toString())}`)
    const cached = await cacheMatchFailOpen(edgeCache, cacheKey, 'tdx')
    if (cached) {
      try {
        const parsed = await readJsonResponse(cached, maxResponseBytes)
        if (validPayload(parsed.data, options.validate)) {
          const cachedAt = parsedCacheTimestamp(cached.headers.get('X-Mochi-Cached-At'))
          const typed = parsed.data as T
          memoryCacheSet(memoryKey, { data: typed, cachedAt }, ttlSeconds)
          return completeData(
            typed,
            'edge',
            cachedAt === undefined ? undefined : Math.max(0, now() - cachedAt),
          )
        }
        console.error(JSON.stringify({ message: 'edge_cache_payload_invalid', context: 'tdx_schema' }))
      } catch (error) {
        console.error(JSON.stringify({
          message: 'edge_cache_payload_invalid',
          context: 'tdx',
          error: error instanceof Error ? error.message : String(error),
        }))
      }
    }

    if (options.blockedFailureClass) {
      const error = new TDXServiceError('TDX resolution blocked by active cooldown', 429, {
        failureKind: options.blockedFailureClass,
      })
      error.warning = options.blockedFailureClass === 'quota' ? 'tdx-quota' : 'tdx-rate-limit'
      return finishFailure(error, false)
    }

    let tokenInfo: TDXTokenResult
    try {
      tokenInfo = await dependencies.getTDXToken(env)
    } catch (error) {
      const serviceError = asTDXServiceError(error)
      return finishFailure(
        serviceError,
        serviceError.failureKind !== 'circuit_open' && serviceError.failureKind !== 'unknown',
      )
    }

    const { token, isShared, credentialKey } = tokenInfo
    let upstreamResult: TDXUpstreamResult
    try {
      upstreamResult = await dependencies.fetchUpstream({
        url,
        maxResponseBytes,
        operation: options.operation,
        token,
        isShared,
        credentialKey,
        ttlSeconds,
        validatesPayload: Boolean(options.validate),
      })
    } catch (error) {
      return finishFailure(asTDXServiceError(error), false)
    }

    const { outcome: upstream, leader, circuitKey, resource } = upstreamResult
    retryCount = upstream.retryCount
    initialFailureClass = upstream.initialFailureClass
    if (!upstream.ok) return finishFailure(upstream.error, true)

    if (leader) {
      logTDXResponseSize({
        operation: options.operation,
        resource,
        credentialScope,
        maxBytes: maxResponseBytes,
        receivedBytes: upstream.receivedBytes,
        declaredBytes: upstream.declaredBytes,
        sampled: tracker?.isSampled ?? false,
      })
    }

    if (!validPayload(upstream.data, options.validate)) {
      const serviceError = new TDXServiceError('TDX response has an invalid schema', 502, {
        failureKind: 'invalid_schema',
      })
      // A parsed HTTP response proves the upstream is reachable. Endpoint schema drift remains
      // an operation-level failure, but must not open the scoped availability circuit.
      if (leader) dependencies.recordCircuitSuccess(circuitKey)
      return finishFailure(serviceError, true)
    }

    const data = upstream.data as T
    if (leader) dependencies.recordCircuitSuccess(circuitKey)
    const cachedAt = now()
    memoryCacheSet(memoryKey, { data, cachedAt }, ttlSeconds)
    const resolved = completeData(data, 'upstream', 0, upstream.status)
    if (leader) {
      await cachePutFailOpen(edgeCache, cacheKey, new Response(JSON.stringify(data), {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': `public, max-age=${ttlSeconds}`,
          'X-Mochi-Cached-At': String(cachedAt),
        },
      }), 'tdx', env.TDX_BACKGROUND_TASKS)
    }
    return resolved
  }

  const fetchTDXJson = async <T>(
    env: TDXEnv,
    url: URL,
    ttlSeconds: number,
    options: TDXResolutionOptions<T> = {},
  ): Promise<T> => (await resolveTDXJson(env, url, ttlSeconds, options)).data

  return { fetchTDXJson, resolveTDXJson }
}

export function withTDXBackgroundTasks<E extends TDXEnv>(env: E, schedule?: BackgroundTaskScheduler): E {
  return schedule ? { ...env, TDX_BACKGROUND_TASKS: schedule } : env
}

function validPayload<T>(value: unknown, validate?: (value: unknown) => value is T): value is T {
  return validate ? validate(value) : true
}

function isEmptyPayload(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0
}

function parsedCacheTimestamp(value: string | null): number | undefined {
  if (!value) return undefined
  const timestamp = Number(value)
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : undefined
}

function telemetryNow(env: TDXEnv): () => number {
  const configured = env.TDX_TELEMETRY?.now
  return () => {
    try {
      const value = configured ? configured() : Date.now()
      return Number.isFinite(value) ? value : Date.now()
    } catch {
      return Date.now()
    }
  }
}
