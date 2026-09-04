import { createHash } from 'node:crypto'

const STATE_MAX_BYTES = 32 * 1024
const PAYLOAD_MAX_BYTES = 64 * 1024 * 1024

export function createTdxStaticSourceCache({
  fetchImpl,
  storage,
  cachePrefix,
  sourceLabel,
  eventName,
  logger = console,
}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function')
  if (!storage) throw new TypeError('storage is required')
  if (!nonEmpty(cachePrefix)) throw new TypeError('cachePrefix is required')
  if (!nonEmpty(sourceLabel)) throw new TypeError('sourceLabel is required')
  if (!nonEmpty(eventName)) throw new TypeError('eventName is required')

  return Object.freeze({
    async resolve({ resource, input, init }) {
      try {
        const sourceVersion = await probeSourceVersion(fetchImpl, input, init)
        if (!sourceVersion) return { body: null, sourceVersion: null }

        const state = await storage.getJson(stateKey(cachePrefix, resource), STATE_MAX_BYTES)
        if (!validState(state, cachePrefix, resource) || state.sourceVersion !== sourceVersion) {
          return { body: null, sourceVersion }
        }

        const body = await storage.getBuffer(state.payloadKey, PAYLOAD_MAX_BYTES)
        if (body === null) return { body: null, sourceVersion }
        const digest = sha256(body)
        if (digest !== state.sha256 || body.byteLength !== state.bytes) {
          logger?.warn?.(`TDX ${sourceLabel} persistent cache integrity mismatch for ${resource}`)
          return { body: null, sourceVersion }
        }

        logger?.log?.(JSON.stringify({
          event: eventName,
          resource,
          resolution: 'hit',
          sourceVersion,
          bytes: body.byteLength,
        }))
        return { body, sourceVersion }
      } catch (error) {
        logger?.warn?.(`TDX ${sourceLabel} persistent cache read failed for ${resource}: ${errorMessage(error)}`)
        return { body: null, sourceVersion: null }
      }
    },

    async store({ resource, body, sourceVersion }) {
      if (!sourceVersion) return false
      try {
        const bytes = Buffer.from(body)
        const digest = sha256(bytes)
        const payloadKey = `${cachePrefix}/${resource}/payload-${digest}.json`
        await storage.putBuffer(payloadKey, bytes, 'application/json')
        await storage.putJson(stateKey(cachePrefix, resource), {
          schemaVersion: 1,
          resource,
          sourceVersion,
          payloadKey,
          sha256: digest,
          bytes: bytes.byteLength,
          refreshedAt: new Date().toISOString(),
        })
        logger?.log?.(JSON.stringify({
          event: eventName,
          resource,
          resolution: 'stored',
          sourceVersion,
          bytes: bytes.byteLength,
        }))
        return true
      } catch (error) {
        logger?.warn?.(`TDX ${sourceLabel} persistent cache write failed for ${resource}: ${errorMessage(error)}`)
        return false
      }
    },
  })
}

export function createR2StaticSourceStorage({ env = process.env } = {}) {
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
      })
      await response.body?.cancel().catch(() => undefined)
      if (!response.ok) throw new Error(`R2 PUT ${key} failed (${response.status})`)
    },
    async putJson(key, value) {
      return this.putBuffer(key, JSON.stringify(value), 'application/json')
    },
  }

  async function getBody(key, maximumBytes) {
    const aws = await client()
    const response = await aws.fetch(objectUrl(key))
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
    return null
  }
  const payload = await response.json()
  return Array.isArray(payload) ? nonEmpty(payload[0]?.UpdateTime) : null
}

function stateKey(cachePrefix, resource) {
  return `${cachePrefix}/${resource}/state.json`
}

function validState(value, cachePrefix, resource) {
  return value && value.schemaVersion === 1
    && value.resource === resource
    && nonEmpty(value.sourceVersion)
    && typeof value.payloadKey === 'string'
    && value.payloadKey.startsWith(`${cachePrefix}/${resource}/payload-`)
    && /^[a-f0-9]{64}$/.test(value.sha256)
    && Number.isSafeInteger(value.bytes)
    && value.bytes >= 0
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function parseContentLength(value) {
  if (value === null) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
