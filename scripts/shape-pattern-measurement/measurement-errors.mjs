import { basename } from 'node:path'

export class BoundedMeasurementError extends Error {
  constructor(message, { code, stage, details = null, cleanupFailures = [] } = {}) {
    super(message)
    this.name = 'BoundedMeasurementError'
    this.code = code ?? 'MEASUREMENT_ERROR'
    this.stage = stage ?? 'unknown'
    if (details !== null) this.details = details
    if (cleanupFailures.length) this.cleanupFailures = cleanupFailures.map(normalizeCleanupFailure)
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      stage: this.stage,
      ...(this.details === undefined ? {} : { details: this.details }),
      ...(this.cleanupFailures === undefined ? {} : { cleanupFailures: this.cleanupFailures }),
    }
  }
}

export function boundedFailure(message, { code, stage, details = null } = {}) {
  return new BoundedMeasurementError(message, { code, stage, details })
}

export function attachCleanupFailure(primary, cleanup) {
  const failure = normalizeCleanupFailure(cleanup)
  const code = boundedPrimaryCode(primary)
  const stage = typeof primary?.stage === 'string' ? primary.stage : primaryStage(code)
  const message = safePrimaryMessage(primary, code)
  const existing = Array.isArray(primary?.cleanupFailures)
    ? primary.cleanupFailures.map(normalizeCleanupFailure)
    : []
  return new BoundedMeasurementError(message, {
    code,
    stage,
    details: boundedDetails(primary?.details),
    cleanupFailures: [...existing, failure],
  })
}

export function cleanupOnlyFailure(cleanup) {
  const failure = normalizeCleanupFailure(cleanup)
  return new BoundedMeasurementError('Measurement cleanup failed.', {
    code: 'MEASUREMENT_CLEANUP_ERROR',
    stage: failure.stage,
    cleanupFailures: [failure],
  })
}

export function safeTemporaryPath(value) {
  if (typeof value !== 'string' || !value) return null
  const leaf = basename(value.trim())
  return leaf && leaf !== '.' && leaf !== '..' ? leaf.slice(0, 160) : null
}

export async function cleanupAfterFailure(primary, cleanup, descriptor) {
  try {
    await cleanup()
  } catch {
    throw attachCleanupFailure(primary, descriptor)
  }
  throw primary
}

function normalizeCleanupFailure(value = {}) {
  const stage = boundedToken(value.stage, 'cleanup')
  const temporaryPath = safeTemporaryPath(value.temporaryPath)
  return {
    stage,
    ...(temporaryPath === null ? {} : { temporaryPath }),
  }
}

function boundedToken(value, fallback) {
  if (typeof value !== 'string') return fallback
  const token = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
  return token || fallback
}

function boundedDetails(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const allowed = {}
  for (const key of ['endpointCategory', 'city', 'httpStatus', 'failureClass', 'retryCount', 'timestamp']) {
    const item = value[key]
    if (item === null || typeof item === 'boolean' || typeof item === 'number') allowed[key] = item
    else if (typeof item === 'string') allowed[key] = item.slice(0, 160)
  }
  return Object.keys(allowed).length ? allowed : null
}

function boundedPrimaryCode(primary) {
  if (typeof primary?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(primary.code)) return primary.code
  if (primary?.name === 'TDXMeasurementError') return 'TDX_MEASUREMENT_ERROR'
  return 'MEASUREMENT_ERROR'
}

function primaryStage(code) {
  if (code === 'TDX_MEASUREMENT_ERROR') return 'tdx-source'
  if (code === 'MEASUREMENT_COLLECTOR_ERROR') return 'observer-callback'
  return 'measurement'
}

function safePrimaryMessage(primary, code) {
  if (code === 'MEASUREMENT_COLLECTOR_ERROR') return 'Measurement collector failed.'
  if (code === 'MEASUREMENT_CLEANUP_ERROR') return 'Measurement cleanup failed.'
  if (code === 'TDX_MEASUREMENT_ERROR') return 'TDX measurement failed.'
  if (primary instanceof BoundedMeasurementError) return primary.message
  return 'Measurement failed.'
}
