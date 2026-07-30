import type { DrawerSize } from './drawer-view'
import type { RouteTimetable, TimetableService } from './map-api-client'

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
  const serviceTabRows = timetable.services.length > 1 ? 1 : 0
  const persistentRows = 2 + timedStopSelectorRows + serviceTabRows
  const serviceRows = Math.max(0, ...timetable.services.map(timetableServiceRows))
  const visibleRows = persistentRows + serviceRows

  if (visibleRows <= 5) return 'compact'
  if (visibleRows <= 9) return 'standard'
  if (visibleRows <= 14) return 'tall'
  return 'expanded'
}

function timetableServiceRows(service: TimetableService): number {
  const hourRows = new Set(service.times.map((time) => time.split(':', 1)[0])).size
  return hourRows + service.periods.length
}
