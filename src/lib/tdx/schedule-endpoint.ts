import { supportedCityCodes } from '../../config'
import type { ScheduleItem } from '../../domain/schedule'
import type { TelemetryCity } from '../../observability/telemetry'
import { tdxRouteScope } from './bus-route-queries'
import type {
  TDXEnv,
  TDXResolutionOptions,
} from './resolution-cache'

const SCHEDULE_CACHE_SECONDS = 6 * 60 * 60
const SCHEDULE_SELECT = 'SubRouteUID,Direction,Timetables,Frequencys'

export type TDXScheduleEndpointDependencies = {
  fetchTDXJson: <T>(
    env: TDXEnv,
    url: URL,
    ttlSeconds: number,
    options?: TDXResolutionOptions<T>,
  ) => Promise<T>
}

// This boundary owns the Bus Schedule endpoint contract: scope/URL construction,
// six-hour cache policy, payload validation and city telemetry classification.
// Token, HTTP, retry, circuit and cache implementation stay behind fetchTDXJson.
export function createTDXScheduleEndpoint(dependencies: TDXScheduleEndpointDependencies) {
  const getBusSchedule = async (
    env: TDXEnv,
    city: string,
    routeName: string,
    routeUid?: string,
  ): Promise<ScheduleItem[]> => {
    const url = new URL(
      `https://tdx.transportdata.tw/api/basic/v2/Bus/Schedule/${tdxRouteScope(city, routeUid)}/${encodeURIComponent(routeName)}`,
    )
    // Snapshot schedules are preferred by presentation paths. The direct TDX fallback only
    // consumes route-pattern identity, direction and the timetable/headway collections.
    url.searchParams.set('$select', SCHEDULE_SELECT)
    url.searchParams.set('$format', 'JSON')
    return dependencies.fetchTDXJson<ScheduleItem[]>(env, url, SCHEDULE_CACHE_SECONDS, {
      operation: 'tdx_schedule',
      city: tdxTelemetryCity(city),
      validate: isTDXRecordArray,
    })
  }

  return { getBusSchedule }
}

export function isTDXRecordArray<T extends object>(value: unknown): value is T[] {
  return Array.isArray(value)
    && value.every((item) => item !== null && typeof item === 'object' && !Array.isArray(item))
}

export function tdxTelemetryCity(value: string): TelemetryCity | null {
  return supportedCityCodes.has(value) ? value as TelemetryCity : null
}
