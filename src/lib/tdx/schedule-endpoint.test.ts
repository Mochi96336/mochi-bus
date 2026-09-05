import { describe, expect, it } from 'vitest'
import type { ScheduleItem } from '../../domain/schedule'
import {
  createTDXScheduleEndpoint,
  isTDXRecordArray,
  tdxTelemetryCity,
  type TDXScheduleEndpointDependencies,
} from './schedule-endpoint'
import type { TDXEnv, TDXResolutionOptions } from './resolution-cache'

const env = {} as unknown as TDXEnv
const SCHEDULE_SELECT = 'SubRouteUID,Direction,Timetables,Frequencys'

type FetchCall = {
  url: URL
  ttlSeconds: number
  options?: TDXResolutionOptions<unknown>
}

function harness(result: ScheduleItem[] = []) {
  const calls: FetchCall[] = []
  const fetchTDXJson: TDXScheduleEndpointDependencies['fetchTDXJson'] = async <T>(
    _env: TDXEnv,
    url: URL,
    ttlSeconds: number,
    options?: TDXResolutionOptions<T>,
  ): Promise<T> => {
    calls.push({
      url,
      ttlSeconds,
      options: options as TDXResolutionOptions<unknown> | undefined,
    })
    return result as unknown as T
  }

  return {
    calls,
    endpoint: createTDXScheduleEndpoint({ fetchTDXJson }),
  }
}

describe('TDX schedule endpoint boundary', () => {
  it('builds the encoded City schedule URL, projects consumed fields and preserves the six-hour policy', async () => {
    const { calls, endpoint } = harness()

    await endpoint.getBusSchedule(env, 'NewTaipei', '藍 15')

    expect(calls).toHaveLength(1)
    expect(calls[0].url.pathname).toBe('/api/basic/v2/Bus/Schedule/City/NewTaipei/%E8%97%8D%2015')
    expect(calls[0].url.searchParams.get('$select')).toBe(SCHEDULE_SELECT)
    expect(calls[0].url.searchParams.get('$format')).toBe('JSON')
    expect(calls[0].ttlSeconds).toBe(6 * 60 * 60)
    expect(calls[0].options).toMatchObject({
      operation: 'tdx_schedule',
      city: 'NewTaipei',
    })
  })

  it('uses InterCity for THB route identities with the same projection and without leaking the city into the path', async () => {
    const { calls, endpoint } = harness()

    await endpoint.getBusSchedule(env, 'Taipei', '9001', 'THB9001')

    expect(calls[0].url.pathname).toBe('/api/basic/v2/Bus/Schedule/InterCity/9001')
    expect(calls[0].url.searchParams.get('$select')).toBe(SCHEDULE_SELECT)
    expect(calls[0].url.searchParams.get('$format')).toBe('JSON')
    expect(calls[0].options?.city).toBe('Taipei')
  })

  it('returns the resolved schedule array without remapping it', async () => {
    const schedules: ScheduleItem[] = [{
      SubRouteUID: 'TPE307-A',
      Direction: 0,
      Timetables: [],
    }]
    const { endpoint } = harness(schedules)

    await expect(endpoint.getBusSchedule(env, 'Taipei', '307')).resolves.toBe(schedules)
  })

  it('classifies supported telemetry cities and rejects unknown values', () => {
    expect(tdxTelemetryCity('Taipei')).toBe('Taipei')
    expect(tdxTelemetryCity('NewTaipei')).toBe('NewTaipei')
    expect(tdxTelemetryCity('New Taipei')).toBeNull()
    expect(tdxTelemetryCity('MoonBase')).toBeNull()
  })

  it('accepts only arrays whose entries are non-array records', () => {
    expect(isTDXRecordArray([])).toBe(true)
    expect(isTDXRecordArray([{ RouteUID: 'R1' }])).toBe(true)
    expect(isTDXRecordArray([null])).toBe(false)
    expect(isTDXRecordArray([['nested']])).toBe(false)
    expect(isTDXRecordArray(['record'])).toBe(false)
    expect(isTDXRecordArray({ RouteUID: 'R1' })).toBe(false)
  })

  it('passes the shared record-array validator into the resolution policy', async () => {
    const { calls, endpoint } = harness()

    await endpoint.getBusSchedule(env, 'Taipei', '307')

    const validate = calls[0].options?.validate
    expect(validate?.([{ Direction: 0 }])).toBe(true)
    expect(validate?.([null])).toBe(false)
  })
})
