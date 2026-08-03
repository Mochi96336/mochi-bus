import { QueryValidationError } from './bus-query'

export const CITY_NOT_ENABLED_CODE = 'city_not_enabled' as const

export class CityNotEnabledError extends QueryValidationError {
  readonly code = CITY_NOT_ENABLED_CODE
  readonly city: string

  constructor(city: string, label = city) {
    super(`此實例未提供該縣市：${label}`)
    this.name = 'CityNotEnabledError'
    this.city = city
  }
}
