import { supportedCities } from '../config'
import type { ReleaseIdentity } from './release-identity'

export const TELEMETRY_EVENT_SCHEMA = 7 as const

export const telemetryEvents = [
  'api_operation_completed',
  'tdx_resolution_completed',
  'snapshot_window_completed',
  'snapshot_probe_completed',
  'window_watchdog_completed',
  'public_probe_completed',
  'snapshot_fallback_selected',
  'rate_limit_decision',
  'circuit_state_changed',
  'release_smoke_completed',
  'frontend_boot_completed',
  'frontend_error',
] as const

export const telemetryOperations = [
  'map_routes',
  'map_route',
  'map_timetable',
  'map_network',
  'map_vehicles',
  'map_search',
  'map_nearby',
  'map_place_routes',
  'map_place_arrivals',
  'map_place',
  'map_stop_place',
  'map_direct',
  'map_transfer',
  'map_journey_eta',
  'bus_eta',
  'bus_stops',
  'bus_routes',
  'bus_stop_routes',
  'tdx_token',
  'tdx_realtime_eta',
  'tdx_vehicles',
  'snapshot_publish',
  'snapshot_validate',
  'snapshot_probe',
  'window_watchdog',
  'public_probe',
  'snapshot_rollback',
  'release_smoke',
  'frontend_boot',
  'frontend_runtime',
] as const

export const telemetryResults = ['success', 'degraded', 'empty', 'error'] as const

export const telemetrySources = [
  'realtime',
  'stale',
  'schedule',
  'snapshot',
  'fallback',
  'mixed',
  'browser',
  'worker',
  'none',
  'tdx_static',
] as const

export const telemetryFailureClasses = [
  'none',
  'input_validation',
  'local_rate_limit',
  'tdx_401',
  'tdx_429',
  'tdx_quota',
  'tdx_timeout',
  'tdx_5xx',
  'tdx_invalid_json',
  'tdx_invalid_schema',
  'network',
  'd1',
  'r2',
  'cache',
  'contract_parse',
  'asset_load',
  'bootstrap',
  'completion_missing',
  'token_rejected',
  'rate_limited',
  'quota',
  'timeout',
  'upstream_4xx',
  'upstream_5xx',
  'invalid_json',
  'invalid_schema',
  'network_error',
  'circuit_open',
  'snapshot_source_fetch',
  'snapshot_source_compare',
  'snapshot_active_pointer_read',
  'snapshot_local_validation',
  'snapshot_stage',
  'snapshot_remote_validation',
  'snapshot_activate',
  'snapshot_smoke',
  'snapshot_rollback',
  'snapshot_finalize',
  'snapshot_window_record_write',
  'active_pointer_missing',
  'active_pointer_invalid',
  'active_rows_empty',
  'route_without_pattern',
  'routing_authority_read_failed',
  'routing_authority_incomplete',
  'routing_authority_invalid',
  'manifest_missing',
  'manifest_read_failed',
  'manifest_version_mismatch',
  'manifest_count_mismatch',
  'network_missing',
  'network_version_mismatch',
  'public_routes_failed',
  'public_schema_invalid',
  'public_version_mismatch',
  'public_count_mismatch',
  'route_sample_failed',
  'place_bundle_sample_failed',
  'state_pointer_mismatch',
  'previous_unavailable',
  'shape_sample_unavailable',
  'schedule_sample_unavailable',
  'probe_record_write_failed',
  'window_terminal_missing',
  'attempt_incomplete',
  'window_record_missing',
  'probe_record_missing',
  'probe_evidence_expired',
  'window_probe_conflict',
  'active_version_conflict',
  'rollback_unavailable',
  'record_write_failed',
  'unsupported_schema',
  'watchdog_query_failed',
  'window_failed_active_healthy',
  'active_probe_failed',
  'public_source_not_snapshot',
  'reference_unavailable',
  'probe_rate_limited',
  'realtime_upstream_degraded',
  'realtime_schedule_only',
  'realtime_stale_replay',
  'journey_estimate_unknown',
  'vehicles_upstream_degraded',
  'unknown',
] as const

export const telemetryCacheResults = [
  'memory_hit',
  'edge_hit',
  'miss',
  'bypass',
  'error',
  'unknown',
  'not_applicable',
] as const

export const telemetryEmptyReasons = [
  'not_applicable',
  'no_routes',
  'no_arrivals',
  'no_vehicles',
  'identity_mismatch',
  'invalid_coordinates',
  'all_estimates_unknown',
  'upstream_failure',
  'route_object_fallback',
  'tdx_empty',
] as const

export const telemetryQualityBuckets = [
  'not_applicable',
  'complete_realtime',
  'complete_mixed',
  'complete_schedule',
  'partial_unknown',
  'all_unknown',
] as const

export const telemetryLatencyBuckets = [
  'lt_50ms',
  '50_199ms',
  '200_999ms',
  '1_3s',
  '3_6s',
  'gt_6s',
  'unknown',
] as const

export const telemetryTrafficClasses = ['user', 'synthetic', 'snapshot_publish', 'publish_smoke'] as const
export const telemetryHttpStatusClasses = ['2xx', '3xx', '4xx', '5xx', 'none'] as const
export const telemetryTdxOperations = [
  'route_catalog',
  'place_arrivals',
  'vehicle_positions',
  'journey_eta',
  'tdx_schedule',
] as const
export const telemetryCredentialScopes = ['shared', 'byok', 'none'] as const
export const telemetryResolutions = ['memory', 'edge', 'upstream', 'circuit_open', 'stale_replay', 'none'] as const
export const telemetryRetryCountBuckets = ['0', '1', '2_plus'] as const
export const telemetryDataAgeBuckets = [
  'fresh',
  'lt_1m',
  '1_5m',
  '5_30m',
  '30m_6h',
  'gt_6h',
  'unknown',
  'not_applicable',
] as const
export const telemetryWindowResults = ['published', 'unchanged', 'failed', 'none'] as const
export const telemetryVersionRoles = ['active', 'previous'] as const
export const telemetryProbeGroups = ['active_snapshot'] as const
export const telemetryWatchdogStatuses = [
  'published',
  'published_rollback_degraded',
  'unchanged_healthy',
  'unchanged_rollback_degraded',
  'failed_active_healthy',
  'failed_active_unhealthy',
  'missing',
  'record_write_failed',
  'unknown',
] as const
export const telemetryWatchdogProbeResults = ['success', 'degraded', 'error', 'missing', 'expired'] as const
export const telemetryWatchdogSignalAgeBuckets = ['same_window', 'lt_24h', '1_7d', '7_8d', 'expired', 'none'] as const

export type TelemetryEventName = typeof telemetryEvents[number]
export type TelemetryOperation = typeof telemetryOperations[number]
export type TelemetryResult = typeof telemetryResults[number]
export type TelemetrySource = typeof telemetrySources[number]
export type TelemetryFailureClass = typeof telemetryFailureClasses[number]
export type TelemetryCacheResult = typeof telemetryCacheResults[number]
export type TelemetryLatencyBucket = typeof telemetryLatencyBuckets[number]
export type TelemetryTrafficClass = typeof telemetryTrafficClasses[number]
export type TelemetryHttpStatusClass = typeof telemetryHttpStatusClasses[number]
export type TelemetryEmptyReason = typeof telemetryEmptyReasons[number]
export type TelemetryQualityBucket = typeof telemetryQualityBuckets[number]
export type TelemetryTdxOperation = typeof telemetryTdxOperations[number]
export type TelemetryCredentialScope = typeof telemetryCredentialScopes[number]
export type TelemetryResolution = typeof telemetryResolutions[number]
export type TelemetryRetryCountBucket = typeof telemetryRetryCountBuckets[number]
export type TelemetryDataAgeBucket = typeof telemetryDataAgeBuckets[number]
export type TelemetryWindowResult = typeof telemetryWindowResults[number]
export type TelemetryVersionRole = typeof telemetryVersionRoles[number]
export type TelemetryProbeGroup = typeof telemetryProbeGroups[number]
export type TelemetryWatchdogStatus = typeof telemetryWatchdogStatuses[number]
export type TelemetryWatchdogProbeResult = typeof telemetryWatchdogProbeResults[number]
export type TelemetryWatchdogSignalAgeBucket = typeof telemetryWatchdogSignalAgeBuckets[number]
export type TelemetryCity = typeof supportedCities[number][0]

export type TelemetryEnvelope = Readonly<{
  eventSchema: typeof TELEMETRY_EVENT_SCHEMA
  event: TelemetryEventName
  releaseSha: string | null
  workerVersionId: string | null
  workerCreatedAt: string | null
  deploymentId: string | null
  city: TelemetryCity | null
  operation: TelemetryOperation
  result: TelemetryResult
  source: TelemetrySource
  snapshotVersion: string | null
  httpStatusClass: TelemetryHttpStatusClass
  latencyBucket: TelemetryLatencyBucket
  cacheResult: TelemetryCacheResult
  trafficClass: TelemetryTrafficClass
  sampleProbability: number
  failureClass: TelemetryFailureClass
  emptyReason: TelemetryEmptyReason
  qualityBucket: TelemetryQualityBucket
  tdxOperation?: TelemetryTdxOperation
  credentialScope?: TelemetryCredentialScope
  resolution?: TelemetryResolution
  retryCountBucket?: TelemetryRetryCountBucket
  recoveredAfterRetry?: boolean
  dataAgeBucket?: TelemetryDataAgeBucket
  upstreamStatusClass?: TelemetryHttpStatusClass
  initialFailureClass?: TelemetryFailureClass
  windowId?: string
  windowResult?: TelemetryWindowResult
  activeVersion?: string | null
  previousVersion?: string | null
  workflowRunId?: string | null
  versionRole?: TelemetryVersionRole
  probeGroup?: TelemetryProbeGroup
  rollbackAvailable?: boolean | null
  probeCaseVersion?: number
  sampleCaseId?: string
  hardChecksPassed?: number
  diagnosticWarningCount?: number
  watchdogStatus?: TelemetryWatchdogStatus
  probeResult?: TelemetryWatchdogProbeResult
  signalAgeBucket?: TelemetryWatchdogSignalAgeBucket
  probeWindowDistance?: number | null
  errorFingerprint?: string
}>

export type TelemetrySink = (event: TelemetryEnvelope) => void
export type TelemetryEnvelopeFields = Omit<
  TelemetryEnvelope,
  'releaseSha' | 'workerVersionId' | 'workerCreatedAt' | 'deploymentId'
>

type AllowedKey = keyof TelemetryEnvelope

const allowedKeys = new Set<AllowedKey>([
  'eventSchema',
  'event',
  'releaseSha',
  'workerVersionId',
  'workerCreatedAt',
  'deploymentId',
  'city',
  'operation',
  'result',
  'source',
  'snapshotVersion',
  'httpStatusClass',
  'latencyBucket',
  'cacheResult',
  'trafficClass',
  'sampleProbability',
  'failureClass',
  'emptyReason',
  'qualityBucket',
  'tdxOperation',
  'credentialScope',
  'resolution',
  'retryCountBucket',
  'recoveredAfterRetry',
  'dataAgeBucket',
  'upstreamStatusClass',
  'initialFailureClass',
  'windowId',
  'windowResult',
  'activeVersion',
  'previousVersion',
  'workflowRunId',
  'versionRole',
  'probeGroup',
  'rollbackAvailable',
  'probeCaseVersion',
  'sampleCaseId',
  'hardChecksPassed',
  'diagnosticWarningCount',
  'watchdogStatus',
  'probeResult',
  'signalAgeBucket',
  'probeWindowDistance',
  'errorFingerprint',
])

const requiredKeys = new Set<AllowedKey>([
  'eventSchema',
  'event',
  'releaseSha',
  'workerVersionId',
  'workerCreatedAt',
  'deploymentId',
  'city',
  'operation',
  'result',
  'source',
  'snapshotVersion',
  'httpStatusClass',
  'latencyBucket',
  'cacheResult',
  'trafficClass',
  'sampleProbability',
  'failureClass',
  'emptyReason',
  'qualityBucket',
])

const cityCodes = new Set<string>(supportedCities.map(([code]) => code))
const events = new Set<string>(telemetryEvents)
const operations = new Set<string>(telemetryOperations)
const results = new Set<string>(telemetryResults)
const sources = new Set<string>(telemetrySources)
const failureClasses = new Set<string>(telemetryFailureClasses)
const cacheResults = new Set<string>(telemetryCacheResults)
const latencyBuckets = new Set<string>(telemetryLatencyBuckets)
const trafficClasses = new Set<string>(telemetryTrafficClasses)
const httpStatusClasses = new Set<string>(telemetryHttpStatusClasses)
const emptyReasons = new Set<string>(telemetryEmptyReasons)
const qualityBuckets = new Set<string>(telemetryQualityBuckets)
const tdxOperations = new Set<string>(telemetryTdxOperations)
const credentialScopes = new Set<string>(telemetryCredentialScopes)
const resolutions = new Set<string>(telemetryResolutions)
const retryCountBuckets = new Set<string>(telemetryRetryCountBuckets)
const dataAgeBuckets = new Set<string>(telemetryDataAgeBuckets)
const windowResults = new Set<string>(telemetryWindowResults)
const versionRoles = new Set<string>(telemetryVersionRoles)
const probeGroups = new Set<string>(telemetryProbeGroups)
const watchdogStatuses = new Set<string>(telemetryWatchdogStatuses)
const watchdogProbeResults = new Set<string>(telemetryWatchdogProbeResults)
const watchdogSignalAgeBuckets = new Set<string>(telemetryWatchdogSignalAgeBuckets)
const tdxUpstreamStatusClasses = new Set<string>(['2xx', '4xx', '5xx', 'none'])
const tdxOnlyKeys = [
  'tdxOperation',
  'credentialScope',
  'resolution',
  'retryCountBucket',
  'recoveredAfterRetry',
  'dataAgeBucket',
  'upstreamStatusClass',
] as const
const windowTerminalOnlyKeys = ['activeVersion', 'previousVersion', 'workflowRunId'] as const
const probeIdentityKeys = ['versionRole', 'probeGroup'] as const
const probeSampleKeys = [
  'probeCaseVersion', 'sampleCaseId', 'hardChecksPassed', 'diagnosticWarningCount',
] as const
const probeOnlyKeys = [...probeIdentityKeys, ...probeSampleKeys] as const
const watchdogOnlyKeys = ['watchdogStatus', 'probeResult', 'signalAgeBucket', 'probeWindowDistance'] as const

const safeIdentifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const safeReleaseSha = /^[a-f0-9]{40}$/
const safeErrorFingerprint = /^err_[a-f0-9]{16}$/
const sensitiveMarker = /(?:authorization|bearer\s|client[ _-]?secret|access[ _-]?token|cf-connecting-ip)/i
const safeIsoTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const allowedErrorTypes = new Set([
  'Error',
  'TypeError',
  'SyntaxError',
  'ReferenceError',
  'RangeError',
  'URIError',
  'AggregateError',
  'DOMException',
  'NetworkError',
  'AbortError',
])

export function parseTelemetryEvent(input: unknown): TelemetryEnvelope | undefined {
  try {
    const value = recordOf(input)
    if (!value || !hasExactAllowedKeys(value)) return undefined
    if (value.eventSchema !== TELEMETRY_EVENT_SCHEMA) return undefined
    if (!enumValue(value.event, events)) return undefined
    if (!nullableIdentifier(value.releaseSha, safeReleaseSha)) return undefined
    if (!nullableIdentifier(value.workerVersionId, safeIdentifier)) return undefined
    if (!nullableIdentifier(value.workerCreatedAt, safeIsoTimestamp)) return undefined
    if (!nullableIdentifier(value.deploymentId, safeIdentifier)) return undefined
    if (!(value.city === null || enumValue(value.city, cityCodes))) return undefined
    if (!enumValue(value.operation, operations)) return undefined
    if (!enumValue(value.result, results)) return undefined
    if (!enumValue(value.source, sources)) return undefined
    if (!nullableIdentifier(value.snapshotVersion, safeIdentifier)) return undefined
    if (!enumValue(value.httpStatusClass, httpStatusClasses)) return undefined
    if (!enumValue(value.latencyBucket, latencyBuckets)) return undefined
    if (!enumValue(value.cacheResult, cacheResults)) return undefined
    if (!enumValue(value.trafficClass, trafficClasses)) return undefined
    if (!sampleProbability(value.sampleProbability)) return undefined
    if (!enumValue(value.failureClass, failureClasses)) return undefined
    if (!enumValue(value.emptyReason, emptyReasons)) return undefined
    if (!enumValue(value.qualityBucket, qualityBuckets)) return undefined
    if (value.result === 'empty' && value.emptyReason === 'not_applicable') return undefined
    if (value.result !== 'empty' && value.result !== 'degraded' && value.emptyReason !== 'not_applicable') return undefined
    if ((value.result === 'success' || value.result === 'empty') && value.failureClass !== 'none') return undefined
    if (value.result === 'error' && value.failureClass === 'none') return undefined
    if (!validTdxFields(value)) return undefined
    if (!validWindowFields(value)) return undefined
    if (!validProbeFields(value)) return undefined
    if (!validWatchdogFields(value)) return undefined
    if (!validPublicProbeFields(value)) return undefined
    if (value.errorFingerprint !== undefined && !identifier(value.errorFingerprint, safeErrorFingerprint)) return undefined

    return Object.freeze({
      eventSchema: TELEMETRY_EVENT_SCHEMA,
      event: value.event as TelemetryEventName,
      releaseSha: value.releaseSha as string | null,
      workerVersionId: value.workerVersionId as string | null,
      workerCreatedAt: value.workerCreatedAt as string | null,
      deploymentId: value.deploymentId as string | null,
      city: value.city as TelemetryCity | null,
      operation: value.operation as TelemetryOperation,
      result: value.result as TelemetryResult,
      source: value.source as TelemetrySource,
      snapshotVersion: value.snapshotVersion as string | null,
      httpStatusClass: value.httpStatusClass as TelemetryHttpStatusClass,
      latencyBucket: value.latencyBucket as TelemetryLatencyBucket,
      cacheResult: value.cacheResult as TelemetryCacheResult,
      trafficClass: value.trafficClass as TelemetryTrafficClass,
      sampleProbability: value.sampleProbability as number,
      failureClass: value.failureClass as TelemetryFailureClass,
      emptyReason: value.emptyReason as TelemetryEmptyReason,
      qualityBucket: value.qualityBucket as TelemetryQualityBucket,
      ...(value.tdxOperation === undefined ? {} : { tdxOperation: value.tdxOperation as TelemetryTdxOperation }),
      ...(value.credentialScope === undefined ? {} : { credentialScope: value.credentialScope as TelemetryCredentialScope }),
      ...(value.resolution === undefined ? {} : { resolution: value.resolution as TelemetryResolution }),
      ...(value.retryCountBucket === undefined ? {} : { retryCountBucket: value.retryCountBucket as TelemetryRetryCountBucket }),
      ...(value.recoveredAfterRetry === undefined ? {} : { recoveredAfterRetry: value.recoveredAfterRetry as boolean }),
      ...(value.dataAgeBucket === undefined ? {} : { dataAgeBucket: value.dataAgeBucket as TelemetryDataAgeBucket }),
      ...(value.upstreamStatusClass === undefined ? {} : { upstreamStatusClass: value.upstreamStatusClass as TelemetryHttpStatusClass }),
      ...(value.initialFailureClass === undefined ? {} : { initialFailureClass: value.initialFailureClass as TelemetryFailureClass }),
      ...(value.windowId === undefined ? {} : { windowId: value.windowId as string }),
      ...(value.windowResult === undefined ? {} : { windowResult: value.windowResult as TelemetryWindowResult }),
      ...(value.activeVersion === undefined ? {} : { activeVersion: value.activeVersion as string | null }),
      ...(value.previousVersion === undefined ? {} : { previousVersion: value.previousVersion as string | null }),
      ...(value.workflowRunId === undefined ? {} : { workflowRunId: value.workflowRunId as string | null }),
      ...(value.versionRole === undefined ? {} : { versionRole: value.versionRole as TelemetryVersionRole }),
      ...(value.probeGroup === undefined ? {} : { probeGroup: value.probeGroup as TelemetryProbeGroup }),
      ...(value.rollbackAvailable === undefined ? {} : { rollbackAvailable: value.rollbackAvailable as boolean | null }),
      ...(value.probeCaseVersion === undefined ? {} : { probeCaseVersion: value.probeCaseVersion as number }),
      ...(value.sampleCaseId === undefined ? {} : { sampleCaseId: value.sampleCaseId as string }),
      ...(value.hardChecksPassed === undefined ? {} : { hardChecksPassed: value.hardChecksPassed as number }),
      ...(value.diagnosticWarningCount === undefined ? {} : { diagnosticWarningCount: value.diagnosticWarningCount as number }),
      ...(value.watchdogStatus === undefined ? {} : { watchdogStatus: value.watchdogStatus as TelemetryWatchdogStatus }),
      ...(value.probeResult === undefined ? {} : { probeResult: value.probeResult as TelemetryWatchdogProbeResult }),
      ...(value.signalAgeBucket === undefined ? {} : { signalAgeBucket: value.signalAgeBucket as TelemetryWatchdogSignalAgeBucket }),
      ...(value.probeWindowDistance === undefined ? {} : { probeWindowDistance: value.probeWindowDistance as number | null }),
      ...(value.errorFingerprint === undefined ? {} : { errorFingerprint: value.errorFingerprint as string }),
    })
  } catch {
    return undefined
  }
}

function validTdxFields(value: Record<string, unknown>): boolean {
  const isResolutionEvent = value.event === 'tdx_resolution_completed'
  if (!isResolutionEvent) {
    return !tdxOnlyKeys.some((key) => Object.hasOwn(value, key))
      && !Object.hasOwn(value, 'initialFailureClass')
  }
  if (!tdxOnlyKeys.every((key) => Object.hasOwn(value, key))) return false
  if (!enumValue(value.tdxOperation, tdxOperations)) return false
  if (!enumValue(value.credentialScope, credentialScopes)) return false
  if (!enumValue(value.resolution, resolutions)) return false
  if (!enumValue(value.retryCountBucket, retryCountBuckets)) return false
  if (typeof value.recoveredAfterRetry !== 'boolean') return false
  if (!enumValue(value.dataAgeBucket, dataAgeBuckets)) return false
  if (!enumValue(value.upstreamStatusClass, tdxUpstreamStatusClasses)) return false
  if (value.initialFailureClass !== undefined && !enumValue(value.initialFailureClass, failureClasses)) return false

  if ((value.resolution === 'memory' || value.resolution === 'edge')
    && (value.retryCountBucket !== '0' || value.upstreamStatusClass !== 'none')) return false
  if ((value.resolution === 'memory' || value.resolution === 'edge')
    && value.result !== 'success' && value.result !== 'empty') return false
  if (value.resolution === 'stale_replay'
    && (value.result !== 'degraded' || value.failureClass === 'none')) return false
  if (value.result === 'degraded' && value.resolution !== 'stale_replay') return false
  if (value.resolution === 'circuit_open'
    && !(value.result === 'error' && value.failureClass === 'circuit_open')) return false
  if (value.resolution === 'none' && value.result !== 'error') return false
  if ((value.resolution === 'circuit_open' || value.resolution === 'none')
    && (value.retryCountBucket !== '0' || value.upstreamStatusClass !== 'none')) return false
  const expectedCacheResult = value.resolution === 'memory' ? 'memory_hit'
    : value.resolution === 'edge' ? 'edge_hit'
      : value.resolution === 'upstream' ? 'miss'
        : 'bypass'
  if (value.cacheResult !== expectedCacheResult) return false
  const expectedOperation = value.tdxOperation === 'route_catalog' ? 'map_routes'
    : value.tdxOperation === 'place_arrivals' ? 'map_place_arrivals'
      : value.tdxOperation === 'vehicle_positions' ? 'map_vehicles'
        : value.tdxOperation === 'journey_eta' ? 'map_journey_eta'
          : 'map_timetable'
  if (value.operation !== expectedOperation) return false
  const expectedSource = value.result === 'error' ? 'none'
    : value.resolution === 'stale_replay' ? 'stale'
      : value.tdxOperation === 'route_catalog' ? 'tdx_static'
        : value.tdxOperation === 'tdx_schedule' ? 'schedule'
          : 'realtime'
  if (value.source !== expectedSource) return false
  if (value.recoveredAfterRetry === true
    && !(value.retryCountBucket !== '0' && (value.result === 'success' || value.result === 'empty'))) return false
  if (value.retryCountBucket === '0'
    && (value.recoveredAfterRetry !== false || value.initialFailureClass !== undefined)) return false
  if (value.retryCountBucket !== '0'
    && (value.initialFailureClass === undefined || value.initialFailureClass === 'none')) return false
  return true
}

function validWindowFields(value: Record<string, unknown>): boolean {
  const isWindowEvent = value.event === 'snapshot_window_completed'
  if (!isWindowEvent) {
    return !windowTerminalOnlyKeys.some((key) => Object.hasOwn(value, key))
      && (value.event === 'snapshot_probe_completed'
        || value.event === 'window_watchdog_completed'
        || !Object.hasOwn(value, 'windowId'))
      && (value.event === 'window_watchdog_completed' || !Object.hasOwn(value, 'windowResult'))
  }
  if (!Object.hasOwn(value, 'windowId') || !windowTerminalOnlyKeys.every((key) => Object.hasOwn(value, key))) return false
  if (!identifier(value.windowId, safeIdentifier)) return false
  if (!enumValue(value.windowResult, windowResults) || value.windowResult === 'none') return false
  if (!nullableIdentifier(value.activeVersion, safeIdentifier)) return false
  if (!nullableIdentifier(value.previousVersion, safeIdentifier)) return false
  if (!nullableIdentifier(value.workflowRunId, safeIdentifier)) return false
  if (value.operation !== 'snapshot_publish'
    || value.trafficClass !== 'snapshot_publish'
    || value.sampleProbability !== 1
    || value.httpStatusClass !== 'none'
    || value.cacheResult !== 'not_applicable'
    || value.emptyReason !== 'not_applicable'
    || value.qualityBucket !== 'not_applicable') return false
  if (value.snapshotVersion !== value.activeVersion) return false
  if (value.windowResult === 'failed') {
    return value.result === 'error' && value.source === 'none' && value.failureClass !== 'none'
  }
  return value.result === 'success' && value.source === 'snapshot' && value.failureClass === 'none'
}

function validProbeFields(value: Record<string, unknown>): boolean {
  const isProbeEvent = value.event === 'snapshot_probe_completed'
  if (!isProbeEvent) {
    return !probeIdentityKeys.some((key) => Object.hasOwn(value, key))
      && (value.event === 'public_probe_completed' || !probeSampleKeys.some((key) => Object.hasOwn(value, key)))
      && (value.event === 'window_watchdog_completed' || !Object.hasOwn(value, 'rollbackAvailable'))
  }
  if (!Object.hasOwn(value, 'windowId') || !probeOnlyKeys.every((key) => Object.hasOwn(value, key))) return false
  if (!identifier(value.windowId, safeIdentifier)) return false
  if (!enumValue(value.versionRole, versionRoles) || value.versionRole !== 'active') return false
  if (!enumValue(value.probeGroup, probeGroups)) return false
  if (typeof value.rollbackAvailable !== 'boolean') return false
  if (!boundedInteger(value.probeCaseVersion, 1, 1000)) return false
  if (!identifier(value.sampleCaseId, safeIdentifier)) return false
  if (!boundedInteger(value.hardChecksPassed, 0, 11)) return false
  if (!boundedInteger(value.diagnosticWarningCount, 0, 16)) return false
  if (value.operation !== 'snapshot_probe'
    || value.source !== 'snapshot'
    || value.trafficClass !== 'publish_smoke'
    || value.sampleProbability !== 1
    || value.httpStatusClass !== 'none'
    || value.cacheResult !== 'not_applicable'
    || value.emptyReason !== 'not_applicable'
    || value.qualityBucket !== 'not_applicable') return false
  if (value.result === 'success') return value.failureClass === 'none' && value.diagnosticWarningCount === 0
  if (value.result === 'degraded') return value.failureClass !== 'none' && Number(value.diagnosticWarningCount) > 0
  return value.result === 'error' && value.failureClass !== 'none'
}

function validWatchdogFields(value: Record<string, unknown>): boolean {
  const isWatchdogEvent = value.event === 'window_watchdog_completed'
  if (!isWatchdogEvent) return !watchdogOnlyKeys.some((key) => Object.hasOwn(value, key))
  if (!watchdogOnlyKeys.every((key) => Object.hasOwn(value, key))
    || !Object.hasOwn(value, 'windowId')
    || !Object.hasOwn(value, 'windowResult')
    || !Object.hasOwn(value, 'rollbackAvailable')) return false
  if (!identifier(value.windowId, safeIdentifier)) return false
  if (!enumValue(value.windowResult, windowResults)) return false
  if (!enumValue(value.watchdogStatus, watchdogStatuses)) return false
  if (!enumValue(value.probeResult, watchdogProbeResults)) return false
  if (!enumValue(value.signalAgeBucket, watchdogSignalAgeBuckets)) return false
  if (!(value.rollbackAvailable === null || typeof value.rollbackAvailable === 'boolean')) return false
  if (!(value.probeWindowDistance === null || boundedInteger(value.probeWindowDistance, 0, 52))) return false
  if (value.operation !== 'window_watchdog'
    || value.trafficClass !== 'synthetic'
    || value.sampleProbability !== 1
    || value.httpStatusClass !== 'none'
    || value.cacheResult !== 'not_applicable'
    || value.emptyReason !== 'not_applicable'
    || value.qualityBucket !== 'not_applicable') return false

  const status = value.watchdogStatus
  const healthy = status === 'published' || status === 'unchanged_healthy'
  const degraded = status === 'published_rollback_degraded'
    || status === 'unchanged_rollback_degraded'
    || status === 'failed_active_healthy'
  if (healthy && !(value.result === 'success' && value.failureClass === 'none')) return false
  if (degraded && !(value.result === 'degraded' && value.failureClass !== 'none')) return false
  if (!healthy && !degraded && !(value.result === 'error' && value.failureClass !== 'none')) return false
  if (status === 'published'
    && !(value.windowResult === 'published' && value.probeResult === 'success')) return false
  if (status === 'published_rollback_degraded'
    && !(value.windowResult === 'published'
      && value.probeResult === 'degraded'
      && value.rollbackAvailable === false)) return false
  if (status === 'unchanged_healthy'
    && !(value.windowResult === 'unchanged' && value.probeResult === 'success' && value.rollbackAvailable === true)) return false
  if (status === 'unchanged_rollback_degraded'
    && !(value.windowResult === 'unchanged'
      && (value.probeResult === 'success' || value.probeResult === 'degraded')
      && value.rollbackAvailable === false)) return false
  if (status === 'failed_active_healthy'
    && !(value.windowResult === 'failed'
      && (value.probeResult === 'success' || value.probeResult === 'degraded'))) return false
  if (status === 'failed_active_unhealthy'
    && !(value.windowResult === 'failed' && value.probeResult === 'error')) return false
  if (status === 'missing' && value.windowResult !== 'none') return false
  if (value.source !== (value.windowResult === 'none' ? 'none' : 'snapshot')) return false
  return true
}

function validPublicProbeFields(value: Record<string, unknown>): boolean {
  if (value.event !== 'public_probe_completed') return true
  if (!probeSampleKeys.every((key) => Object.hasOwn(value, key))) return false
  if (!boundedInteger(value.probeCaseVersion, 1, 1000)) return false
  if (!identifier(value.sampleCaseId, safeIdentifier)) return false
  if (!boundedInteger(value.hardChecksPassed, 0, 10)) return false
  if (!boundedInteger(value.diagnosticWarningCount, 0, 16)) return false
  if (value.operation !== 'public_probe'
    || value.trafficClass !== 'synthetic'
    || value.sampleProbability !== 1
    || value.httpStatusClass !== 'none'
    || value.cacheResult !== 'not_applicable'
    || value.emptyReason !== 'not_applicable'
    || value.qualityBucket !== 'not_applicable') return false
  // Snapshot hard health and realtime health are separate planes: degraded
  // events keep source 'snapshot' because the snapshot plane stayed green.
  if (value.result === 'success') {
    return value.failureClass === 'none'
      && value.diagnosticWarningCount === 0
      && value.source === 'snapshot'
      && value.hardChecksPassed === 10
  }
  if (value.result === 'degraded') {
    return value.failureClass !== 'none'
      && Number(value.diagnosticWarningCount) > 0
      && value.source === 'snapshot'
      && value.hardChecksPassed === 10
  }
  return value.result === 'error' && value.failureClass !== 'none' && value.source === 'none'
}

export function createTelemetryEnvelope(
  identity: ReleaseIdentity,
  fields: TelemetryEnvelopeFields,
): TelemetryEnvelope | undefined {
  try {
    return parseTelemetryEvent({
      ...fields,
      releaseSha: identity.releaseSha,
      workerVersionId: identity.workerVersionId,
      workerCreatedAt: identity.workerCreatedAt,
      deploymentId: identity.deploymentId,
    })
  } catch {
    return undefined
  }
}

export function emitTelemetry(input: unknown, sink: TelemetrySink = (event) => console.log(event)): boolean {
  try {
    const event = parseTelemetryEvent(input)
    if (!event) return false
    sink(event)
    return true
  } catch {
    return false
  }
}

export function latencyBucket(milliseconds: number): TelemetryLatencyBucket {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return 'unknown'
  if (milliseconds < 50) return 'lt_50ms'
  if (milliseconds < 200) return '50_199ms'
  if (milliseconds < 1_000) return '200_999ms'
  if (milliseconds < 3_000) return '1_3s'
  if (milliseconds <= 6_000) return '3_6s'
  return 'gt_6s'
}

export function httpStatusClass(status: number | undefined): TelemetryHttpStatusClass {
  if (!Number.isInteger(status) || status === undefined || status < 200 || status > 599) return 'none'
  return `${Math.floor(status / 100)}xx` as TelemetryHttpStatusClass
}

export async function errorFingerprint(input: {
  errorType: unknown
  assetUrl?: unknown
  line?: unknown
}): Promise<string | undefined> {
  try {
    const errorType = sanitizedErrorType(input.errorType)
    const asset = assetBasename(input.assetUrl)
    const line = lineBucket(input.line)
    const bytes = new TextEncoder().encode(`${errorType}|${asset}|${line}`)
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    const hex = [...new Uint8Array(digest)]
      .slice(0, 8)
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
    return `err_${hex}`
  } catch {
    return undefined
  }
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function hasExactAllowedKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value)
  return keys.every((key) => allowedKeys.has(key as AllowedKey))
    && [...requiredKeys].every((key) => Object.hasOwn(value, key))
}

function enumValue(value: unknown, allowed: ReadonlySet<string>): value is string {
  return typeof value === 'string' && allowed.has(value)
}

function nullableIdentifier(value: unknown, pattern: RegExp): value is string | null {
  return value === null || identifier(value, pattern)
}

function identifier(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string'
    && pattern.test(value)
    && !sensitiveMarker.test(value)
}

function sampleProbability(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value > 0
    && value <= 1
}

function boundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum
}

function sanitizedErrorType(value: unknown): string {
  return typeof value === 'string' && allowedErrorTypes.has(value) ? value : 'Error'
}

function assetBasename(value: unknown): string {
  if (typeof value !== 'string' || !value) return 'unknown'
  try {
    const path = new URL(value, 'https://telemetry.invalid').pathname
    const basename = path.split('/').filter(Boolean).at(-1)
    return basename && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.(?:css|html|js|mjs|map)$/.test(basename)
      ? basename
      : 'unknown'
  } catch {
    return 'unknown'
  }
}

function lineBucket(value: unknown): string {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return 'unknown'
  if (value > 1_000) return '1001_plus'
  const start = Math.floor((value - 1) / 25) * 25 + 1
  return `${start}_${start + 24}`
}
