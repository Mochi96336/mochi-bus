import {
  TDXServiceError,
  observeTDXResponseSuccess,
  transportFailureClass,
} from './error-classification'

const TDX_TOKEN_ENDPOINT = 'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token'
const TDX_TOKEN_MAX_RESPONSE_BYTES = 16 * 1024
const DEFAULT_MAX_TOKEN_CACHE_ENTRIES = 128
const DEFAULT_MAX_TOKEN_SINGLEFLIGHT_ENTRIES = 128
const TOKEN_FETCH_MAX_ATTEMPTS = 2
const TOKEN_RETRY_BASE_DELAY_MS = 250
const TOKEN_RETRY_JITTER_MS = 500

export type TDXCredentialEnv = {
  TDX_CLIENT_ID: string
  TDX_CLIENT_SECRET: string
  // 瀏覽器直接向 TDX 換取短效 token；Worker 永遠不接觸 Client Secret。
  TDX_USER_ACCESS_TOKEN?: string
}

export type TDXTokenResult = {
  token: string
  isShared: boolean
  credentialKey: string
}

export type TDXTokenParsedJsonResponse = {
  data: unknown
  receivedBytes: number
  declaredBytes?: number
}

export type TDXTokenObservation = {
  operation: 'token'
  resource: 'token'
  credentialScope: 'shared' | 'byok'
}

export type TDXTokenRequestFailureObservation = TDXTokenObservation & {
  attempt: number
  maxAttempts: number
  failureKind: TDXServiceError['failureKind']
  status?: number
  willRetry: boolean
}

export type TDXTokenClientDependencies = {
  requestTimeoutMs: number
  assertCircuitClosed: (key: string) => void
  recordCircuitFailure: (key: string, error: TDXServiceError, retryAfter?: string | null) => void
  recordCircuitSuccess: (key: string) => void
  responseError: (
    context: string,
    response: Response,
    isShared: boolean,
    observation: Pick<TDXTokenObservation, 'operation' | 'resource'>,
  ) => Promise<TDXServiceError>
  readJsonResponse: (response: Response, maxBytes: number) => Promise<TDXTokenParsedJsonResponse>
  isPayloadTooLargeError: (error: unknown) => error is TDXServiceError
  logResponseTooLarge: (error: TDXServiceError, observation: TDXTokenObservation) => void
  logResponseSize: (observation: TDXTokenObservation & {
    maxBytes: number
    receivedBytes: number
    declaredBytes?: number
    sampled: boolean
  }) => void
  logRequestFailure: (observation: TDXTokenRequestFailureObservation) => void
  fetcher?: typeof fetch
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  random?: () => number
  maxTokenCacheEntries?: number
  maxTokenSingleflightEntries?: number
}

type TokenCacheEntry = { value: string; expiresAt: number }

// Token credential/cache ownership lives here. Circuit state, bounded response reading and safe logging
// remain injected by the TDX client façade so token and data state machines stay separate.
// Global fetch and clock are resolved at call time so Worker/test injection remains effective.
export function createTDXTokenClient(dependencies: TDXTokenClientDependencies): {
  getTDXToken: (env: TDXCredentialEnv) => Promise<TDXTokenResult>
  resetTDXTokenState: () => void
} {
  const tokenCache = new Map<string, TokenCacheEntry>()
  const tokenFlights = new Map<string, Promise<string>>()
  const now = () => dependencies.now ? dependencies.now() : Date.now()
  const sleep = (ms: number) => dependencies.sleep
    ? dependencies.sleep(ms)
    : new Promise<void>((resolve) => { setTimeout(resolve, ms) })
  const random = () => dependencies.random ? dependencies.random() : Math.random()
  const maxTokenCacheEntries = dependencies.maxTokenCacheEntries ?? DEFAULT_MAX_TOKEN_CACHE_ENTRIES
  const maxTokenSingleflightEntries = dependencies.maxTokenSingleflightEntries
    ?? DEFAULT_MAX_TOKEN_SINGLEFLIGHT_ENTRIES

  const cachedToken = (key: string): string | undefined => {
    const cached = tokenCache.get(key)
    if (!cached) return undefined
    if (cached.expiresAt <= now()) {
      tokenCache.delete(key)
      return undefined
    }
    tokenCache.delete(key)
    tokenCache.set(key, cached)
    return cached.value
  }

  const cacheToken = (key: string, entry: TokenCacheEntry): void => {
    tokenCache.delete(key)
    tokenCache.set(key, entry)
    while (tokenCache.size > maxTokenCacheEntries) {
      const oldestKey = tokenCache.keys().next().value
      if (oldestKey === undefined) break
      tokenCache.delete(oldestKey)
    }
  }

  const joinTokenSingleflight = (key: string, create: () => Promise<string>): Promise<string> => {
    const existing = tokenFlights.get(key)
    if (existing) return existing

    const promise = create()
    if (tokenFlights.size < maxTokenSingleflightEntries) {
      tokenFlights.set(key, promise)
      void promise.finally(() => {
        if (tokenFlights.get(key) === promise) tokenFlights.delete(key)
      }).catch(() => undefined)
    }
    return promise
  }

  const retryDelayMs = (): number => {
    const jitter = Math.max(0, Math.min(1, random()))
    return TOKEN_RETRY_BASE_DELAY_MS + Math.floor(jitter * TOKEN_RETRY_JITTER_MS)
  }

  const logRequestFailure = (
    isShared: boolean,
    attempt: number,
    error: TDXServiceError,
    willRetry: boolean,
  ): void => {
    dependencies.logRequestFailure({
      operation: 'token',
      resource: 'token',
      credentialScope: isShared ? 'shared' : 'byok',
      attempt,
      maxAttempts: TOKEN_FETCH_MAX_ATTEMPTS,
      failureKind: error.failureKind,
      status: error.status,
      willRetry,
    })
  }

  const fetchTDXToken = async (
    clientId: string,
    clientSecret: string,
    credentialKey: string,
    isShared: boolean,
  ): Promise<string> => {
    const circuitKey = tokenCircuitKey(credentialKey)
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    })

    for (let attempt = 1; attempt <= TOKEN_FETCH_MAX_ATTEMPTS; attempt += 1) {
      let response: Response
      try {
        response = await (dependencies.fetcher ?? fetch)(TDX_TOKEN_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
          signal: AbortSignal.timeout(dependencies.requestTimeoutMs),
        })
      } catch (error) {
        const serviceError = new TDXServiceError('TDX token request failed', undefined, {
          cause: error,
          failureKind: transportFailureClass(error),
        })
        const willRetry = attempt < TOKEN_FETCH_MAX_ATTEMPTS
        logRequestFailure(isShared, attempt, serviceError, willRetry)
        if (willRetry) {
          await sleep(retryDelayMs())
          continue
        }
        dependencies.recordCircuitFailure(circuitKey, serviceError)
        throw serviceError
      }

      if (!response.ok) {
        const error = await dependencies.responseError('TDX token request failed', response, isShared, {
          operation: 'token',
          resource: 'token',
        })
        const willRetry = attempt < TOKEN_FETCH_MAX_ATTEMPTS && isRetryableTokenStatus(response.status)
        logRequestFailure(isShared, attempt, error, willRetry)
        if (willRetry) {
          await sleep(retryDelayMs())
          continue
        }
        dependencies.recordCircuitFailure(circuitKey, error, response.headers.get('Retry-After'))
        throw error
      }
      observeTDXResponseSuccess(isShared)

      let data: { access_token?: string; expires_in?: number }
      try {
        const parsed = await dependencies.readJsonResponse(response, TDX_TOKEN_MAX_RESPONSE_BYTES)
        dependencies.logResponseSize({
          operation: 'token',
          resource: 'token',
          credentialScope: isShared ? 'shared' : 'byok',
          maxBytes: TDX_TOKEN_MAX_RESPONSE_BYTES,
          receivedBytes: parsed.receivedBytes,
          declaredBytes: parsed.declaredBytes,
          sampled: false,
        })
        data = parsed.data as { access_token?: string; expires_in?: number }
      } catch (error) {
        const serviceError = dependencies.isPayloadTooLargeError(error)
          ? error
          : new TDXServiceError('TDX token response is invalid JSON', 502, {
              cause: error,
              failureKind: 'invalid_json',
            })
        if (dependencies.isPayloadTooLargeError(serviceError)) {
          dependencies.logResponseTooLarge(serviceError, {
            operation: 'token',
            resource: 'token',
            credentialScope: isShared ? 'shared' : 'byok',
          })
        }
        dependencies.recordCircuitFailure(circuitKey, serviceError)
        throw serviceError
      }

      if (!data.access_token) {
        const error = new TDXServiceError('TDX token response is missing access_token', 502, {
          failureKind: 'invalid_schema',
        })
        dependencies.recordCircuitFailure(circuitKey, error)
        throw error
      }

      dependencies.recordCircuitSuccess(circuitKey)
      const expiresIn = Math.max(60, data.expires_in ?? 3600)
      cacheToken(credentialKey, {
        value: data.access_token,
        expiresAt: now() + Math.max(30, expiresIn - 60) * 1000,
      })
      return data.access_token
    }

    throw new TDXServiceError('TDX token request failed', undefined, { failureKind: 'unknown' })
  }

  const tokenFor = async (
    clientId: string,
    clientSecret: string,
    credentialKey: string,
    isShared: boolean,
  ): Promise<string> => {
    const existing = tokenFlights.get(credentialKey)
    if (existing) return existing

    dependencies.assertCircuitClosed(tokenCircuitKey(credentialKey))
    const cached = cachedToken(credentialKey)
    if (cached) return cached
    return joinTokenSingleflight(
      credentialKey,
      () => fetchTDXToken(clientId, clientSecret, credentialKey, isShared),
    )
  }

  const getTDXToken = async (env: TDXCredentialEnv): Promise<TDXTokenResult> => {
    const userToken = env.TDX_USER_ACCESS_TOKEN
    if (userToken) {
      return {
        token: userToken,
        isShared: false,
        credentialKey: await accessTokenFingerprint(userToken),
      }
    }

    const credentialKey = await credentialFingerprint(env.TDX_CLIENT_ID, env.TDX_CLIENT_SECRET)
    return {
      token: await tokenFor(env.TDX_CLIENT_ID, env.TDX_CLIENT_SECRET, credentialKey, true),
      isShared: true,
      credentialKey,
    }
  }

  return {
    getTDXToken,
    resetTDXTokenState: () => {
      tokenCache.clear()
      tokenFlights.clear()
    },
  }
}

export function withUserTDXAccessToken<E extends TDXCredentialEnv>(
  env: E,
  accessToken?: string | null,
): E {
  if (!accessToken) return env
  return { ...env, TDX_USER_ACCESS_TOKEN: accessToken }
}

export async function tdxCredentialScope(env: TDXCredentialEnv): Promise<string> {
  return env.TDX_USER_ACCESS_TOKEN
    ? `user/${await accessTokenFingerprint(env.TDX_USER_ACCESS_TOKEN)}`
    : 'shared'
}

async function accessTokenFingerprint(accessToken: string): Promise<string> {
  return sha256Hex(`user-token\0${accessToken}`)
}

async function credentialFingerprint(clientId: string, clientSecret: string): Promise<string> {
  return sha256Hex(`shared\0${clientId}\0${clientSecret}`)
}

async function sha256Hex(value: string): Promise<string> {
  const input = new TextEncoder().encode(value)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input))
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

const isRetryableTokenStatus = (status: number): boolean => status === 408 || status >= 500 && status <= 599
const tokenCircuitKey = (credentialKey: string): string => `token/${credentialKey}`
