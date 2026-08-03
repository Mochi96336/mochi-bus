import { CityNotEnabledError } from '../domain/city-availability'
import { QueryValidationError } from '../domain/bus-query'
import {
  QueryResolutionError,
  TDXServiceError,
  tdxWarningFromError,
  tdxWarningMessages,
} from '../lib/tdx'

export type PageErrorStatus = 400 | 404 | 429 | 503

export type PageErrorAction = {
  href: string
  label: string
}

export type PageErrorPresentation = {
  status: PageErrorStatus
  title: string
  message: string
  actions: PageErrorAction[]
}

const queryErrorTitle = '找不到這班公車'
const serviceErrorTitle = '暫時無法取得公車資料'

export function publicErrorMessage(error: unknown): string {
  if (error instanceof QueryValidationError || error instanceof QueryResolutionError) return error.message
  if (error instanceof TDXServiceError) {
    return tdxWarningMessages[tdxWarningFromError(error) ?? 'tdx-unavailable']
  }
  return serviceErrorTitle
}

/**
 * Convert an internal Route-page failure into the complete public presentation
 * contract. The HTTP handler only renders this model; it does not classify errors.
 */
export function presentPageError(error: unknown, setupUrl: string): PageErrorPresentation {
  const message = publicErrorMessage(error)

  if (error instanceof CityNotEnabledError) {
    return {
      status: 404,
      title: '這個縣市未啟用',
      message,
      actions: [{ href: '/map', label: '查看此實例提供的縣市' }],
    }
  }

  if (error instanceof QueryValidationError) {
    return {
      status: 400,
      title: queryErrorTitle,
      message,
      actions: [{ href: setupUrl, label: '重新選擇路線與站牌' }],
    }
  }

  if (error instanceof QueryResolutionError) {
    return {
      status: 404,
      title: queryErrorTitle,
      message,
      actions: [{ href: setupUrl, label: '重新選擇路線與站牌' }],
    }
  }

  return {
    status: error instanceof TDXServiceError && error.rateLimited ? 429 : 503,
    title: serviceErrorTitle,
    message,
    actions: [
      { href: '/', label: '回到首頁' },
      { href: '/map', label: '打開地圖' },
    ],
  }
}
