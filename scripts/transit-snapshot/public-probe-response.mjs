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
  try {
    return await readBoundedResponseJson(response, maximumBytes)
  } catch (error) {
    if (classifyProbeRequestFailure(error) !== 'body_limit') throw error
    if (declaredLength !== null && declaredLength > maximumBytes) {
      throw new PublicProbeBodyLimitError(
        'content_length',
        declaredLengthBucket(declaredLength, maximumBytes),
      )
    }
    throw new PublicProbeBodyLimitError('stream', 'over_limit_unknown_total')
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
