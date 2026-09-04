import type { Context } from 'hono'
import { supportedCityCodes } from '../config'
import { QueryValidationError } from '../domain/bus-query'
import type { RouteMapVariant } from '../domain/map/map-model'
import { buildRouteTimetable } from '../domain/map/timetable'
import { getRouteMapVariants } from '../infrastructure/tdx/map'
import {
  getPinnedSnapshotRouteVariant,
  getPinnedSnapshotRouteVariants,
} from '../infrastructure/transit/snapshot-probe-repository'
import { getSnapshotRouteVariants } from '../infrastructure/transit/snapshot-pattern-stop-repository'
import { getSnapshotSchedule } from '../infrastructure/transit/snapshot-repository'
import { getBusSchedule } from '../lib/tdx'
import {
  ApiInputError,
  optionalQueryString,
  parseOptionalDirection,
} from '../lib/api-input'
import { logProductionError } from '../observability/production-log'
import { mapJsonError, tdxEnv, type MapEnv } from './map-http-context'
import {
  requestedProbeRouteIdentity,
  requestedProbeSnapshotVersion,
  type RequestedProbeRouteIdentity,
} from './snapshot-probe-read'

type RouteVariantSource = 'snapshot' | 'tdx'

type LoadedRouteVariants = {
  variants: RouteMapVariant[]
  source: RouteVariantSource
}

type RouteVariantSelector = {
  direction: 0 | 1 | 2
  variantKey?: string
  routeUid?: string
  subRouteUid?: string
}

// Route map and timetable share one snapshot-first variant source decision.
async function loadRouteVariants(
  c: Context<MapEnv>,
  city: string,
  routeName: string,
  requestedVersion?: string,
  requestedIdentity?: RequestedProbeRouteIdentity,
): Promise<LoadedRouteVariants> {
  if (requestedVersion) {
    if (requestedIdentity) {
      const variant = await getPinnedSnapshotRouteVariant(
        c.env,
        city,
        requestedIdentity.routeUid,
        requestedIdentity.patternId,
        requestedVersion,
      )
      return {
        variants: variant?.routeName === routeName ? [variant] : [],
        source: 'snapshot',
      }
    }
    return {
      variants: await getPinnedSnapshotRouteVariants(c.env, city, routeName, requestedVersion),
      source: 'snapshot',
    }
  }
  const snapshotVariants = await getSnapshotRouteVariants(c.env, city, routeName)
  if (snapshotVariants.length) return { variants: snapshotVariants, source: 'snapshot' }
  return {
    variants: await getRouteMapVariants(tdxEnv(c), city, routeName),
    source: 'tdx',
  }
}

function selectRouteVariant(
  variants: RouteMapVariant[],
  selector: RouteVariantSelector,
): RouteMapVariant | undefined {
  return variants.find((candidate) =>
    candidate.direction === selector.direction
    && (!selector.variantKey || candidate.variantKey === selector.variantKey)
    && (!selector.routeUid || candidate.routeUid === selector.routeUid)
    && (!selector.subRouteUid || candidate.subRouteUid === selector.subRouteUid))
}

export async function readRouteMap(c: Context<MapEnv>) {
  try {
    const city = c.req.query('city')?.trim()
    const routeName = c.req.query('route')?.trim()
    if (!city || !supportedCityCodes.has(city)) throw new QueryValidationError('請選擇有效縣市')
    if (!routeName || routeName.length > 40) throw new QueryValidationError('請選擇有效路線')

    const requestedVersion = await requestedProbeSnapshotVersion(c, city)
    const requestedIdentity = requestedProbeRouteIdentity(c, requestedVersion)
    const { variants, source } = await loadRouteVariants(
      c,
      city,
      routeName,
      requestedVersion,
      requestedIdentity,
    )
    if (!variants.length) {
      return c.json({ error: '這條路線目前沒有可用的地圖線型' }, 404, {
        ...(requestedVersion ? { 'Cache-Control': 'no-store' } : {}),
      })
    }
    return c.json({
      schemaVersion: 1,
      city,
      routeName,
      source,
      ...(requestedVersion ? { snapshotVersion: requestedVersion } : {}),
      variants,
    }, 200, {
      'Cache-Control': requestedVersion
        ? 'no-store'
        : `public, max-age=${source === 'snapshot' ? 86400 : 300}`,
    })
  } catch (error) {
    if (!(error instanceof QueryValidationError || error instanceof ApiInputError)) {
      logProductionError({
        event: 'route_map_failed',
        operation: 'map_route',
        city: c.req.query('city')?.trim(),
        error,
      })
    }
    return mapJsonError(c, error, '暫時無法取得路線地圖')
  }
}

export async function readRouteTimetable(c: Context<MapEnv>) {
  try {
    const city = c.req.query('city')?.trim()
    const routeName = c.req.query('route')?.trim()
    const routeUid = optionalQueryString(c.req.query('routeUid'), 'RouteUID', 100)
    const variantKey = optionalQueryString(c.req.query('variant'), '路線方向識別碼', 200)
    const subRouteUid = optionalQueryString(c.req.query('subRouteUid'), 'SubRouteUID', 100)
    const stopUid = optionalQueryString(c.req.query('stopUid'), 'StopUID', 100)
    const direction = parseOptionalDirection(c.req.query('direction'))
    if (!city || !supportedCityCodes.has(city)) throw new QueryValidationError('請選擇有效縣市')
    if (!routeName || routeName.length > 40) throw new QueryValidationError('請選擇有效路線')
    if (direction === undefined) throw new QueryValidationError('請選擇行駛方向')

    const { variants } = await loadRouteVariants(c, city, routeName)
    const variant = selectRouteVariant(variants, { direction, variantKey, routeUid, subRouteUid })
    if (!variant) return c.json({ error: '找不到這個方向的站序' }, 404)

    const snapshotSchedules = await getSnapshotSchedule(c.env, city, routeName, variant.routeUid)
    const schedules = snapshotSchedules ?? await getBusSchedule(tdxEnv(c), city, routeName, variant.routeUid)
    const timetable = buildRouteTimetable(schedules, {
      direction: variant.direction,
      subRouteUid: variant.subRouteUid,
      stops: variant.stops.features.map((feature) => ({
        stopUid: feature.properties.stopUid,
        stopName: feature.properties.stopName,
        sequence: feature.properties.sequence,
      })),
    }, stopUid, new Date())
    return c.json({
      schemaVersion: 1,
      city,
      routeName,
      variantKey: variant.variantKey,
      routeUid: variant.routeUid,
      direction: variant.direction,
      source: snapshotSchedules === null ? 'tdx' : 'snapshot',
      timetable,
    }, 200, { 'Cache-Control': 'public, max-age=300' })
  } catch (error) {
    return mapJsonError(c, error, '時刻表讀取失敗')
  }
}
