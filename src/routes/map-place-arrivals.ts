import type { Context } from 'hono'
import { supportedCityCodes } from '../config'
import { QueryValidationError } from '../domain/bus-query'
import { includeFocusedCandidate, selectRealtimeCandidates } from '../domain/map/arrival-ranking'
import { selectBestEta } from '../domain/map/eta'
import { nextScheduledMinutes, scheduleClockLabel, type ScheduleItem, type ScheduleQuery } from '../domain/schedule'
import {
  buildStopArrivalBatches,
  parseStopArrivalBatchPayload,
  STOP_ARRIVAL_MAX_RESPONSE_BYTES,
} from '../infrastructure/tdx/stop-arrivals'
import { getPinnedStopPlaceBundle } from '../infrastructure/transit/snapshot-probe-repository'
import {
  getSnapshotSchedule,
  getStopPlaceBundle,
  getStopPlaceRoutes,
} from '../infrastructure/transit/snapshot-repository'
import { cacheMatchFailOpen, cachePutFailOpen } from '../lib/edge-cache'
import { optionalQueryString, parseOptionalDirection, requiredQueryString } from '../lib/api-input'
import { memoryCacheGet, memoryCacheSet } from '../lib/memory-cache'
import {
  formatETALabel,
  isRejectedUserTdxToken,
  resolveTDXJson,
  TDXServiceError,
  tdxCredentialScope,
  tdxWarningFromError,
  type BusETAItem,
  type TDXEnv,
  type TDXWarning,
} from '../lib/tdx'
import { placeArrivalsOutcome } from '../observability/map-api-outcomes'
import {
  beginMapOperation,
  completeMapError,
  tdxEnv,
  telemetryCity,
  type MapEnv,
} from './map-http-context'
import { requestedProbeSnapshotVersion } from './snapshot-probe-read'

const REALTIME_COOLDOWN_SECONDS = 60
const LAST_REALTIME_SECONDS = 120

type LastRealtime = { items: BusETAItem[]; cachedAt?: number }

function strongerTDXWarning(current: TDXWarning | undefined, next: TDXWarning | undefined): TDXWarning | undefined {
  const priority: Record<TDXWarning, number> = {
    'tdx-unavailable': 1,
    'tdx-rate-limit': 2,
    'tdx-quota': 3,
  }
  if (!next || (current && priority[current] >= priority[next])) return current
  return next
}

function arrivalCacheKey(kind: 'cooldown' | 'last', city: string, suffix = ''): Request {
  return new Request(`https://mochi-cache.invalid/arrivals/${kind}/${encodeURIComponent(city)}/${encodeURIComponent(suffix)}`)
}

function edgeCache(): Cache {
  return (caches as CacheStorage & { default: Cache }).default
}

// Memory is authoritative inside an isolate; Cache API extends the state across requests and fails open.
async function hasRealtimeCooldown(env: TDXEnv, city: string, scope: string): Promise<boolean> {
  if (memoryCacheGet<boolean>(`arrivals/cooldown/${city}/${scope}`)) return true
  return Boolean(await cacheMatchFailOpen(edgeCache(), arrivalCacheKey('cooldown', city, scope), 'arrivals_cooldown'))
}

async function setRealtimeCooldown(env: TDXEnv, city: string, scope: string): Promise<void> {
  memoryCacheSet(`arrivals/cooldown/${city}/${scope}`, true, REALTIME_COOLDOWN_SECONDS)
  await cachePutFailOpen(edgeCache(), arrivalCacheKey('cooldown', city, scope), new Response('1', {
    headers: { 'Cache-Control': `public, max-age=${REALTIME_COOLDOWN_SECONDS}` },
  }), 'arrivals_cooldown', env.TDX_BACKGROUND_TASKS)
}

async function readLastRealtime(env: TDXEnv, city: string, cacheKey: string): Promise<LastRealtime | undefined> {
  const memoized = memoryCacheGet<LastRealtime>(`arrivals/last/${city}/${cacheKey}`)
  if (memoized) return memoized
  const response = await cacheMatchFailOpen(edgeCache(), arrivalCacheKey('last', city, cacheKey), 'arrivals_last')
  if (!response) return undefined
  try {
    const items = await response.json<BusETAItem[]>()
    if (!Array.isArray(items)) return undefined
    const headerValue = response.headers.get('X-Mochi-Cached-At')
    const header = headerValue === null ? Number.NaN : Number(headerValue)
    return { items, ...(Number.isFinite(header) && header >= 0 ? { cachedAt: header } : {}) }
  } catch (error) {
    console.error(JSON.stringify({
      message: 'edge_cache_payload_invalid',
      context: 'arrivals_last',
      error: error instanceof Error ? error.message : String(error),
    }))
    return undefined
  }
}

async function writeLastRealtime(env: TDXEnv, city: string, cacheKey: string, items: BusETAItem[]): Promise<void> {
  const cachedAt = Date.now()
  memoryCacheSet(`arrivals/last/${city}/${cacheKey}`, { items, cachedAt }, LAST_REALTIME_SECONDS)
  await cachePutFailOpen(edgeCache(), arrivalCacheKey('last', city, cacheKey), new Response(JSON.stringify(items), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `public, max-age=${LAST_REALTIME_SECONDS}`,
      'X-Mochi-Cached-At': String(cachedAt),
    },
  }), 'arrivals_last', env.TDX_BACKGROUND_TASKS)
}

function routeIdentity(routeName: string, routeUid?: string): string {
  return routeUid ? `uid:${routeUid}` : `name:${routeName}`
}

// This module owns the stateful Place Arrivals boundary as one unit: snapshot schedules,
// candidate batching, realtime cooldown, stale replay, warning aggregation, and completion telemetry.
// Journey ETA keeps its shared warning selection and route URL helpers in map.ts.
export async function readPlaceArrivals(c: Context<MapEnv>) {
  const tracker = beginMapOperation(c, 'map_place_arrivals', telemetryCity(c.req.query('city')?.trim()))
  try {
    const env = tdxEnv(c)
    const scope = await tdxCredentialScope(env)
    const city = c.req.query('city')?.trim()
    if (!city || !supportedCityCodes.has(city)) throw new QueryValidationError('請選擇城市')
    const placeId = requiredQueryString(c.req.param('placeId'), '站牌識別碼', 100)
    const requestedVersion = await requestedProbeSnapshotVersion(c, city)
    const bundle = requestedVersion
      ? await getPinnedStopPlaceBundle(env, city, placeId, requestedVersion)
      : await getStopPlaceBundle(env, city, placeId)
    const now = new Date()
    const scheduledRoutes = bundle ? bundle.routes.map(({ schedules, ...route }) => ({
      ...route,
      ...scheduleFields(schedules, {
        stopUid: route.stopUid,
        direction: route.direction,
        subRouteUid: route.subRouteUid,
      }, now),
    })) : requestedVersion ? [] : await (async () => {
      const routes = await getStopPlaceRoutes(env, city, placeId)
      const routeNames = [...new Set(routes.map((route) => route.routeName))]
      const schedulesByRoute = new Map((await Promise.all(routeNames.map(async (routeName) => [
        routeName,
        await getSnapshotSchedule(env, city, routeName) ?? [],
      ] as const))))
      return routes.map((route) => ({
        ...route,
        ...scheduleFields(schedulesByRoute.get(route.routeName) ?? [], {
          stopUid: route.stopUid,
          direction: route.direction,
          subRouteUid: route.subRouteUid,
        }, now),
      }))
    })()
    const focusStopUid = optionalQueryString(c.req.query('focusStopUid'), 'StopUID', 100)
    const focusSubRouteUid = optionalQueryString(c.req.query('focusSubRouteUid'), 'SubRouteUID', 100)
    const focusDirection = parseOptionalDirection(c.req.query('focusDirection'), 'focusDirection')
    const focused = focusStopUid ? scheduledRoutes.find((route) =>
      route.stopUid === focusStopUid
      && (focusDirection === undefined || route.direction === focusDirection)
      && (!focusSubRouteUid || route.subRouteUid === focusSubRouteUid),
    ) : undefined
    // Snapshot publication probes verify the pinned bundle itself. They do not
    // contact TDX or replay realtime state, so source health cannot mask bundle identity.
    const candidates = requestedVersion
      ? []
      : includeFocusedCandidate(selectRealtimeCandidates(scheduledRoutes), focused)
    const batches = buildStopArrivalBatches(city, candidates.map((route) => ({
      routeUid: route.routeUid,
      routeName: route.routeName,
      stopUid: route.stopUid,
    })))
    const etaItems: BusETAItem[] = []
    const staleRouteIdentities = new Set<string>()
    let rateLimited = requestedVersion ? false : await hasRealtimeCooldown(env, city, scope)
    let warning: TDXWarning | undefined = rateLimited ? 'tdx-rate-limit' : undefined
    let realtimeQueries = 0
    for (const batch of batches) {
      const routeUids = [...new Set(batch.candidates.map((candidate) => candidate.routeUid))]
      try {
        const resolved = await resolveTDXJson<unknown[]>(env, batch.url, 15, {
          operation: 'place_arrivals',
          city: telemetryCity(city),
          maxResponseBytes: STOP_ARRIVAL_MAX_RESPONSE_BYTES,
          validate: (value): value is unknown[] => (
            parseStopArrivalBatchPayload(value, batch.stopUids, routeUids).ok
          ),
          blockedFailureClass: rateLimited ? 'rate_limited' : undefined,
          staleFallback: async () => {
            const stale = await readLastRealtime(env, city, batch.cacheKey)
            return stale?.items.length ? {
              data: stale.items,
              dataAgeMilliseconds: stale.cachedAt === undefined ? undefined : Math.max(0, Date.now() - stale.cachedAt),
            } : undefined
          },
        })
        const parsed = parseStopArrivalBatchPayload(resolved.data, batch.stopUids, routeUids)
        if (!parsed.ok) {
          throw new TDXServiceError(`TDX stop arrival response is unusable (${parsed.reason})`, 502, {
            failureKind: 'invalid_schema',
          })
        }
        if (resolved.resolution === 'upstream' && (
          parsed.droppedRows > 0
          || Object.keys(parsed.issueCounts).length > 0
          || parsed.unknownDirectionValues.length > 0
        )) {
          console.info(JSON.stringify({
            message: 'tdx_payload_rows_normalized',
            operation: 'place_arrivals',
            city,
            tdxScope: batch.scope,
            totalRows: parsed.totalRows,
            acceptedRows: parsed.data.length,
            droppedRows: parsed.droppedRows,
            issueCounts: parsed.issueCounts,
            unknownDirectionValues: parsed.unknownDirectionValues.slice(0, 5),
          }))
        }
        etaItems.push(...parsed.data)
        if (resolved.resolution === 'stale_replay') {
          batch.candidates.forEach((candidate) => {
            staleRouteIdentities.add(routeIdentity(candidate.routeName, candidate.routeUid))
          })
        } else {
          await writeLastRealtime(env, city, batch.cacheKey, parsed.data)
          realtimeQueries += 1
        }
      } catch (error) {
        if (isRejectedUserTdxToken(error, c.req.header('Authorization'))) throw error
        rateLimited ||= error instanceof TDXServiceError && error.rateLimited
        warning = strongerTDXWarning(warning, tdxWarningFromError(error) ?? 'tdx-unavailable')
        console.error(JSON.stringify({
          message: 'place_arrival_realtime_failed',
          city,
          tdxScope: batch.scope,
          stopUidCount: batch.stopUids.length,
          error: error instanceof Error ? error.message : String(error),
        }))
        if (rateLimited) await setRealtimeCooldown(env, city, scope)
      }
    }
    const arrivals = scheduledRoutes.map((route) => {
      const realtime = selectBestEta(etaItems, route)
      const realtimeSeconds = typeof realtime?.EstimateTime === 'number' ? Math.max(0, realtime.EstimateTime) : null
      const estimateSeconds = realtimeSeconds ?? (route.scheduleMinutes === null ? null : route.scheduleMinutes * 60)
      const source = realtimeSeconds !== null
        ? staleRouteIdentities.has(routeIdentity(route.routeName, route.routeUid)) ? 'stale-realtime' as const : 'realtime' as const
        : route.scheduleMinutes !== null ? 'schedule' as const
          : 'none' as const
      return {
        ...route,
        estimateSeconds,
        etaLabel: source === 'realtime' || source === 'stale-realtime'
          ? formatETALabel(Math.ceil((realtimeSeconds as number) / 60), realtime?.StopStatus ?? 0)
          : source === 'schedule'
            ? route.scheduleClock
              ?? (route.scheduleHeadway
                ? `${route.scheduleHeadway[0]}–${route.scheduleHeadway[1]} 分一班`
                : route.scheduleDepartureBased
                  ? `${Math.max(1, route.scheduleMinutes ?? 1)} 分後發車`
                  : `約 ${Math.max(1, route.scheduleMinutes ?? 1)} 分`)
            : '暫無資訊',
        stopStatus: realtime?.StopStatus ?? 0,
        source,
      }
    }).sort((a, b) =>
      (a.estimateSeconds ?? Number.POSITIVE_INFINITY) - (b.estimateSeconds ?? Number.POSITIVE_INFINITY)
      || a.routeName.localeCompare(b.routeName, 'zh-Hant', { numeric: true }),
    )
    const response = c.json({
      schemaVersion: 1,
      city,
      routes: arrivals,
      scheduleSource: bundle ? 'place-bundle' : 'route-objects',
      snapshotVersion: bundle?.version ?? null,
      warning,
      realtime: { candidates: candidates.length, queries: realtimeQueries, rateLimited },
    }, 200, {
      'Cache-Control': requestedVersion || warning || c.req.header('Authorization')
        ? 'no-store'
        : 'public, max-age=15',
    })
    tracker.complete({
      ...placeArrivalsOutcome({
        bundleUsed: Boolean(bundle),
        sources: arrivals.map((arrival) => arrival.source),
        warning,
        snapshotVersion: bundle?.version ?? null,
      }),
      httpStatus: 200,
      city: telemetryCity(city),
    })
    return response
  } catch (error) {
    return completeMapError(c, tracker, error, '到站時間讀取失敗')
  }
}

function scheduleFields(schedules: ScheduleItem[], query: ScheduleQuery, now: Date) {
  const estimate = nextScheduledMinutes(schedules, query, now)
  return {
    scheduleMinutes: estimate?.minutes ?? null,
    scheduleDepartureBased: estimate?.departureBased ?? false,
    scheduleHeadway: estimate?.headwayMinutes ?? null,
    scheduleClock: estimate ? scheduleClockLabel(estimate, now) : null,
  }
}
