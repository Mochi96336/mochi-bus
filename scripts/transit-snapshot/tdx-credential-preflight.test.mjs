import { describe, expect, it, vi } from 'vitest'
import {
  renderTdxCredentialPreflightMarkdown,
  renderTdxCredentialPreflightText,
  runTdxCredentialPreflight,
  safeTdxCredentialFailure,
} from './tdx-credential-preflight.mjs'

describe('TDX credential preflight', () => {
  it('returns only bounded non-secret success metadata', async () => {
    const acquire = vi.fn(async ({ env }) => {
      expect(env.TDX_CLIENT_ID).toBe('client-id-private')
      expect(env.TDX_CLIENT_SECRET).toBe('client-secret-private')
      return {
        schemaVersion: 1,
        accessToken: 'access-token-private',
        obtainedAt: 1_000,
        expiresAt: 3_601_000,
      }
    })

    const report = await runTdxCredentialPreflight({
      env: {
        TDX_CLIENT_ID: 'client-id-private',
        TDX_CLIENT_SECRET: 'client-secret-private',
      },
      acquire,
      now: () => 1_000,
    })

    expect(report).toEqual({
      schemaVersion: 1,
      ok: true,
      expiresInSeconds: 3600,
    })
    const rendered = `${renderTdxCredentialPreflightText(report)}\n${renderTdxCredentialPreflightMarkdown(report)}`
    expect(rendered).toContain('READY')
    expect(rendered).toContain('3600 seconds')
    expect(rendered).not.toMatch(/access-token-private|client-id-private|client-secret-private/)
  })

  it('preserves bounded OAuth failure classes without echoing arbitrary errors', () => {
    expect(safeTdxCredentialFailure(
      new Error('TDX token preflight failed (400; unauthorized_client)'),
    )).toBe('TDX token preflight failed (400; unauthorized_client)')
    expect(safeTdxCredentialFailure(
      new Error('TDX token preflight failed (timeout)'),
    )).toBe('TDX token preflight failed (timeout)')
    expect(safeTdxCredentialFailure(
      new Error('secret=client-secret-private'),
    )).toBe('TDX token preflight failed (unclassified)')
  })

  it('renders blocked evidence without secret-bearing details', () => {
    const report = {
      schemaVersion: 1,
      ok: false,
      failure: safeTdxCredentialFailure(new Error('client-secret-private should never escape')),
    }
    const rendered = `${renderTdxCredentialPreflightText(report)}\n${renderTdxCredentialPreflightMarkdown(report)}`
    expect(rendered).toContain('BLOCKED')
    expect(rendered).toContain('unclassified')
    expect(rendered).not.toContain('client-secret-private')
  })
})
