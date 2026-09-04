import type { Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { requireEnabledCity, supportedCityCodes } from '../config'
import { QueryValidationError } from '../domain/bus-query'
import {
  realtimeJourneyEstimate,
  scheduledJourneyEstimates,
  type JourneyEstimate,
} from '../domain/map/journey-estimate'
import type { ScheduleItem } from '../domain/schedule'
import {
  buildStopArrivalBatches,
  parseStopArrivalBatchPayload,
  STOP_ARRIVAL_MAX_RESPONSE_BYTES,
} from '../infrastructure/tdx/stop-arrivals'
import { getJourneyLegStopRefs } from '../infrastructure/transit/snapshot-pattern-stop-repository'
import { getSnapshotSchedule } from '../infrastructure/transit/snapshot-repository'
import {
  fetchTDXJson,
  getBusSchedule,
  isRejectedUserTdxToken,
  tdxWarningFromError,
  type BusETAItem,
  type TDXWarning,
} from '../lib/tdx'
import {
  ApiInputError,
  JOURNEY_ETA_BODY_LIMIT_BYTES,
  parseJourneyEtaInput,
  readJsonBody,
} from '../lib/api-input'
import { journeyEtaOutcome } from '../observability/map-api-outcomes'
import type { TelemetryCity } from '../observability/telemetry'
import {
  beginMapOperation,
  completeMapError,
  tdxEnv,
  telemetryCity,
  type MapEnv,
} from './map-http-context'

export const journeyEtaBodyLimit = bodyLimit({
  maxSize: JOURNEY_ETA_BODY_LIMIT_BYTES,
  onError: (c) => c.json({ error: '請求內容過大', code: 'PAYLOAD_TOO_LARGE' }, 413, {
    'Cache-Control': 'no-store',
  }),
})

// This module owns both journey ETA middleware and handling: bounded input, batched
// realtime resolution, snapshot-first schedule fallback, warning aggregation, and telemetry.
export async function readJourneyEta(c: Context<MapEnv>) {
  const tracker = beginMapOperation(c, 'map_journey_eta', null)
  let observedCity: TelemetryCity | null = null
  try {
    const input = parseJourneyEtaInput(await readJsonBody(c.req.raw), supportedCityCodes)
    const city = requireEnabledCity(input.city)
    const { legs } = input
    observedCity = telemetryCity(city)
    const env = tdxEnv(c)
    let warning: TDXWarning | undefined

    const refs = await getJourneyLegStopRefs(env, city, legs)
    const batches = buildStopArrivalBatches(city, refs.map((ref) => ({
      routeUid: ref.routeUid,
      routeName: ref.routeName,
      stopUid: ref.stopUid,
    })))
    const etaItems = (await Promise.all(batches.map(async (batch) => {
      const routeUids = [...new Set(batch.candidates.map((candidate) => candidate.routeUid))]
      try {
        const data = await fetchTDXJson<unknown[]>(
          env,
          batch.url,
          15,
          {
            operation: 'journey_eta',
            city: telemetryCity(city),
            maxResponseBytes: STOP_ARRIVAL_MAX_RESPONSE_BYTES,
            validate: (value): value is unknown[] => (
              parseStopArrivalBatchPayload(value, batch.stopUids, routeUids).ok
            ),
          },
        )
        const parsed = parseStopArrivalBatchPayload(data, batch.stopUids, routeUids)
        return parsed.ok ? parsed.data : []
      } catch (error) {
        if (isRejectedUserTdxToken(error, c.req.header('Authorization'))) throw error
        warning = strongerTDXWarning(warning, tdxWarningFromError(error) ?? 'tdx-unavailable')
        console.error(JSON.stringify({
          message: 'journey_eta_upstream_failed',
          city,
          tdxScope: batch.scope,
          stopUidCount: batch.stopUids.length,
          routeUidCount: routeUids.length,
          error: error instanceof Error ? error.message : String(error),
        }))
        return [] as BusETAItem[]
      }
    }))).flat()
    const etaItemsByRouteUid = new Map<string, BusETAItem[]>()
    for (const item of etaItems) {
      if (typeof item.RouteUID !== 'string') continue
      const current = etaItemsByRouteUid.get(item.RouteUID)
      if (current) current.push(item)
      else etaItemsByRouteUid.set(item.RouteUID, [item])
    }
    const realtimeEstimates = new Map<string, JourneyEstimate>(refs.map((ref) => {
      return [ref.key, realtimeJourneyEstimate(ref, etaItemsByRouteUid.get(ref.routeUid) ?? [])] as const
    }))

    const missingRefs = refs.filter((ref) => realtimeEstimates.get(ref.key)?.minutes === null)
    if (missingRefs.length) {
      try {
        const missingRouteRefs = [...new Map(missingRefs.map((ref) => [ref.routeUid, ref])).values()]
        const schedulesByRouteUid = new Map(await Promise.all(missingRouteRefs.map(async (ref) => {
          try {
            return [
              ref.routeUid,
              await getSnapshotSchedule(env, city, ref.routeName, ref.routeUid)
                ?? await getBusSchedule(env, city, ref.routeName, ref.routeUid),
            ] as const
          } catch (error) {
            if (isRejectedUserTdxToken(error, c.req.header('Authorization'))) throw error
            warning = strongerTDXWarning(warning, tdxWarningFromError(error) ?? 'tdx-unavailable')
            console.error(JSON.stringify({
              message: 'journey_schedule_route_failed',
              city,
              routeUid: ref.routeUid,
              error: error instanceof Error ? error.message : String(error),
            }))
            return [ref.routeUid, [] as ScheduleItem[]] as const
          }
        })))
        const scheduled = scheduledJourneyEstimates(missingRefs, schedulesByRouteUid, new Date())
        scheduled.forEach((estimate, key) => realtimeEstimates.set(key, estimate))
      } catch (error) {
        if (isRejectedUserTdxToken(error, c.req.header('Authorization'))) throw error
        warning = strongerTDXWarning(warning, tdxWarningFromError(error) ?? 'tdx-unavailable')
        console.error(JSON.stringify({
          message: 'journey_schedule_fallback_failed',
          city,
          error: error instanceof Error ? error.message : String(error),
        }))
      }
    }
    const estimates = refs.map((ref) => realtimeEstimates.get(ref.key))
    const response = c.json({ schemaVersion: 1, city, fetchedAt: new Date().toISOString(), estimates, warning }, 200, {
      'Cache-Control': 'no-store',
    })
    tracker.complete({
      ...journeyEtaOutcome({ estimates, expectedCount: legs.length, warning }),
      httpStatus: 200,
      city: observedCity,
    })
    return response
  } catch (error) {
    if (!(error instanceof QueryValidationError || error instanceof ApiInputError)) {
      console.error(JSON.stringify({
        message: 'journey_eta_failed',
        error: error instanceof Error ? error.message : String(error),
      }))
    }
    return completeMapError(c, tracker, error, 'ETA 排序資料讀取失敗', observedCity)
  }
}

function strongerTDXWarning(current: TDXWarning | undefined, next: TDXWarning | undefined): TDXWarning | undefined {
  const priority: Record<TDXWarning, number> = {
    'tdx-unavailable': 1,
    'tdx-rate-limit': 2,
    'tdx-quota': 3,
  }
  if (!next || (current && priority[current] >= priority[next])) return current
  return next
}
