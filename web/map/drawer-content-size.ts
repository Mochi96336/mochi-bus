import type { DrawerSize } from './drawer-view'
import type { RouteTimetable, TimetableService } from './map-api-client'

const MINUTE_CHIPS_PER_VISUAL_ROW = 7
const SERVICE_TABS_PER_VISUAL_ROW = 4

export function placeRoutesDrawerSize(routeCount: number): DrawerSize {
  if (routeCount === 0) return 'compact'
  if (routeCount <= 7) return 'standard'
  return 'tall'
}

export function routeVariantsDrawerSize(variantCount: number): DrawerSize {
  if (variantCount <= 3) return 'compact'
  if (variantCount <= 7) return 'standard'
  return 'tall'
}

export function timetableDrawerSize(timetable: RouteTimetable): DrawerSize {
  if (timetable.mode === 'none' || timetable.services.length === 0) return 'compact'

  const timedStopSelectorRows = timetable.mode === 'stop'
    && timetable.stops.filter((stop) => stop.hasTimes).length > 1
    ? 1
    : 0
  const serviceTabRows = timetable.services.length > 1
    ? Math.ceil(timetable.services.length / SERVICE_TABS_PER_VISUAL_ROW)
    : 0
  const persistentRows = 2 + timedStopSelectorRows + serviceTabRows
  const serviceRows = Math.max(0, ...timetable.services.map(timetableServiceRows))
  const visibleRows = persistentRows + serviceRows

  if (visibleRows <= 5) return 'compact'
  if (visibleRows <= 9) return 'standard'
  if (visibleRows <= 14) return 'tall'
  return 'expanded'
}

function timetableServiceRows(service: TimetableService): number {
  const minutesByHour = new Map<string, number>()
  for (const time of service.times) {
    const hour = time.split(':', 1)[0]
    minutesByHour.set(hour, (minutesByHour.get(hour) ?? 0) + 1)
  }
  const hourRows = [...minutesByHour.values()]
    .reduce((total, minuteCount) => total + Math.ceil(minuteCount / MINUTE_CHIPS_PER_VISUAL_ROW), 0)
  return hourRows + service.periods.length
}
