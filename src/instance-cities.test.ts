import { describe, expect, it } from 'vitest'
import {
  defaultCity,
  enabledCities,
  enabledCityCodes,
  requireEnabledCity,
  supportedCities,
} from './config'
import { CityNotEnabledError, CITY_NOT_ENABLED_CODE } from './domain/city-availability'
import { QueryValidationError } from './domain/bus-query'
import { instanceRuntime } from './instance-runtime'
import { presentBusApiError } from './presentation/api-error'
import { presentPageError } from './presentation/page-error'

describe('instance city scope', () => {
  it('derives the public city list and default from the runtime manifest', () => {
    expect(enabledCities.map(([code]) => code)).toEqual(instanceRuntime.transit.enabledCities)
    expect(defaultCity).toBe(instanceRuntime.transit.defaultCity)
    expect(enabledCityCodes.has(defaultCity)).toBe(true)
    expect(enabledCities.length).toBeLessThanOrEqual(supportedCities.length)
  })

  it('distinguishes a supported but disabled city from an unknown city', () => {
    const chiayiOnly = new Set(['Chiayi'])

    expect(requireEnabledCity('Chiayi', chiayiOnly)).toBe('Chiayi')
    expect(() => requireEnabledCity('Taipei', chiayiOnly)).toThrow(CityNotEnabledError)
    expect(() => requireEnabledCity('Atlantis', chiayiOnly)).toThrow(QueryValidationError)
  })

  it('publishes the disabled-city API and page contracts', () => {
    const error = new CityNotEnabledError('Taipei', '臺北市')

    expect(presentBusApiError(error)).toEqual({
      status: 404,
      body: {
        code: CITY_NOT_ENABLED_CODE,
        error: '此實例未提供該縣市：臺北市',
      },
      shouldLog: false,
    })
    expect(presentPageError(error, '/setup')).toMatchObject({
      status: 404,
      title: '這個縣市未啟用',
      message: '此實例未提供該縣市：臺北市',
    })
  })
})
