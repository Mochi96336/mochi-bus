import type { Context } from 'hono'
import { supportedCityCodes } from '../config'
import { QueryValidationError } from '../domain/bus-query'
import { getDirectRoutes } from '../infrastructure/transit/snapshot-place-routing-repository'
import { getOneTransferRoutes } from '../infrastructure/transit/snapshot-repository'
import { requiredQueryString } from '../lib/api-input'
import { mapJsonError, type MapEnv } from './map-http-context'

// Registration order and realtime ETA stay in map.ts; these handlers own snapshot-backed request/response contracts.
export async function readDirectRoutes(c: Context<MapEnv>) {
  try {
    const city = c.req.query('city')?.trim()
    const from = requiredQueryString(c.req.query('from'), '起點', 100)
    const to = requiredQueryString(c.req.query('to'), '終點', 100)
    if (!city || !supportedCityCodes.has(city)) throw new QueryValidationError('請選擇縣市')
    const routes = await getDirectRoutes(c.env, city, from, to)
    return c.json({ schemaVersion: 1, city, from, to, routes }, 200, {
      'Cache-Control': 'public, max-age=86400',
    })
  } catch (error) {
    return mapJsonError(c, error, '直達路線查詢失敗')
  }
}

export async function readTransferPlans(c: Context<MapEnv>) {
  try {
    const city = c.req.query('city')?.trim()
    const from = requiredQueryString(c.req.query('from'), '出發位置', 100)
    const to = requiredQueryString(c.req.query('to'), '目的地', 100)
    if (!city || !supportedCityCodes.has(city)) throw new QueryValidationError('請選擇縣市')
    const plans = await getOneTransferRoutes(c.env, city, from, to)
    return c.json({ schemaVersion: 1, city, from, to, plans }, 200, {
      'Cache-Control': 'public, max-age=86400',
    })
  } catch (error) {
    return mapJsonError(c, error, '轉乘路線查詢失敗')
  }
}