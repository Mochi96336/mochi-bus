import { describe, expect, it } from 'vitest'
import type { RouteTimetable, TimetableService } from './map-api-client'
import {
  placeRoutesDrawerSize,
  routeVariantsDrawerSize,
  timetableDrawerSize,
} from './drawer-content-size'

function service(overrides: Partial<TimetableService> = {}): TimetableService {
  return {
    id: 'weekday',
    label: '平日',
    days: [1, 2, 3, 4, 5],
    today: true,
    times: [],
    periods: [],
    firstTime: null,
    lastTime: null,
    ...overrides,
  }
}

function timetable(overrides: Partial<RouteTimetable> = {}): RouteTimetable {
  return {
    mode: 'departure',
    selectedStop: null,
    departureStop: null,
    stops: [],
    timedStopCount: 0,
    services: [service()],
    ...overrides,
  }
}

describe('data-driven drawer sizes', () => {
  it('uses more desktop space only when a stop has enough directions', () => {
    expect(placeRoutesDrawerSize(0)).toBe('compact')
    expect(placeRoutesDrawerSize(3)).toBe('compact')
    expect(placeRoutesDrawerSize(4)).toBe('standard')
    expect(placeRoutesDrawerSize(7)).toBe('standard')
    expect(placeRoutesDrawerSize(8)).toBe('tall')
  })

  it('sizes a variant picker from its option count', () => {
    expect(routeVariantsDrawerSize(2)).toBe('compact')
    expect(routeVariantsDrawerSize(5)).toBe('standard')
    expect(routeVariantsDrawerSize(9)).toBe('tall')
  })

  it('keeps empty and short timetables compact', () => {
    expect(timetableDrawerSize(timetable({ mode: 'none', services: [] }))).toBe('compact')
    expect(timetableDrawerSize(timetable({
      services: [service({ times: ['06:10', '06:40', '07:10'] })],
    }))).toBe('compact')
  })

  it('uses the largest service day so tabs do not resize the drawer', () => {
    expect(timetableDrawerSize(timetable({
      services: [
        service({ id: 'weekday', times: ['06:10'] }),
        service({
          id: 'holiday',
          label: '假日',
          today: false,
          times: ['06:10', '07:10', '08:10', '09:10', '10:10', '11:10'],
        }),
      ],
    }))).toBe('standard')
  })

  it('promotes long timetable content through tall and expanded states', () => {
    expect(timetableDrawerSize(timetable({
      services: [service({
        times: Array.from({ length: 10 }, (_, hour) => `${String(hour + 6).padStart(2, '0')}:10`),
      })],
    }))).toBe('tall')

    expect(timetableDrawerSize(timetable({
      services: [service({
        times: Array.from({ length: 15 }, (_, hour) => `${String(hour + 5).padStart(2, '0')}:10`),
      })],
    }))).toBe('expanded')
  })
})
