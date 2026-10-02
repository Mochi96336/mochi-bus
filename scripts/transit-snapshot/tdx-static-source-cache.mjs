import { createHash } from 'node:crypto'

const STATE_MAX_BYTES = 32 * 1024
const PAYLOAD_MAX_BYTES = 64 * 1024 * 1024
const PAYLOAD_CHUNK_BYTES = 16 * 1024 * 1024
const PROMOTED_PAYLOAD_MAX_BYTES = 256 * 1024 * 1024
const OVERSIZE_CACHE_FAILURE = 'oversize_cache_unreadable'
// Match the publisher-wide R2 ceiling so verified legacy payloads above 64 MiB have
// enough time to stream from R2 while remaining strictly bounded.
const R2_REQUEST_TIMEOUT_MS = 20_000
const VOLATILE_SOURCE_KEYS = new Set(['UpdateTime', 'SrcUpdateTime', 'SrcTransTime', 'VersionID'])
const STATIC_RESOURCE_IDENTITY = Object.freeze({
  Route: (item) => nonEmpty(item?.RouteUID),
  Stop: (item) => nonEmpty(item?.StopUID),
  StopOfRoute: (item) => nonEmpty(item?.RouteUID) && Array.isArray(item?.Stops),
  Shape: (item) => nonEmpty(item?.RouteUID),
  Schedule: (item) => nonEmpty(item?.RouteUID),
})

export function createTdxStaticSourceCache({
  fetchImpl,
  storage,
  cachePrefix,
  sourceLabel,
  eventName,
  logger = console,
  minimumRefreshMsForResource = () => 0,
  bypassMinimumRefresh = false,
  now = () => Date.now(),
  singleBlobMaxBytes = PAYLOAD_MAX_BYTES,
  chunkBytes = PAYLOAD_CHUNK_BYTES,
  promotedPayloadMaxBytes = PROMOTED_PAYLOAD_MAX_BYTES,
}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function')
  if (!storage) throw new TypeError('storage is required')
  if (!nonEmpty(cachePrefix)) throw new TypeError('cachePrefix is required')
  if (!nonEmpty(sourceLabel)) throw new TypeError('sourceLabel is required')
  if (!nonEmpty(eventName)) throw new TypeError('eventName is required')
  if (typeof minimumRefreshMsForResource !== 'function') throw new TypeError('minimumRefreshMsForResource must be a function')
  if (typeof now !== 'function') throw new TypeError('now must be a function')
  if (!positiveSafeInteger(singleBlobMaxBytes)) throw new TypeError('singleBlobMaxBytes must be positive')
  if (!positiveSafeInteger(chunkBytes)) throw new TypeError('chunkBytes must be positive')
  if (!positiveSafeInteger(promotedPayloadMaxBytes) || promotedPayloadMaxBytes < singleBlobMaxBytes) {
    throw new TypeError('promotedPayloadMaxBytes must be at least singleBlobMaxBytes')
  }

  const cacheLimits = Object.freeze({ singleBlobMaxBytes, chunkBytes, promotedPayloadMaxBytes })

  const resolve = async ({ resource, input, init }) => {
    try {
      let state = null
      try {
        state = await storage.getJson(stateKey(cachePrefix, resource), STATE_MAX_BYTES)
      } catch (error) {
        logger?.warn?.(`TDX ${sourceLabel} persistent cache state read failed for ${resource}: ${errorMessage(error)}`)
      }

      let cachedBody = null
      let cachedBodyChecked = false
      const minimumRefreshMs = refreshFloorMs(minimumRefreshMsForResource, resource)
      const ageMs = validState(state, cachePrefix, resource) ? stateAgeMs(state, now) : null
      if (!bypassMinimumRefresh && minimumRefreshMs > 0 && ageMs !== null && ageMs < minimumRefreshMs) {
        cachedBodyChecked = true
        try {
          cachedBody = await verifiedCachedBody(storage, state, sourceLabel, resource, logger, cacheLimits)
        } catch (error) {
          logger?.warn?.(`TDX ${sourceLabel} persistent cache body read failed for ${resource}: ${errorMessage(error)}`)
          if (isOversizePromotedState(state, cachePrefix, resource, singleBlobMaxBytes)) {
            return blockedOversizeResult({ state, eventName, resource, logger })
          }
        }
        if (cachedBody !== null) {
          logger?.log?.(JSON.stringify({
            event: eventName,
            resource,
            resolution: 'freshness-hit',
            sourceVersion: state.sourceVersion,
            bytes: cachedBody.byteLength,
            ageMs,
            minimumRefreshMs,
            legacyOversize: state.schemaVersion === 1 && cachedBody.byteLength > singleBlobMaxBytes,
            chunked: state.schemaVersion === 2,
          }))
          return { body: cachedBody, sourceVersion: state.sourceVersion }
        }
        if (isOversizePromotedState(state, cachePrefix, resource, singleBlobMaxBytes)) {
          return blockedOversizeResult({ state, eventName, resource, logger })
        }
      }

      let probe
      try {
        probe = await probeSourceVersion(fetchImpl, input, init)
        logger?.log?.(JSON.stringify({
          event: eventName,
          resource,
          resolution: 'probe',
          sourceVersion: probe.sourceVersion,
          result: probe.result,
          status: probe.status,
          bytes: probe.bytes,
        }))
      } catch (error) {
        logger?.log?.(JSON.stringify({
          event: eventName,
          resource,
          resolution: 'probe',
          sourceVersion: null,
          result: 'transport_error',
          status: null,
          bytes: null,
        }))
        throw error
      }
      const sourceVersion = probe.sourceVersion
      if (!sourceVersion) return { body: null, sourceVersion: null }

      if (!validState(state, cachePrefix, resource) || state.sourceVersion !== sourceVersion) {
        return { body: null, sourceVersion }
      }

      if (!cachedBodyChecked) {
        try {
          cachedBody = await verifiedCachedBody(storage, state, sourceLabel, resource, logger, cacheLimits)
        } catch (error) {
          logger?.warn?.(`TDX ${sourceLabel} persistent cache body read failed for ${resource}: ${errorMessage(error)}`)
          if (isOversizePromotedState(state, cachePrefix, resource, singleBlobMaxBytes)) {
            return blockedOversizeResult({ state, eventName, resource, logger, sourceVersion })
          }
          return { body: null, sourceVersion }
        }
      }
      if (cachedBody === null) {
        if (isOversizePromotedState(state, cachePrefix, resource, singleBlobMaxBytes)) {
          return blockedOversizeResult({ state, eventName, resource, logger, sourceVersion })
        }
        return { body: null, sourceVersion }
      }

      // A successful same-version probe is a real revalidation of the promoted
      // payload, but only after the cached bytes have passed size + SHA-256.
      // Renew the refresh lease so the configured floor remains a revalidation
      // interval instead of degenerating into a probe on every later run. The
      // state write is best-effort: failure only costs future probes and must not
      // make already-verified bytes unusable.
      if (minimumRefreshMs > 0) {
        await renewRevalidationLease({
          storage,
          state,
          cachePrefix,
          resource,
          sourceLabel,
          logger,
          now,
        })
      }

      logger?.log?.(JSON.stringify({
        event: eventName,
        resource,
        resolution: 'hit',
        sourceVersion,
        bytes: cachedBody.byteLength,
        legacyOversize: state.schemaVersion === 1 && cachedBody.byteLength > singleBlobMaxBytes,
        chunked: state.schemaVersion === 2,
      }))
      return { body: cachedBody, sourceVersion }
    } catch (error) {
      logger?.warn?.(`TDX ${sourceLabel} persistent cache read failed for ${resource}: ${errorMessage(error)}`)
      return { body: null, sourceVersion: null }
    }
  }

  // A 200 response is only a candidate. Persist the content-addressed bytes, but do not
  // move state.json until the snapshot publisher has parsed and validated the complete
  // source model. The only exception is a byte payload whose non-volatile semantics are
  // identical to the already-promoted payload; advancing UpdateTime in that case cannot
  // change the generated snapshot and avoids repeated full downloads on republish-only churn.
  const stage = async ({ resource, body, sourceVersion }) => {
    if (!sourceVersion) return null
    try {
      const bytes = Buffer.from(body)
      if (bytes.byteLength > promotedPayloadMaxBytes) {
        throw new Error(`payload exceeds ${promotedPayloadMaxBytes} bytes`)
      }
      const parsedPayload = parseStaticPayload(resource, bytes)
      if (!parsedPayload) throw new Error('payload failed static source validation')
      const digest = sha256(bytes)
      const semanticHash = semanticSourceHash(parsedPayload)
      const previous = await storage.getJson(stateKey(cachePrefix, resource), STATE_MAX_BYTES).catch(() => null)
      const previousSemanticHash = await stateSemanticHash(
        previous,
        cachePrefix,
        resource,
        storage,
        sourceLabel,
        logger,
        cacheLimits,
      )
      const candidate = await stagePayloadCandidate({
        storage,
        cachePrefix,
        resource,
        sourceVersion,
        bytes,
        digest,
        semanticHash,
        cacheLimits,
      })
      logger?.log?.(JSON.stringify({
        event: eventName,
        resource,
        resolution: 'staged',
        sourceVersion,
        bytes: bytes.byteLength,
        storageLayout: candidate.schemaVersion === 2 ? 'chunked' : 'single',
        chunkCount: candidate.schemaVersion === 2 ? candidate.chunks.length : 1,
      }))
      if (previousSemanticHash && previousSemanticHash === semanticHash) {
        await promote(candidate)
        logger?.log?.(JSON.stringify({
          event: eventName,
          resource,
          resolution: 'equivalent-promoted',
          sourceVersion,
          bytes: bytes.byteLength,
          storageLayout: candidate.schemaVersion === 2 ? 'chunked' : 'single',
        }))
      }
      return candidate
    } catch (error) {
      logger?.warn?.(`TDX ${sourceLabel} persistent cache stage failed for ${resource}: ${errorMessage(error)}`)
      return null
    }
  }

  const promote = async (candidate) => {
    if (!validCandidate(candidate, cachePrefix)) return false
    try {
      const key = stateKey(cachePrefix, candidate.resource)
      const previous = await storage.getJson(key, STATE_MAX_BYTES).catch(() => null)
      const nextState = candidateState(candidate, now)
      await storage.putJson(key, nextState)
      logger?.log?.(JSON.stringify({
        event: eventName,
        resource: candidate.resource,
        resolution: 'promoted',
        sourceVersion: candidate.sourceVersion,
        bytes: candidate.bytes,
        storageLayout: candidate.schemaVersion === 2 ? 'chunked' : 'single',
        chunkCount: candidate.schemaVersion === 2 ? candidate.chunks.length : 1,
      }))

      // state.json is committed first. Content-addressed objects no longer referenced by
      // the promoted state can then be removed best-effort without risking authority.
      if (validState(previous, cachePrefix, candidate.resource)
        && typeof storage.deleteObject === 'function') {
        const nextKeys = new Set(stateObjectKeys(nextState))
        for (const oldKey of stateObjectKeys(previous)) {
          if (nextKeys.has(oldKey)) continue
          await storage.deleteObject(oldKey).catch((error) => {
            logger?.warn?.(`TDX ${sourceLabel} old cache cleanup failed for ${candidate.resource}: ${errorMessage(error)}`)
          })
        }
      }
      return true
    } catch (error) {
      logger?.warn?.(`TDX ${sourceLabel} persistent cache promotion failed for ${candidate.resource}: ${errorMessage(error)}`)
      return false
    }
  }

  return Object.freeze({ resolve, stage, promote })
}

export function createR2StaticSourceStorage({
  env = process.env,
  requestTimeoutMs = R2_REQUEST_TIMEOUT_MS,
} = {}) {
  const accessKeyId = nonEmpty(env.R2_ACCESS_KEY_ID)
  const secretAccessKey = nonEmpty(env.R2_SECRET_ACCESS_KEY)
  const accountId = nonEmpty(env.CLOUDFLARE_ACCOUNT_ID)
  const bucket = nonEmpty(env.TRANSIT_R2_BUCKET_NAME)
  if (!accessKeyId || !secretAccessKey || !accountId || !bucket) return null

  let clientPromise
  const baseUrl = `https://${accountId}.r2.cloudflarestorage.com/${encodeURIComponent(bucket)}`
  const client = async () => {
    clientPromise ??= import('aws4fetch').then(({ AwsClient }) => new AwsClient({
      accessKeyId,
      secretAccessKey,
      service: 's3',
      region: 'auto',
    }))
    return clientPromise
  }
  const objectUrl = (key) => `${baseUrl}/${key.split('/').map(encodeURIComponent).join('/')}`
  const signal = () => AbortSignal.timeout(requestTimeoutMs)

  const storage = {
    async getJson(key, maximumBytes) {
      const body = await getBody(key, maximumBytes)
      if (body === null) return null
      return JSON.parse(body.toString('utf8'))
    },
    async getBuffer(key, maximumBytes) {
      return getBody(key, maximumBytes)
    },
    async putBuffer(key, body, contentType) {
      const aws = await client()
      const response = await aws.fetch(objectUrl(key), {
        method: 'PUT',
        body,
        headers: { 'Content-Type': contentType },
        signal: signal(),
      })
      await response.body?.cancel().catch(() => undefined)
      if (!response.ok) throw new Error(`R2 PUT ${key} failed (${response.status})`)
    },
    async putJson(key, value) {
      return this.putBuffer(key, JSON.stringify(value), 'application/json')
    },
    async deleteObject(key) {
      const aws = await client()
      const response = await aws.fetch(objectUrl(key), { method: 'DELETE', signal: signal() })
      await response.body?.cancel().catch(() => undefined)
      if (!response.ok && response.status !== 404) throw new Error(`R2 DELETE ${key} failed (${response.status})`)
    },
  }

  async function getBody(key, maximumBytes) {
    const aws = await client()
    const response = await aws.fetch(objectUrl(key), { signal: signal() })
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined)
      return null
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error(`R2 GET ${key} failed (${response.status})`)
    }
    const declared = parseContentLength(response.headers.get('Content-Length'))
    if (declared !== null && declared > maximumBytes) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error(`R2 GET ${key} exceeds ${maximumBytes} bytes`)
    }
    const body = Buffer.from(await response.arrayBuffer())
    if (body.byteLength > maximumBytes) throw new Error(`R2 GET ${key} exceeds ${maximumBytes} bytes`)
    return body
  }

  return storage
}

export function tdxStaticProbeUrl(input) {
  const url = new URL(input instanceof Request ? input.url : String(input))
  url.search = ''
  url.searchParams.set('$select', 'UpdateTime')
  url.searchParams.set('$orderby', 'UpdateTime desc')
  url.searchParams.set('$top', '1')
  url.searchParams.set('$format', 'JSON')
  return url
}

async function probeSourceVersion(fetchImpl, input, init) {
  const url = tdxStaticProbeUrl(input)
  const response = await fetchImpl(url, { ...init, method: 'GET' })
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    return { sourceVersion: null, result: 'http_error', status: response.status, bytes: null }
  }
  const body = Buffer.from(await response.arrayBuffer())
  const payload = JSON.parse(body.toString('utf8'))
  return {
    sourceVersion: Array.isArray(payload) ? nonEmpty(payload[0]?.UpdateTime) : null,
    result: 'success',
    status: response.status,
    bytes: body.byteLength,
  }
}

function stateKey(cachePrefix, resource) {
  return `${cachePrefix}/${resource}/state.json`
}

function validState(value, cachePrefix, resource) {
  return validSingleState(value, cachePrefix, resource) || validChunkedState(value, cachePrefix, resource)
}

function validSingleState(value, cachePrefix, resource) {
  return value && value.schemaVersion === 1
    && value.resource === resource
    && nonEmpty(value.sourceVersion)
    && typeof value.payloadKey === 'string'
    && value.payloadKey.startsWith(`${cachePrefix}/${resource}/payload-`)
    && /^[a-f0-9]{64}$/.test(value.sha256)
    && Number.isSafeInteger(value.bytes)
    && value.bytes >= 0
}

function validChunkedState(value, cachePrefix, resource) {
  return value && value.schemaVersion === 2
    && value.resource === resource
    && nonEmpty(value.sourceVersion)
    && /^[a-f0-9]{64}$/.test(value.sha256)
    && Number.isSafeInteger(value.bytes)
    && value.bytes > 0
    && validChunks(value.chunks, cachePrefix, resource, value.bytes)
}

function validCandidate(value, cachePrefix) {
  if (!value || typeof value.resource !== 'string' || !nonEmpty(value.sourceVersion)) return false
  if (!/^[a-f0-9]{64}$/.test(value.sha256) || !/^[a-f0-9]{64}$/.test(value.semanticHash)) return false
  if (!Number.isSafeInteger(value.bytes) || value.bytes <= 0) return false
  if (value.schemaVersion === 1) {
    return typeof value.payloadKey === 'string'
      && value.payloadKey.startsWith(`${cachePrefix}/${value.resource}/payload-`)
  }
  if (value.schemaVersion === 2) {
    return validChunks(value.chunks, cachePrefix, value.resource, value.bytes)
  }
  return false
}

function validChunks(chunks, cachePrefix, resource, expectedBytes) {
  if (!Array.isArray(chunks) || chunks.length === 0) return false
  let total = 0
  for (const chunk of chunks) {
    if (!chunk || typeof chunk.key !== 'string'
      || !chunk.key.startsWith(`${cachePrefix}/${resource}/chunks/`)
      || !/^[a-f0-9]{64}$/.test(chunk.sha256)
      || !Number.isSafeInteger(chunk.bytes)
      || chunk.bytes <= 0) return false
    total += chunk.bytes
    if (!Number.isSafeInteger(total)) return false
  }
  return total === expectedBytes
}

async function verifiedCachedBody(storage, state, sourceLabel, resource, logger, cacheLimits) {
  let body
  if (state.schemaVersion === 2) {
    body = await readChunkedPayload(storage, state, sourceLabel, resource, logger, cacheLimits)
  } else {
    const maximumBytes = promotedPayloadReadLimit(state, cacheLimits)
    body = await storage.getBuffer(state.payloadKey, maximumBytes)
  }
  if (body === null) return null
  const digest = sha256(body)
  if (digest !== state.sha256 || body.byteLength !== state.bytes) {
    logger?.warn?.(`TDX ${sourceLabel} persistent cache integrity mismatch for ${resource}`)
    return null
  }
  return body
}

async function readChunkedPayload(storage, state, sourceLabel, resource, logger, cacheLimits) {
  if (state.bytes > cacheLimits.promotedPayloadMaxBytes) {
    throw new Error(`chunked promoted payload exceeds ${cacheLimits.promotedPayloadMaxBytes} bytes`)
  }
  const parts = []
  let total = 0
  for (const chunk of state.chunks) {
    const body = await storage.getBuffer(chunk.key, chunk.bytes)
    if (body === null || body.byteLength !== chunk.bytes || sha256(body) !== chunk.sha256) {
      logger?.warn?.(`TDX ${sourceLabel} persistent cache chunk integrity mismatch for ${resource}`)
      return null
    }
    total += body.byteLength
    if (total > cacheLimits.promotedPayloadMaxBytes) {
      throw new Error(`chunked promoted payload exceeds ${cacheLimits.promotedPayloadMaxBytes} bytes`)
    }
    parts.push(body)
  }
  if (total !== state.bytes) {
    logger?.warn?.(`TDX ${sourceLabel} persistent cache chunk byte total mismatch for ${resource}`)
    return null
  }
  return Buffer.concat(parts, total)
}

function promotedPayloadReadLimit(state, cacheLimits) {
  if (state.bytes <= cacheLimits.singleBlobMaxBytes) return cacheLimits.singleBlobMaxBytes
  if (state.bytes <= cacheLimits.promotedPayloadMaxBytes) return state.bytes
  throw new Error(`legacy promoted payload exceeds ${cacheLimits.promotedPayloadMaxBytes} bytes`)
}

function isOversizePromotedState(state, cachePrefix, resource, singleBlobMaxBytes) {
  return validState(state, cachePrefix, resource) && state.bytes > singleBlobMaxBytes
}

function blockedOversizeResult({ state, eventName, resource, logger, sourceVersion = state.sourceVersion }) {
  logger?.log?.(JSON.stringify({
    event: eventName,
    resource,
    resolution: 'blocked',
    sourceVersion,
    bytes: state.bytes,
    failureClass: OVERSIZE_CACHE_FAILURE,
    storageLayout: state.schemaVersion === 2 ? 'chunked' : 'legacy-single',
  }))
  return {
    body: null,
    sourceVersion,
    blockUpstream: true,
    cacheFailure: OVERSIZE_CACHE_FAILURE,
  }
}

async function stagePayloadCandidate({
  storage,
  cachePrefix,
  resource,
  sourceVersion,
  bytes,
  digest,
  semanticHash,
  cacheLimits,
}) {
  if (bytes.byteLength <= cacheLimits.singleBlobMaxBytes) {
    const payloadKey = `${cachePrefix}/${resource}/payload-${digest}.json`
    await storage.putBuffer(payloadKey, bytes, 'application/json')
    return Object.freeze({
      schemaVersion: 1,
      resource,
      sourceVersion,
      payloadKey,
      sha256: digest,
      semanticHash,
      bytes: bytes.byteLength,
    })
  }

  const chunks = []
  const stagedKeys = new Set()
  for (let offset = 0; offset < bytes.byteLength; offset += cacheLimits.chunkBytes) {
    const chunkBody = bytes.subarray(offset, Math.min(bytes.byteLength, offset + cacheLimits.chunkBytes))
    const chunkDigest = sha256(chunkBody)
    const key = `${cachePrefix}/${resource}/chunks/${chunkDigest}.bin`
    if (!stagedKeys.has(key)) {
      await storage.putBuffer(key, chunkBody, 'application/octet-stream')
      stagedKeys.add(key)
    }
    chunks.push(Object.freeze({ key, sha256: chunkDigest, bytes: chunkBody.byteLength }))
  }
  return Object.freeze({
    schemaVersion: 2,
    resource,
    sourceVersion,
    sha256: digest,
    semanticHash,
    bytes: bytes.byteLength,
    chunks: Object.freeze(chunks),
  })
}

function candidateState(candidate, now) {
  const common = {
    schemaVersion: candidate.schemaVersion,
    resource: candidate.resource,
    sourceVersion: candidate.sourceVersion,
    sha256: candidate.sha256,
    semanticHash: candidate.semanticHash,
    bytes: candidate.bytes,
    refreshedAt: new Date(currentTimeMs(now)).toISOString(),
  }
  return candidate.schemaVersion === 2
    ? { ...common, chunks: candidate.chunks.map((chunk) => ({ ...chunk })) }
    : { ...common, payloadKey: candidate.payloadKey }
}

function stateObjectKeys(state) {
  if (state?.schemaVersion === 2 && Array.isArray(state.chunks)) return state.chunks.map((chunk) => chunk.key)
  return typeof state?.payloadKey === 'string' ? [state.payloadKey] : []
}

async function renewRevalidationLease({ storage, state, cachePrefix, resource, sourceLabel, logger, now }) {
  try {
    await storage.putJson(stateKey(cachePrefix, resource), {
      ...state,
      refreshedAt: new Date(currentTimeMs(now)).toISOString(),
    })
    return true
  } catch (error) {
    logger?.warn?.(`TDX ${sourceLabel} persistent cache revalidation lease write failed for ${resource}: ${errorMessage(error)}`)
    return false
  }
}

function refreshFloorMs(resolveMinimumRefreshMs, resource) {
  try {
    const value = Number(resolveMinimumRefreshMs(resource))
    return Number.isFinite(value) && value >= 0 ? value : 0
  } catch {
    return 0
  }
}

function stateAgeMs(state, now) {
  if (typeof state.refreshedAt !== 'string') return null
  const refreshedAt = Date.parse(state.refreshedAt)
  if (!Number.isFinite(refreshedAt)) return null
  const current = currentTimeMs(now)
  if (current < refreshedAt) return null
  return current - refreshedAt
}

function currentTimeMs(now) {
  const value = now()
  const milliseconds = value instanceof Date ? value.getTime() : Number(value)
  return Number.isFinite(milliseconds) ? milliseconds : Date.now()
}

async function stateSemanticHash(
  state,
  cachePrefix,
  resource,
  storage,
  sourceLabel,
  logger,
  cacheLimits,
) {
  if (!validState(state, cachePrefix, resource)) return null
  if (/^[a-f0-9]{64}$/.test(state.semanticHash)) return state.semanticHash
  try {
    const body = await verifiedCachedBody(storage, state, sourceLabel, resource, logger, cacheLimits)
    return body ? semanticSourceHash(body) : null
  } catch {
    return null
  }
}

function parseStaticPayload(resource, bytes) {
  const identity = STATIC_RESOURCE_IDENTITY[resource]
  if (!identity) return null
  let value
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    return null
  }
  return Array.isArray(value)
    && value.length > 0
    && value.every((item) => item !== null && typeof item === 'object' && !Array.isArray(item))
    && value.some(identity)
    ? value
    : null
}

function semanticSourceHash(value) {
  const parsed = Buffer.isBuffer(value) ? JSON.parse(value.toString('utf8')) : value
  const stable = JSON.stringify(parsed, (key, item) => VOLATILE_SOURCE_KEYS.has(key) ? undefined : item)
  return sha256(stable)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0
}

function parseContentLength(value) {
  if (value === null) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
