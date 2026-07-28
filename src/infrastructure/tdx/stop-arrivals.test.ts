import { describe, expect, it } from 'vitest'
import {
  buildStopArrivalBatches,
  isStopArrivalBatchEnvelope,
  parseStopArrivalBatchPayload,
} from './stop-arrivals'

describe('stop arrival TDX batches', () => {
  it('groups city candidates into one deterministic StopUID and RouteUID query', () => {
    const [batch] = buildStopArrivalBatches('Taipei', [
      { routeUid: 'TPE2', routeName: '299', stopUid: 'STOP2' },
      { routeUid: 'TPE1', routeName: '307', stopUid: 'STOP1' },
      { routeUid: 'TPE3', routeName: '藍1', stopUid: 'STOP1' },
    ])

    expect(batch.scope).toBe('City/Taipei')
    expect(batch.stopUids).toEqual(['STOP1', 'STOP2'])
    expect(batch.candidates).toHaveLength(3)
    expect(batch.url.pathname).toBe('/api/basic/v2/Bus/EstimatedTimeOfArrival/City/Taipei')
    expect(batch.url.searchParams.get('$filter')).toBe(
      "(StopUID eq 'STOP1' or StopUID eq 'STOP2') and (RouteUID eq 'TPE1' or RouteUID eq 'TPE2' or RouteUID eq 'TPE3')",
    )
    expect(batch.url.searchParams.get('$select')).toBe(
      'RouteUID,SubRouteUID,StopUID,Direction,EstimateTime,StopStatus',
    )
    expect(batch.url.searchParams.get('$format')).toBe('JSON')
  })

  it('separates city and intercity scopes and keeps city first', () => {
    const batches = buildStopArrivalBatches('Taipei', [
      { routeUid: 'THB1001', routeName: '國道客運', stopUid: 'THB_STOP' },
      { routeUid: 'TPE1', routeName: '307', stopUid: 'CITY_STOP' },
    ])

    expect(batches.map((batch) => batch.scope)).toEqual(['City/Taipei', 'InterCity'])
    expect(batches.map((batch) => batch.stopUids)).toEqual([['CITY_STOP'], ['THB_STOP']])
    expect(new Set(batches.map((batch) => batch.cacheKey)).size).toBe(2)
  })

  it('chunks oversized StopUID sets without duplicating candidates', () => {
    const batches = buildStopArrivalBatches('Taipei', [
      { routeUid: 'TPE1', routeName: '1', stopUid: 'STOP1' },
      { routeUid: 'TPE2', routeName: '2', stopUid: 'STOP2' },
      { routeUid: 'TPE3', routeName: '3', stopUid: 'STOP3' },
    ], 2)

    expect(batches.map((batch) => batch.stopUids)).toEqual([['STOP1', 'STOP2'], ['STOP3']])
    expect(batches.flatMap((batch) => batch.candidates).map((candidate) => candidate.routeUid).sort())
      .toEqual(['TPE1', 'TPE2', 'TPE3'])
    expect(batches[0].url.searchParams.get('$filter')).toBe(
      "(StopUID eq 'STOP1' or StopUID eq 'STOP2') and (RouteUID eq 'TPE1' or RouteUID eq 'TPE2')",
    )
    expect(batches[1].url.searchParams.get('$filter')).toBe(
      "(StopUID eq 'STOP3') and (RouteUID eq 'TPE3')",
    )
  })

  it('changes the cache identity when the candidate RouteUID set changes', () => {
    const [wide] = buildStopArrivalBatches('Taipei', [
      { routeUid: 'TPE1', routeName: '1', stopUid: 'STOP1' },
      { routeUid: 'TPE2', routeName: '2', stopUid: 'STOP1' },
    ])
    const [narrow] = buildStopArrivalBatches('Taipei', [
      { routeUid: 'TPE1', routeName: '1', stopUid: 'STOP1' },
    ])

    expect(wide.cacheKey).not.toBe(narrow.cacheKey)
  })

  it('accepts a bounded array envelope without requiring every row to be perfect', () => {
    expect(isStopArrivalBatchEnvelope([
      { RouteUID: 'TPE1', StopUID: 'STOP1', Direction: 255 },
      'malformed-row',
    ])).toBe(true)
    expect(isStopArrivalBatchEnvelope({ value: [] })).toBe(false)
    expect(isStopArrivalBatchEnvelope(Array.from({ length: 501 }, () => null))).toBe(false)
  })

  it('preserves arbitrary finite integer directions including 255', () => {
    const parsed = parseStopArrivalBatchPayload([{
      RouteUID: 'TPE1',
      SubRouteUID: null,
      StopUID: 'STOP1',
      Direction: 255,
      EstimateTime: null,
      StopStatus: null,
    }], ['STOP1'])

    expect(parsed).toMatchObject({
      ok: true,
      totalRows: 1,
      droppedRows: 0,
      unknownDirectionValues: [255],
      data: [{
        RouteUID: 'TPE1',
        StopUID: 'STOP1',
        Direction: 255,
        EstimateTime: null,
      }],
    })
  })

  it('keeps valid rows when neighboring rows are malformed or out of scope', () => {
    const parsed = parseStopArrivalBatchPayload([
      { RouteUID: 'TPE1', StopUID: 'STOP1', Direction: 0, EstimateTime: 120, StopStatus: 0 },
      { StopUID: 'STOP1', Direction: 0 },
      { RouteUID: 'TPE2', StopUID: 'OTHER_STOP', Direction: 1 },
      null,
    ], ['STOP1'])

    expect(parsed).toMatchObject({
      ok: true,
      totalRows: 4,
      droppedRows: 3,
      data: [{ RouteUID: 'TPE1', StopUID: 'STOP1', Direction: 0, EstimateTime: 120, StopStatus: 0 }],
      issueCounts: {
        invalid_route_uid: 1,
        out_of_scope_stop_uid: 1,
        invalid_record: 1,
      },
    })
  })

  it('normalizes invalid optional fields instead of rejecting the row', () => {
    const parsed = parseStopArrivalBatchPayload([{
      RouteUID: 'TPE1',
      SubRouteUID: 123,
      StopUID: 'STOP1',
      Direction: '0',
      EstimateTime: 'soon',
      StopStatus: 'normal',
      UnexpectedField: true,
    }], ['STOP1'])

    expect(parsed).toMatchObject({
      ok: true,
      droppedRows: 0,
      data: [{ RouteUID: 'TPE1', StopUID: 'STOP1', EstimateTime: null }],
      issueCounts: {
        invalid_sub_route_uid: 1,
        invalid_direction: 1,
        invalid_estimate_time: 1,
        invalid_stop_status: 1,
      },
    })
  })

  it('rejects only an invalid outer envelope', () => {
    expect(parseStopArrivalBatchPayload({ value: [] }, ['STOP1']))
      .toEqual({ ok: false, reason: 'not_array', totalRows: null })
    expect(parseStopArrivalBatchPayload(Array.from({ length: 501 }, () => ({
      RouteUID: 'TPE1',
      StopUID: 'STOP1',
      Direction: 0,
    })), ['STOP1'])).toEqual({ ok: false, reason: 'too_many_records', totalRows: 501 })
  })
})
