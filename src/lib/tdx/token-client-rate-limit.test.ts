import { describe, expect, it, vi } from 'vitest'
import {
  TDXServiceError,
  classifyTDXWarning,
  responseFailureClass,
} from './error-classification'
import {
  createTDXTokenClient,
  type TDXTokenClientDependencies,
} from './token-client'

describe('TDX token retry classification', () => {
  it('does not retry a 503 response classified as rate limited', async () => {
    const fetcher = vi.fn(async () => new Response('request frequency limit reached', {
      status: 503,
      headers: { 'Retry-After': '30' },
    }))
    const sleep = vi.fn(async () => undefined)
    const recordCircuitFailure = vi.fn()
    const recordCircuitSuccess = vi.fn()
    const logRequestFailure = vi.fn()

    const responseError: TDXTokenClientDependencies['responseError'] = async (
      context,
      response,
    ) => {
      const warning = classifyTDXWarning(response.status, await response.text())
      const error = new TDXServiceError(`${context} (${response.status})`, response.status, {
        failureKind: responseFailureClass(response.status, warning),
      })
      error.warning = warning
      return error
    }

    const client = createTDXTokenClient({
      requestTimeoutMs: 6000,
      assertCircuitClosed: vi.fn(),
      recordCircuitFailure,
      recordCircuitSuccess,
      responseError,
      readJsonResponse: vi.fn(async () => ({ data: {}, receivedBytes: 0 })),
      isPayloadTooLargeError: (_error): _error is TDXServiceError => false,
      logResponseTooLarge: vi.fn(),
      logResponseSize: vi.fn(),
      logRequestFailure,
      fetcher: fetcher as typeof fetch,
      sleep,
    })

    await expect(client.getTDXToken({
      TDX_CLIENT_ID: 'rate-limited-id',
      TDX_CLIENT_SECRET: 'rate-limited-secret',
    })).rejects.toMatchObject({
      status: 503,
      warning: 'tdx-rate-limit',
      failureKind: 'rate_limited',
    })

    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
    expect(recordCircuitSuccess).not.toHaveBeenCalled()
    expect(recordCircuitFailure).toHaveBeenCalledTimes(1)
    expect(recordCircuitFailure).toHaveBeenCalledWith(
      expect.stringMatching(/^token\//),
      expect.objectContaining({
        status: 503,
        warning: 'tdx-rate-limit',
        failureKind: 'rate_limited',
      }),
      '30',
    )
    expect(logRequestFailure).toHaveBeenCalledWith(expect.objectContaining({
      attempt: 1,
      status: 503,
      failureKind: 'rate_limited',
      willRetry: false,
    }))
  })
})
