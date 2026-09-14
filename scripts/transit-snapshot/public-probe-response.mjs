import { classifyProbeRequestFailure, readBoundedResponseJson } from './active-probe.mjs'

const RESPONSE_SIZE_SOURCES = new Set(['content_length', 'stream'])
const RESPONSE_SIZE_BUCKETS = new Set([
  'gt_limit_to_2x',
  'gt_2x_to_4x',
  'gt_4x',
  'over_limit_unknown_total',
])

export async function readPublicProbeJson(response, maximumBytes) {
  const declaredLength = parseDeclaredLength(response.headers.get('Content-Length'))
  const streamDiagnostic = declaredLength === null || declaredLength <= maximumBytes
    ? streamedLengthBucket(cloneResponseFailOpen(response), maximumBytes)
    : null
  try {
    const value = await readBoundedResponseJson(response, maximumBytes)
    if (streamDiagnostic) await streamDiagnostic
    return value
  } catch (error) {
    if (classifyProbeRequestFailure(error) !== 'body_limit') {
      if (streamDiagnostic) await streamDiagnostic
      throw error
    }
    if (declaredLength !== null && declaredLength > maximumBytes) {
      throw new PublicProbeBodyLimitError(
        'content_length',
        declaredLengthBucket(declaredLength, maximumBytes),
      )
    }
    throw new PublicProbeBodyLimitError(
      'stream',
      streamDiagnostic ? await streamDiagnostic : 'over_limit_unknown_total',
    )
  }
}

export function publicProbeBodyLimitDetail(error) {
  if (!(error instanceof PublicProbeBodyLimitError)) return null
  if (!RESPONSE_SIZE_SOURCES.has(error.responseSizeSource)
    || !RESPONSE_SIZE_BUCKETS.has(error.responseSizeBucket)) return null
  return Object.freeze({
    responseSizeSource: error.responseSizeSource,
    responseSizeBucket: error.responseSizeBucket,
  })
}

class PublicProbeBodyLimitError extends Error {
  constructor(responseSizeSource, responseSizeBucket) {
    super('Bounded response is too large')
    this.name = 'PublicProbeBodyLimitError'
    this.responseSizeSource = responseSizeSource
    this.responseSizeBucket = responseSizeBucket
  }
}

function parseDeclaredLength(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

function declaredLengthBucket(declaredLength, maximumBytes) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    return 'over_limit_unknown_total'
  }
  const ratio = declaredLength / maximumBytes
  if (ratio <= 2) return 'gt_limit_to_2x'
  if (ratio <= 4) return 'gt_2x_to_4x'
  return 'gt_4x'
}

function cloneResponseFailOpen(response) {
  try {
    return response.clone()
  } catch {
    return null
  }
}

async function streamedLengthBucket(response, maximumBytes) {
  if (!response?.body
    || !Number.isSafeInteger(maximumBytes)
    || maximumBytes < 1
    || maximumBytes > Math.floor(Number.MAX_SAFE_INTEGER / 4)) {
    await response?.body?.cancel().catch(() => undefined)
    return 'over_limit_unknown_total'
  }

  const twiceLimit = maximumBytes * 2
  const fourTimesLimit = maximumBytes * 4
  const reader = response.body.getReader()
  let bytes = 0
  try {
    while (true) {
      let result
      try {
        result = await reader.read()
      } catch {
        return 'over_limit_unknown_total'
      }
      if (result.done) {
        if (bytes <= maximumBytes) return 'over_limit_unknown_total'
        if (bytes <= twiceLimit) return 'gt_limit_to_2x'
        if (bytes <= fourTimesLimit) return 'gt_2x_to_4x'
        return 'gt_4x'
      }
      bytes += result.value.byteLength
      if (bytes > fourTimesLimit) return 'gt_4x'
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}