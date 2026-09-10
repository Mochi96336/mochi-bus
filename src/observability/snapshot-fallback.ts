import { supportedCityCodes } from '../config'
import { ORGANIC_API_SAMPLE_PROBABILITY } from './api-operation'
import { releaseIdentity } from './release-identity'
import {
  createTelemetryEnvelope,
  emitTelemetry,
  TELEMETRY_EVENT_SCHEMA,
  type TelemetryOperation,
  type TelemetrySink,
} from './telemetry'

export const snapshotFallbackFailureClasses = [
  'manifest_missing',
  'manifest_read_failed',
  'routing_authority_incomplete',
  'routing_authority_invalid',
  'r2',
] as const

export type SnapshotFallbackFailureClass = typeof snapshotFallbackFailureClasses[number]

export type SnapshotFallbackOperation = Extract<
  TelemetryOperation,
  'map_search' | 'map_stop_place' | 'bus_stop_routes'
>

export type SnapshotFallbackObservation = Readonly<{
  city: string
  snapshotVersion: string
  reason: SnapshotFallbackFailureClass
}>

type SnapshotFallbackReporterOptions = Readonly<{
  operation: SnapshotFallbackOperation
  versionMetadata?: CloudflareBindings['CF_VERSION_METADATA']
  random?: () => number
  emitter?: TelemetrySink
}>

const failureClasses = new Set<string>(snapshotFallbackFailureClasses)

/**
 * Request-scoped reporter for an internal snapshot -> compatibility fallback.
 *
 * A single request may try the same StopUID lookup more than once while moving
 * through snapshot-first and legacy compatibility paths. Emit at most one event
 * per reporter so telemetry measures affected requests rather than internal
 * retry/invocation count. Organic traffic uses the same 10% sampling boundary
 * as api_operation_completed.
 */
export function createSnapshotFallbackReporter(
  options: SnapshotFallbackReporterOptions,
): (observation: SnapshotFallbackObservation) => boolean {
  const probability = ORGANIC_API_SAMPLE_PROBABILITY
  const sampled = decideSample(probability, options.random ?? Math.random)
  const identity = releaseIdentity(options.versionMetadata)
  let completed = false

  return (observation) => {
    if (completed || !sampled) return false
    if (!supportedCityCodes.has(observation.city)) return false
    if (!failureClasses.has(observation.reason)) return false
    completed = true

    try {
      const event = createTelemetryEnvelope(identity, {
        eventSchema: TELEMETRY_EVENT_SCHEMA,
        event: 'snapshot_fallback_selected',
        city: observation.city,
        operation: options.operation,
        result: 'degraded',
        source: 'fallback',
        snapshotVersion: observation.snapshotVersion,
        httpStatusClass: 'none',
        latencyBucket: 'unknown',
        cacheResult: 'bypass',
        trafficClass: 'user',
        sampleProbability: probability,
        failureClass: observation.reason,
        emptyReason: 'not_applicable',
        qualityBucket: 'not_applicable',
      })
      if (!event) return false
      return options.emitter ? emitTelemetry(event, options.emitter) : emitTelemetry(event)
    } catch {
      return false
    }
  }
}

function decideSample(probability: number, random: () => number): boolean {
  try {
    const value = random()
    return Number.isFinite(value) && value >= 0 && value < probability
  } catch {
    return false
  }
}
