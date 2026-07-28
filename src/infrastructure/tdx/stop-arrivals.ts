import type { BusETAItem } from '../../lib/tdx'
import { tdxRouteScope } from '../../lib/tdx'

export type StopArrivalCandidate = {
  routeUid: string
  routeName: string
  stopUid: string
}

export type StopArrivalBatch = {
  scope: string
  stopUids: string[]
  candidates: StopArrivalCandidate[]
  cacheKey: string
  url: URL
}

export type StopArrivalPayloadIssue =
  | 'invalid_record'
  | 'invalid_route_uid'
  | 'invalid_stop_uid'
  | 'out_of_scope_stop_uid'
  | 'invalid_sub_route_uid'
  | 'invalid_direction'
  | 'invalid_estimate_time'
  | 'invalid_stop_status'

export type StopArrivalBatchParseResult =
  | {
      ok: true
      data: BusETAItem[]
      totalRows: number
      droppedRows: number
      issueCounts: Partial<Record<StopArrivalPayloadIssue, number>>
      unknownDirectionValues: number[]
    }
  | {
      ok: false
      reason: 'not_array' | 'too_many_records'
      totalRows: number | null
    }

const MAX_STOP_UIDS_PER_BATCH = 12
export const STOP_ARRIVAL_MAX_RESPONSE_BYTES = 512 * 1024
const MAX_STOP_ARRIVAL_RECORDS = 500
const KNOWN_DIRECTIONS = new Set([0, 1, 2])
const STOP_ARRIVAL_SELECT = [
  'RouteUID',
  'SubRouteUID',
  'StopUID',
  'Direction',
  'EstimateTime',
  'StopStatus',
].join(',')

export function buildStopArrivalBatches(
  city: string,
  candidates: StopArrivalCandidate[],
  maxStopUidsPerBatch = MAX_STOP_UIDS_PER_BATCH,
): StopArrivalBatch[] {
  const safeBatchSize = Number.isFinite(maxStopUidsPerBatch)
    ? Math.max(1, Math.floor(maxStopUidsPerBatch))
    : MAX_STOP_UIDS_PER_BATCH
  const candidatesByScope = new Map<string, StopArrivalCandidate[]>()

  for (const candidate of candidates) {
    const scope = tdxRouteScope(city, candidate.routeUid)
    const scoped = candidatesByScope.get(scope)
    if (scoped) scoped.push(candidate)
    else candidatesByScope.set(scope, [candidate])
  }

  return [...candidatesByScope.entries()]
    .sort(([a], [b]) => scopeRank(a) - scopeRank(b) || a.localeCompare(b))
    .flatMap(([scope, scopedCandidates]) => {
      const stopUids = [...new Set(scopedCandidates.map((candidate) => candidate.stopUid))].sort()
      const batches: StopArrivalBatch[] = []

      for (let index = 0; index < stopUids.length; index += safeBatchSize) {
        const chunk = stopUids.slice(index, index + safeBatchSize)
        const allowed = new Set(chunk)
        const batchCandidates = scopedCandidates.filter((candidate) => allowed.has(candidate.stopUid))
        const routeUids = [...new Set(batchCandidates.map((candidate) => candidate.routeUid))].sort()
        batches.push({
          scope,
          stopUids: chunk,
          candidates: batchCandidates,
          cacheKey: `stop-batch:v2:${scope}:${JSON.stringify(chunk)}:${JSON.stringify(routeUids)}`,
          url: stopArrivalBatchUrl(scope, chunk, routeUids),
        })
      }

      return batches
    })
}

export function isStopArrivalBatchEnvelope(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length <= MAX_STOP_ARRIVAL_RECORDS
}

export function parseStopArrivalBatchPayload(
  value: unknown,
  allowedStopUids: readonly string[],
): StopArrivalBatchParseResult {
  if (!Array.isArray(value)) return { ok: false, reason: 'not_array', totalRows: null }
  if (value.length > MAX_STOP_ARRIVAL_RECORDS) {
    return { ok: false, reason: 'too_many_records', totalRows: value.length }
  }

  const allowed = new Set(allowedStopUids)
  const data: BusETAItem[] = []
  const issueCounts: Partial<Record<StopArrivalPayloadIssue, number>> = {}
  const unknownDirections = new Set<number>()
  const issue = (kind: StopArrivalPayloadIssue): void => {
    issueCounts[kind] = (issueCounts[kind] ?? 0) + 1
  }

  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      issue('invalid_record')
      continue
    }

    const record = item as Record<string, unknown>
    if (typeof record.RouteUID !== 'string') {
      issue('invalid_route_uid')
      continue
    }
    if (typeof record.StopUID !== 'string') {
      issue('invalid_stop_uid')
      continue
    }
    if (!allowed.has(record.StopUID)) {
      issue('out_of_scope_stop_uid')
      continue
    }

    const normalized: BusETAItem = {
      RouteUID: record.RouteUID,
      StopUID: record.StopUID,
    }

    if (typeof record.SubRouteUID === 'string') normalized.SubRouteUID = record.SubRouteUID
    else if (record.SubRouteUID !== undefined && record.SubRouteUID !== null) issue('invalid_sub_route_uid')

    if (isFiniteInteger(record.Direction)) {
      normalized.Direction = record.Direction
      if (!KNOWN_DIRECTIONS.has(record.Direction)) unknownDirections.add(record.Direction)
    } else if (record.Direction !== undefined && record.Direction !== null) {
      issue('invalid_direction')
    }

    if (record.EstimateTime === null) normalized.EstimateTime = null
    else if (isFiniteNumber(record.EstimateTime)) normalized.EstimateTime = record.EstimateTime
    else if (record.EstimateTime !== undefined) {
      normalized.EstimateTime = null
      issue('invalid_estimate_time')
    }

    if (isFiniteNumber(record.StopStatus)) normalized.StopStatus = record.StopStatus
    else if (record.StopStatus !== undefined && record.StopStatus !== null) issue('invalid_stop_status')

    data.push(normalized)
  }

  return {
    ok: true,
    data,
    totalRows: value.length,
    droppedRows: value.length - data.length,
    issueCounts,
    unknownDirectionValues: [...unknownDirections].sort((a, b) => a - b),
  }
}

function stopArrivalBatchUrl(
  scope: string,
  stopUids: readonly string[],
  routeUids: readonly string[],
): URL {
  const url = new URL(`https://tdx.transportdata.tw/api/basic/v2/Bus/EstimatedTimeOfArrival/${scope}`)
  const stopFilter = stopUids
    .map((stopUid) => `StopUID eq '${escapeODataString(stopUid)}'`)
    .join(' or ')
  const routeFilter = routeUids
    .map((routeUid) => `RouteUID eq '${escapeODataString(routeUid)}'`)
    .join(' or ')
  url.searchParams.set('$filter', `(${stopFilter}) and (${routeFilter})`)
  url.searchParams.set('$select', STOP_ARRIVAL_SELECT)
  url.searchParams.set('$format', 'JSON')
  return url
}

function escapeODataString(value: string): string {
  return value.replaceAll("'", "''")
}

function isFiniteInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function scopeRank(scope: string): number {
  return scope.startsWith('City/') ? 0 : 1
}
