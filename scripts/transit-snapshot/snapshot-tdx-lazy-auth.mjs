import {
  acquireSnapshotTdxToken,
  readSnapshotTdxTokenFile,
  TDX_TOKEN_ENDPOINT,
  writeSnapshotTdxTokenFile,
} from './snapshot-tdx-token.mjs'

const TDX_ORIGIN = 'https://tdx.transportdata.tw'
const LAZY_ACCESS_TOKEN = 'mochi-snapshot-lazy-auth'
const MIN_TOKEN_VALIDITY_MS = 30_000

export class SnapshotTdxTerminalAuthError extends Error {
  constructor(error) {
    const message = error instanceof Error ? error.message : String(error)
    super(message, { cause: error })
    this.name = 'SnapshotTdxTerminalAuthError'
  }
}

export function isSnapshotTdxTerminalAuthError(value) {
  return value instanceof SnapshotTdxTerminalAuthError
}

export function createSnapshotTdxLazyAuthFetch({
  originalFetch = globalThis.fetch,
  tokenFile,
  env = process.env,
  now = Date.now,
} = {}) {
  if (typeof originalFetch !== 'function') throw new TypeError('originalFetch is required')

  const configuredFile = nonEmpty(tokenFile)
  let memoryToken = null
  let pendingToken = null
  let terminalTokenError = null

  return async function snapshotTdxLazyAuthFetch(input, init) {
    if (isTdxTokenRequest(input, init)) return lazyTokenResponse()

    if (!isTdxDataRequest(input, init) || authorization(input, init) !== `Bearer ${LAZY_ACCESS_TOKEN}`) {
      return originalFetch(input, init)
    }

    const token = await sharedToken()
    return originalFetch(input, withAuthorization(input, init, token.accessToken))
  }

  async function sharedToken() {
    if (terminalTokenError) throw terminalTokenError

    const currentNow = safeNow(now)
    if (validMemoryToken(memoryToken, currentNow)) return memoryToken
    if (pendingToken) return pendingToken

    pendingToken = (async () => {
      if (configuredFile) {
        try {
          const fromFile = await readSnapshotTdxTokenFile(configuredFile, safeNow(now))
          memoryToken = fromFile
          return fromFile
        } catch {
          // Missing/expired job-local token is expected on the first real cache miss.
        }
      }

      const acquired = await acquireSnapshotTdxToken({
        env,
        fetchImpl: originalFetch,
        now,
      })
      if (configuredFile) await writeSnapshotTdxTokenFile(configuredFile, acquired)
      memoryToken = Object.freeze({
        accessToken: acquired.accessToken,
        expiresAt: acquired.expiresAt,
      })
      return memoryToken
    })()

    try {
      return await pendingToken
    } catch (error) {
      // acquireSnapshotTdxToken already owns bounded retry for network/timeout/429.
      // Memoize its terminal outcome so one publisher process cannot multiply an
      // exhausted OAuth attempt through the outer data-request retry loop.
      terminalTokenError = error instanceof SnapshotTdxTerminalAuthError
        ? error
        : new SnapshotTdxTerminalAuthError(error)
      throw terminalTokenError
    } finally {
      pendingToken = null
    }
  }
}

export function snapshotTdxLazyAccessToken() {
  return LAZY_ACCESS_TOKEN
}

function lazyTokenResponse() {
  return new Response(JSON.stringify({
    access_token: LAZY_ACCESS_TOKEN,
    token_type: 'Bearer',
    expires_in: 3600,
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

function isTdxTokenRequest(input, init) {
  return requestMethod(input, init) === 'POST' && requestUrl(input) === TDX_TOKEN_ENDPOINT
}

function isTdxDataRequest(input, init) {
  if (requestMethod(input, init) !== 'GET') return false
  try {
    const url = new URL(requestUrl(input))
    return url.origin === TDX_ORIGIN && url.pathname.startsWith('/api/')
  } catch {
    return false
  }
}

function authorization(input, init) {
  return mergedHeaders(input, init).get('Authorization')
}

function withAuthorization(input, init, accessToken) {
  const headers = mergedHeaders(input, init)
  headers.set('Authorization', `Bearer ${accessToken}`)
  return { ...init, headers }
}

function mergedHeaders(input, init) {
  const headers = new Headers(input instanceof Request ? input.headers : undefined)
  if (init?.headers) {
    new Headers(init.headers).forEach((value, key) => headers.set(key, value))
  }
  return headers
}

function requestMethod(input, init) {
  const explicit = nonEmpty(init?.method)
  if (explicit) return explicit.toUpperCase()
  return input instanceof Request ? input.method.toUpperCase() : 'GET'
}

function requestUrl(input) {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return typeof input?.url === 'string' ? input.url : ''
}

function validMemoryToken(value, now) {
  return value
    && typeof value.accessToken === 'string'
    && value.accessToken.length > 0
    && Number.isFinite(value.expiresAt)
    && value.expiresAt - now >= MIN_TOKEN_VALIDITY_MS
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
