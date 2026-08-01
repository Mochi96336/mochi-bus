import { instanceRuntime } from './instance-runtime'
import { CityNotEnabledError } from './domain/city-availability'
import { QueryValidationError, type BusQuery } from './domain/bus-query'

export const supportedCities = [
  ['Taipei', '臺北市'],
  ['NewTaipei', '新北市'],
  ['Taoyuan', '桃園市'],
  ['Taichung', '臺中市'],
  ['Tainan', '臺南市'],
  ['Kaohsiung', '高雄市'],
  ['Keelung', '基隆市'],
  ['Hsinchu', '新竹市'],
  ['HsinchuCounty', '新竹縣'],
  ['MiaoliCounty', '苗栗縣'],
  ['ChanghuaCounty', '彰化縣'],
  ['NantouCounty', '南投縣'],
  ['YunlinCounty', '雲林縣'],
  ['Chiayi', '嘉義市'],
  ['ChiayiCounty', '嘉義縣'],
  ['PingtungCounty', '屏東縣'],
  ['YilanCounty', '宜蘭縣'],
  ['HualienCounty', '花蓮縣'],
  ['TaitungCounty', '臺東縣'],
  ['KinmenCounty', '金門縣'],
  ['PenghuCounty', '澎湖縣'],
  ['LienchiangCounty', '連江縣'],
] as const

const supportedCityByCode = new Map<string, (typeof supportedCities)[number]>(
  supportedCities.map((city) => [city[0], city] as const),
)

export const supportedCityCodes = new Set<string>(supportedCities.map(([code]) => code))
export const enabledCityCodes = new Set<string>(instanceRuntime.transit.enabledCities)
export const enabledCities = instanceRuntime.transit.enabledCities.map((code) => {
  const city = supportedCityByCode.get(code)
  if (!city) throw new Error(`Instance configuration references unknown city: ${code}`)
  return city
})
export const defaultCity = instanceRuntime.transit.defaultCity
export const demoBusQuery = instanceRuntime.transit.demoQuery as BusQuery | null

// No-demo instances leave the root page before this compatibility value reaches the
// legacy ETA renderer; city-scoped API defaults still use defaultCity directly.
export const defaultBusQuery: BusQuery = demoBusQuery ?? {
  city: defaultCity,
  routeName: '',
  direction: 0,
}

export function requireEnabledCity(
  city: string,
  enabledCodes: ReadonlySet<string> = enabledCityCodes,
): string {
  const normalized = city.trim()
  const supported = supportedCityByCode.get(normalized)
  if (!supported) throw new QueryValidationError(`不支援的縣市：${normalized}`)
  if (!enabledCodes.has(normalized)) throw new CityNotEnabledError(normalized, supported[1])
  return normalized
}
