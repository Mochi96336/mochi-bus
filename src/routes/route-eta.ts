import { Hono, type Context } from 'hono'
import { defaultCity, requireEnabledCity, supportedCityCodes } from '../config'
import {
  parseBusQuery,
  QueryValidationError,
  type BusQuery,
  type ResolvedBusQuery,
} from '../domain/bus-query'
import { CityNotEnabledError, CITY_NOT_ENABLED_CODE } from '../domain/city-availability'
import { getRouteEtaDetail, toRouteEtaResponse } from '../domain/route-page-detail'
import { TDX_ACCESS_TOKEN_REJECTED_CODE, TDX_ACCESS_TOKEN_REJECTED_MESSAGE } from '../domain/tdx-api-error'
import {
  isRejectedUserTdxToken,
  QueryResolutionError,
  resolveBusQuery,
  TDXServiceError,
  tdxWarningFromError,
  tdxWarningMessages,
  withTDXBackgroundTasks,
  withUserTDXAccessToken,
  type TDXEnv,
} from '../lib/tdx'
import { ApiInputError, apiInputErrorBody, parseTdxAccessToken } from '../lib/api-input'

type Env = { Bindings: TDXEnv }
const routeEta = new Hono<Env>()
const noStoreHeaders = { 'Cache-Control': 'no-store' }

routeEta.get('/api/v1/route-eta', async (c) => {
  try {
    const env = tdxEnv(c)
    const query = parseRequestQuery(c)
    const resolved = query.stopUid && query.stopName
      ? query as ResolvedBusQuery
      : await resolveBusQuery(env, query)
    const result = await getRouteEtaDetail(env, resolved)
    return c.json(toRouteEtaResponse(result), 200, noStoreHeaders)
  } catch (error) {
    return jsonError(c, error)
  }
})

function tdxEnv(c: Context<Env>): TDXEnv {
  const env = withUserTDXAccessToken(c.env, parseTdxAccessToken(c.req.header('Authorization')))
  try {
    return withTDXBackgroundTasks(env, (promise) => c.executionCtx.waitUntil(promise))
  } catch {
    return env
  }
}

function parseRequestQuery(c: Context<Env>): BusQuery {
  const input = c.req.query()
  const city = requireEnabledCity(input.city || defaultCity)
  return parseBusQuery(
    { ...input, city },
    undefined,
    supportedCityCodes,
  )
}

function jsonError(c: Context<Env>, error: unknown) {
  if (error instanceof ApiInputError) {
    return c.json(apiInputErrorBody(error), error.status, noStoreHeaders)
  }
  if (error instanceof CityNotEnabledError) {
    return c.json({ code: CITY_NOT_ENABLED_CODE, error: error.message }, 404, noStoreHeaders)
  }
  if (isRejectedUserTdxToken(error, c.req.header('Authorization'))) {
    return c.json({
      code: TDX_ACCESS_TOKEN_REJECTED_CODE,
      error: TDX_ACCESS_TOKEN_REJECTED_MESSAGE,
    }, 401, noStoreHeaders)
  }
  if (!(error instanceof QueryValidationError || error instanceof QueryResolutionError)) {
    console.error('route_eta_api_failed', error)
  }
  const status = error instanceof QueryValidationError
    ? 400
    : error instanceof QueryResolutionError ? 404
      : error instanceof TDXServiceError && error.rateLimited ? 429 : 502
  return c.json({ error: publicError(error) }, status, noStoreHeaders)
}

function publicError(error: unknown): string {
  if (error instanceof QueryValidationError || error instanceof QueryResolutionError) return error.message
  if (error instanceof TDXServiceError) return tdxWarningMessages[tdxWarningFromError(error) ?? 'tdx-unavailable']
  return '即時到站讀取失敗'
}

export default routeEta
