import { describe, expect, it, vi } from 'vitest'
import {
  WORKER_ANALYTICS_PREFLIGHT_QUERY,
  WORKER_ANALYTICS_PREFLIGHT_SCRIPT,
  probeCloudflareAnalyticsCredential,
} from './cloudflare-analytics-credential-preflight.mjs'

const accountId = 'account-123'
const apiToken = 'secret-token-value'
const now = () => new Date('2026-09-15T09:30:00.000Z')

function response(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  }
}

describe('Cloudflare Account Analytics credential preflight', () => {
  it('uses the Worker resource measurement dataset and fields', () => {
    for (const needle of [
      'query WorkerResourceMeasurement',
      'workersInvocationsAdaptive(',
      'memoryUsageBytesP50',
      'memoryUsageBytesP90',
      'memoryUsageBytesP99',
      'memoryUsageBytesP999',
      'errors',
      'requests',
      'subrequests',
    ]) expect(WORKER_ANALYTICS_PREFLIGHT_QUERY).toContain(needle)
    expect(WORKER_ANALYTICS_PREFLIGHT_SCRIPT).toMatch(/^[a-z0-9][a-z0-9-]{0,62}$/)
  })

  it('reports unconfigured without making a request when credentials are missing', async () => {
    const fetchImpl = vi.fn()
    const report = await probeCloudflareAnalyticsCredential({ accountId, apiToken: '', fetchImpl, now })
    expect(report).toMatchObject({ outcome: 'unconfigured', ready: false, httpStatus: null })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('accepts an authorized empty Worker analytics result', async () => {
    const fetchImpl = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body)
      expect(body.operationName).toBe('WorkerResourceMeasurement')
      expect(body.variables).toMatchObject({ accountTag: accountId, scriptName: WORKER_ANALYTICS_PREFLIGHT_SCRIPT })
      expect(init.headers.Authorization).toBe(`Bearer ${apiToken}`)
      return response(200, {
        data: { viewer: { accounts: [{ workersInvocationsAdaptive: [] }] } },
      })
    })
    const report = await probeCloudflareAnalyticsCredential({ accountId, apiToken, fetchImpl, now })
    expect(report).toMatchObject({
      outcome: 'ready',
      ready: true,
      httpStatus: 200,
      dataset: 'workersInvocationsAdaptive',
      operationName: 'WorkerResourceMeasurement',
      probeRows: 0,
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('fails closed on authorization errors and redacts sensitive values', async () => {
    const fetchImpl = vi.fn(async () => response(403, {
      errors: [{ extensions: { code: 9109 }, message: `not authorized for ${accountId} with ${apiToken}` }],
    }))
    const report = await probeCloudflareAnalyticsCredential({ accountId, apiToken, fetchImpl, now })
    expect(report).toMatchObject({ outcome: 'unauthorized', ready: false, httpStatus: 403 })
    expect(report.errorDetail).toContain('<redacted>')
    expect(report.errorDetail).not.toContain(accountId)
    expect(report.errorDetail).not.toContain(apiToken)
  })

  it('fails closed when the account or dataset shape is unavailable', async () => {
    const noAccount = await probeCloudflareAnalyticsCredential({
      accountId,
      apiToken,
      now,
      fetchImpl: async () => response(200, { data: { viewer: { accounts: [] } } }),
    })
    expect(noAccount).toMatchObject({ outcome: 'account_unavailable', ready: false })

    const badDataset = await probeCloudflareAnalyticsCredential({
      accountId,
      apiToken,
      now,
      fetchImpl: async () => response(200, { data: { viewer: { accounts: [{ workersInvocationsAdaptive: null }] } } }),
    })
    expect(badDataset).toMatchObject({ outcome: 'invalid_payload', ready: false })
  })
})
