import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export const TDX_TOKEN_ENDPOINT = 'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token'
export const DEFAULT_SNAPSHOT_TDX_TOKEN_FILE = '.transit-snapshot/tdx-access-token.json'

const REQUEST_TIMEOUT_MS = 15_000
const MAX_ATTEMPTS = 5
const TOKEN_RESPONSE_MAX_BYTES = 16 * 1024
const TOKEN_MAX_LENGTH = 16 * 1024
const MIN_TOKEN_VALIDITY_MS = 30_000

export async function acquireSnapshotTdxToken({
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
  maxAttempts = MAX_ATTEMPTS,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required')
  const clientId = nonEmpty(env.TDX_CLIENT_ID)
  const clientSecret = nonEmpty(env.TDX_CLIENT_SECRET)
  if (!clientId || !clientSecret) {
    throw new Error('TDX token preflight requires TDX_CLIENT_ID and TDX_CLIENT_SECRET')
  }

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let response
    try {
      response = await fetchImpl(TDX_TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: clientId,
          client_secret: clientSecret,
        }),
        signal: AbortSignal.timeout(requestTimeoutMs),
      })
    } catch (error) {
      if (attempt === maxAttempts - 1) {
        throw new Error(`TDX token preflight failed (${transportFailure(error)})`)
      }
      await sleep(backoffMilliseconds(attempt))
      continue
    }

    if (!response.ok) {
      const oauthError = await oauthErrorCode(response)
      if (response.status === 429 && attempt < maxAttempts - 1) {
        await response.body?.cancel().catch(() => undefined)
        await sleep(retryDelayMilliseconds(response, attempt))
        continue
      }
      await response.body?.cancel().catch(() => undefined)
      throw new Error(`TDX token preflight failed (${response.status}; ${oauthError})`)
    }

    const payload = await boundedJson(response, TOKEN_RESPONSE_MAX_BYTES)
    const accessToken = nonEmpty(payload?.access_token)
    if (!accessToken || accessToken.length > TOKEN_MAX_LENGTH) {
      throw new Error('TDX token preflight returned an invalid access token')
    }
    const expiresInSeconds = positiveNumber(payload?.expires_in)
    const obtainedAt = safeNow(now)
    const expiresAt = expiresInSeconds === null
      ? obtainedAt + 60 * 60 * 1000
      : obtainedAt + Math.floor(expiresInSeconds * 1000)
    if (expiresAt - obtainedAt < MIN_TOKEN_VALIDITY_MS) {
      throw new Error('TDX token preflight returned an access token with insufficient lifetime')
    }
    return Object.freeze({
      schemaVersion: 1,
      accessToken,
      obtainedAt,
      expiresAt,
    })
  }
  throw new Error('TDX token preflight retry exhausted')
}

export async function writeSnapshotTdxTokenFile(file, tokenRecord) {
  const target = nonEmpty(file) ?? DEFAULT_SNAPSHOT_TDX_TOKEN_FILE
  if (!validTokenRecord(tokenRecord, Date.now(), false)) {
    throw new TypeError('Invalid snapshot TDX token record')
  }
  await mkdir(dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(tokenRecord)}\n`, { mode: 0o600, flag: 'wx' })
    await chmod(temporary, 0o600)
    await rename(temporary, target)
    await chmod(target, 0o600)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
  return target
}

export async function readSnapshotTdxTokenFile(file, now = Date.now()) {
  const target = nonEmpty(file)
  if (!target) throw new Error('SNAPSHOT_TDX_ACCESS_TOKEN_FILE is not configured')
  let parsed
  try {
    parsed = JSON.parse(await readFile(target, 'utf8'))
  } catch {
    throw new Error('Shared TDX snapshot token file is unavailable')
  }
  if (!validTokenRecord(parsed, now, true)) {
    throw new Error('Shared TDX snapshot token file is invalid or expired')
  }
  return Object.freeze({
    accessToken: parsed.accessToken,
    expiresAt: parsed.expiresAt,
  })
}

export function createSnapshotTdxTokenFileFetch({
  originalFetch,
  tokenFile,
  now = Date.now,
} = {}) {
  if (typeof originalFetch !== 'function') throw new TypeError('originalFetch is required')
  const configuredFile = nonEmpty(tokenFile)
  if (!configuredFile) return originalFetch

  return async function snapshotTdxTokenFileFetch(input, init) {
    if (!isTdxTokenRequest(input, init)) return originalFetch(input, init)
    const token = await readSnapshotTdxTokenFile(configuredFile, safeNow(now))
    return new Response(JSON.stringify({
      access_token: token.accessToken,
      token_type: 'Bearer',
      expires_in: Math.max(1, Math.floor((token.expiresAt - safeNow(now)) / 1000)),
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    })
  }
}

export function boundedOAuthErrorCode(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  return /^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(text) ? text.toLowerCase() : 'unclassified'
}

function isTdxTokenRequest(input, init) {
  const method = String(init?.method ?? input?.method ?? 'GET').toUpperCase()
  return method === 'POST' && requestUrl(input) === TDX_TOKEN_ENDPOINT
}

function requestUrl(input) {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return typeof input?.url === 'string' ? input.url : ''
}

async function oauthErrorCode(response) {
  try {
    const payload = await boundedJson(response.clone(), TOKEN_RESPONSE_MAX_BYTES)
    return boundedOAuthErrorCode(payload?.error)
  } catch {
    return 'unavailable'
  }
}

async function boundedJson(response, maximumBytes) {
  const declared = parseContentLength(response.headers.get('Content-Length'))
  if (declared !== null && declared > maximumBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error('TDX token response exceeded byte limit')
  }
  if (!response.body) return JSON.parse('')
  const reader = response.body.getReader()
  const chunks = []
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      bytes += value.byteLength
      if (bytes > maximumBytes) {
        await reader.cancel().catch(() => undefined)
        throw new Error('TDX token response exceeded byte limit')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const body = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return JSON.parse(new TextDecoder().decode(body))
}

function validTokenRecord(value, now, enforceExpiry) {
  return value?.schemaVersion === 1
    && typeof value.accessToken === 'string'
    && value.accessToken.length > 0
    && value.accessToken.length <= TOKEN_MAX_LENGTH
    && Number.isFinite(value.obtainedAt)
    && Number.isFinite(value.expiresAt)
    && value.expiresAt > value.obtainedAt
    && (!enforceExpiry || value.expiresAt - now >= MIN_TOKEN_VALIDITY_MS)
}

function retryDelayMilliseconds(response, attempt) {
  const retryAfter = response.headers.get('Retry-After')
  if (retryAfter !== null) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(30, seconds) * 1000
  }
  return backoffMilliseconds(attempt)
}

function backoffMilliseconds(attempt) {
  return 2 ** (attempt + 1) * 1000
}

function transportFailure(error) {
  const name = error instanceof Error ? error.name : ''
  return name === 'AbortError' || name === 'TimeoutError' ? 'timeout' : 'network_error'
}

function parseContentLength(value) {
  if (value === null) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

function positiveNumber(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function safeNow(now) {
  try {
    const value = typeof now === 'function' ? now() : now
    return Number.isFinite(value) ? value : Date.now()
  } catch {
    return Date.now()
  }
}
