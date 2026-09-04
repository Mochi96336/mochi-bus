import type { Context } from 'hono'
import { supportedCityCodes } from '../config'
import { QueryValidationError } from '../domain/bus-query'
import {
  fetchTDXJson,
  isRejectedUserTdxToken,
  isTDXRecordArray,
  tdxRouteScope,
  tdxWarningFromError,
  type TDXWarning,
} from '../lib/tdx'
import { optionalQueryString, parseOptionalDirection } from '../lib/api-input'
import { vehiclesOutcome } from '../observability/map-api-outcomes'
import {
  beginMapOperation,
  completeMapError,
  tdxEnv,
  telemetryCity,
  type MapEnv,
} from './map-http-context'

const VEHICLE_SELECT = [
  'PlateNumb',
  'RouteUID',
  'Direction',
  'BusPosition',
  'Speed',
  'Azimuth',
  'GPSTime',
  'UpdateTime',
].join(',')

type VehicleItem = {
  PlateNumb?: string
  RouteUID?: string
  Direction?: number
  BusPosition?: { PositionLat?: number; PositionLon?: number }
  Speed?: number
  Azimuth?: number
  GPSTime?: string
  UpdateTime?: string
}

// This handler owns the complete realtime vehicle contract: upstream degradation, identity
// filtering, coordinate validation, cache policy, and map_vehicles completion telemetry.
// A rejected personal TDX token remains terminal; ordinary upstream failures degrade to warnings.
export async function readVehicles(c: Context<MapEnv>) {
  const tracker = beginMapOperation(c, 'map_vehicles', telemetryCity(c.req.query('city')?.trim()))
  try {
    const city = c.req.query('city')?.trim()
    const routeName = c.req.query('route')?.trim()
    const routeUid = optionalQueryString(c.req.query('routeUid'), 'RouteUID', 100)
    const direction = parseOptionalDirection(c.req.query('direction'))
    if (!city || !supportedCityCodes.has(city)) throw new QueryValidationError('請選擇縣市')
    if (!routeName || routeName.length > 40) throw new QueryValidationError('路線格式錯誤')

    const url = new URL(
      `https://tdx.transportdata.tw/api/basic/v2/Bus/RealTimeByFrequency/${tdxRouteScope(city, routeUid)}/${encodeURIComponent(routeName)}`,
    )
    // Keep $format first for cache-key continuity with the existing route-specific request,
    // then narrow fields and identities so a cache miss transfers only records this handler can use.
    url.searchParams.set('$format', 'JSON')
    url.searchParams.set('$select', VEHICLE_SELECT)
    const filters: string[] = []
    if (routeUid) filters.push(`RouteUID eq '${escapeODataString(routeUid)}'`)
    if (direction !== undefined) filters.push(`Direction eq ${direction}`)
    if (filters.length) url.searchParams.set('$filter', filters.join(' and '))

    let items: VehicleItem[] = []
    let warning: TDXWarning | undefined
    let upstreamSucceeded = false
    try {
      items = await fetchTDXJson<VehicleItem[]>(tdxEnv(c), url, 15, {
        operation: 'vehicle_positions',
        city: telemetryCity(city),
        validate: isTDXRecordArray<VehicleItem>,
      })
      upstreamSucceeded = true
    } catch (error) {
      if (isRejectedUserTdxToken(error, c.req.header('Authorization'))) throw error
      warning = tdxWarningFromError(error) ?? 'tdx-unavailable'
      console.error(JSON.stringify({
        message: 'vehicle_position_upstream_failed', city, routeName,
        error: error instanceof Error ? error.message : String(error),
      }))
    }

    // Keep local identity filtering as a defensive boundary even though stable identities are
    // now also pushed upstream; malformed/out-of-scope rows must not leak into the public response.
    const identityMatchedItems = items
      .filter((item) => !routeUid || item.RouteUID === routeUid)
      .filter((item) => direction === undefined || item.Direction === direction)
    const vehicles = identityMatchedItems
      .filter((item) => Number.isFinite(item.BusPosition?.PositionLat) && Number.isFinite(item.BusPosition?.PositionLon))
      .map((item) => ({
        plate: item.PlateNumb ?? null,
        latitude: item.BusPosition!.PositionLat!,
        longitude: item.BusPosition!.PositionLon!,
        speed: item.Speed ?? null,
        azimuth: item.Azimuth ?? null,
        gpsTime: item.GPSTime ?? item.UpdateTime ?? null,
      }))

    const response = c.json({ schemaVersion: 1, city, routeName, vehicles, warning }, 200, {
      'Cache-Control': warning || c.req.header('Authorization') ? 'no-store' : 'public, max-age=15',
    })
    tracker.complete({
      ...vehiclesOutcome({
        upstreamSucceeded,
        rawCount: items.length,
        identityMatchedCount: identityMatchedItems.length,
        validVehicleCount: vehicles.length,
        warning,
      }),
      httpStatus: 200,
      city: telemetryCity(city),
    })
    return response
  } catch (error) {
    return completeMapError(c, tracker, error, '車輛位置讀取失敗')
  }
}

function escapeODataString(value: string): string {
  return value.replaceAll("'", "''")
}
