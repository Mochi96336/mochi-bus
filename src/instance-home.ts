import { defaultCity, demoBusQuery } from './config'
import type { BusQuery } from './domain/bus-query'

export function instanceHomeRedirect(
  requestUrl: string,
  method = 'GET',
  demoQuery: BusQuery | null = demoBusQuery,
  city = defaultCity,
): string | null {
  const url = new URL(requestUrl)
  if ((method !== 'GET' && method !== 'HEAD') || url.pathname !== '/' || demoQuery !== null) return null
  return `/map?${new URLSearchParams({ city }).toString()}`
}
