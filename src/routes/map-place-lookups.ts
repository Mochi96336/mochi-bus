import type { Context } from 'hono'
import { supportedCityCodes } from '../config'
import { QueryValidationError } from '../domain/bus-query'
import { getStopPlaceRoutes } from '../infrastructure/transit/snapshot-place-routing-repository'
import {
  findNearbyStopPlaces,
  getStopPlace,
  getStopPlaceByStopUid,
  searchStopPlaces,
} from '../infrastructure/transit/snapshot-repository'
import {
  parseCoordinate,
  parseRadius,
  requiredQueryString,
} from '../lib/api-input'
import { mapJsonError, type MapEnv } from './map-http-context'

// map.ts owns public paths and registration order; this module owns request handling only.
export async function searchPlaces(c: Context<MapEnv>) {
  try {
    const city = c.req.query('city')?.trim()
    const query = c.req.query('q')?.trim()
    if (!city || !supportedCityCodes.has(city)) throw new QueryValidationError('請選擇縣市')
    if (!query || query.length > 40) throw new QueryValidationError('請輸入站牌名稱')
    const places = await searchStopPlaces(c.env, city, query)
    return c.json({ schemaVersion: 1, city, query, places }, 200, {
      'Cache-Control': 'public, max-age=3600',
    })
  } catch (error) {
    return mapJsonError(c, error, '站牌搜尋失敗')
  }
}

export async function findNearbyPlaces(c: Context<MapEnv>) {
  try {
    const city = c.req.query('city')?.trim()
    const latitude = parseCoordinate(c.req.query('lat'), 'latitude')
    const longitude = parseCoordinate(c.req.query('lon'), 'longitude')
    const radius = parseRadius(c.req.query('radius'))
    if (!city || !supportedCityCodes.has(city)) throw new QueryValidationError('請選擇縣市')
    const places = await findNearbyStopPlaces(c.env, city, latitude, longitude, radius)
    return c.json({ schemaVersion: 1, city, radius, places }, 200, {
      'Cache-Control': 'public, max-age=300',
    })
  } catch (error) {
    return mapJsonError(c, error, '附近站牌查詢失敗')
  }
}

export async function readPlaceRoutes(c: Context<MapEnv>) {
  try {
    const city = c.req.query('city')?.trim()
    if (!city || !supportedCityCodes.has(city)) throw new QueryValidationError('請選擇城市')
    const placeId = requiredQueryString(c.req.param('placeId'), '站牌識別碼', 100)
    const routes = await getStopPlaceRoutes(c.env, city, placeId)
    return c.json({ schemaVersion: 3, city, routes }, 200, {
      'Cache-Control': 'public, max-age=86400',
    })
  } catch (error) {
    return mapJsonError(c, error, '站牌路線讀取失敗')
  }
}

export async function readPlace(c: Context<MapEnv>) {
  try {
    const city = c.req.query('city')?.trim()
    if (!city || !supportedCityCodes.has(city)) throw new QueryValidationError('請選擇城市')
    const placeId = requiredQueryString(c.req.param('placeId'), '站牌識別碼', 100)
    const place = await getStopPlace(c.env, city, placeId)
    if (!place) return c.json({ error: '找不到這個站牌' }, 404)
    return c.json({ schemaVersion: 1, city, place }, 200, {
      'Cache-Control': 'public, max-age=86400',
    })
  } catch (error) {
    return mapJsonError(c, error, '站牌資料讀取失敗')
  }
}

export async function readStopPlace(c: Context<MapEnv>) {
  try {
    const city = c.req.query('city')?.trim()
    if (!city || !supportedCityCodes.has(city)) throw new QueryValidationError('請選擇城市')
    const stopUid = requiredQueryString(c.req.query('stopUid'), 'StopUID', 100)
    const place = await getStopPlaceByStopUid(c.env, city, stopUid)
    if (!place) return c.json({ error: '找不到這個站牌' }, 404)
    return c.json({ schemaVersion: 1, city, stopUid, place }, 200, {
      'Cache-Control': 'public, max-age=3600',
    })
  } catch (error) {
    return mapJsonError(c, error, '站牌資料讀取失敗')
  }
}
