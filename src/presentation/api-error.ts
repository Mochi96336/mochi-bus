import { CityNotEnabledError, CITY_NOT_ENABLED_CODE } from '../domain/city-availability'
import { QueryValidationError } from '../domain/bus-query'
import {
  TDX_ACCESS_TOKEN_REJECTED_CODE,
  TDX_ACCESS_TOKEN_REJECTED_MESSAGE,
} from '../domain/tdx-api-error'
import {
  ApiInputError,
  apiInputErrorBody,
  type ApiInputStatus,
} from '../lib/api-input'
import {
  isRejectedUserTdxToken,
  QueryResolutionError,
  TDXServiceError,
} from '../lib/tdx'
import { publicErrorMessage } from './page-error'

export type ApiErrorStatus = ApiInputStatus | 401 | 404 | 429 | 502

export type ApiErrorBody =
  | ReturnType<typeof apiInputErrorBody>
  | {
    code: typeof TDX_ACCESS_TOKEN_REJECTED_CODE
    error: typeof TDX_ACCESS_TOKEN_REJECTED_MESSAGE
  }
  | {
    code: typeof CITY_NOT_ENABLED_CODE
    error: string
  }
  | { error: string }

export type ApiErrorPresentation = {
  status: ApiErrorStatus
  body: ApiErrorBody
  shouldLog: boolean
}

/**
 * Convert an internal bus API failure into its complete public JSON contract.
 * The HTTP layer only writes the response and performs the requested logging.
 */
export function presentBusApiError(
  error: unknown,
  authorization?: string,
): ApiErrorPresentation {
  if (error instanceof ApiInputError) {
    return {
      status: error.status,
      body: apiInputErrorBody(error),
      shouldLog: false,
    }
  }

  if (error instanceof CityNotEnabledError) {
    return {
      status: 404,
      body: { code: CITY_NOT_ENABLED_CODE, error: error.message },
      shouldLog: false,
    }
  }

  if (isRejectedUserTdxToken(error, authorization)) {
    return {
      status: 401,
      body: {
        code: TDX_ACCESS_TOKEN_REJECTED_CODE,
        error: TDX_ACCESS_TOKEN_REJECTED_MESSAGE,
      },
      shouldLog: false,
    }
  }

  const isQueryError = error instanceof QueryValidationError
    || error instanceof QueryResolutionError
  const status = error instanceof QueryValidationError
    ? 400
    : error instanceof QueryResolutionError
      ? 404
      : error instanceof TDXServiceError && error.rateLimited
        ? 429
        : 502

  return {
    status,
    body: { error: publicErrorMessage(error) },
    shouldLog: !isQueryError,
  }
}
