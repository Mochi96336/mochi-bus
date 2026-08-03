import { describe, expect, it, vi } from 'vitest'
import { resolvePublicProbeBaseUrl } from './public-probe-origin.mjs'

describe('public probe origin', () => {
  it('prefers an explicit operator-provided origin', () => {
    const readFile = vi.fn()
    expect(resolvePublicProbeBaseUrl({
      env: { SNAPSHOT_SMOKE_BASE_URL: 'https://chiayi.example' },
      readFile,
    })).toBe('https://chiayi.example')
    expect(readFile).not.toHaveBeenCalled()
  })

  it('derives a fixed canonical origin from the compiled instance runtime', () => {
    const readFile = vi.fn(() => JSON.stringify({
      site: { canonicalOrigin: 'https://bus.example' },
    }))
    expect(resolvePublicProbeBaseUrl({ cwd: '/repo', env: {}, readFile })).toBe('https://bus.example')
    expect(readFile).toHaveBeenCalledWith('/repo/.generated/instance/instance-runtime.json', 'utf8')
  })

  it('fails closed when a request-derived instance has no explicit public URL', () => {
    expect(() => resolvePublicProbeBaseUrl({
      env: {},
      readFile: () => JSON.stringify({ site: { canonicalOrigin: 'request' } }),
    })).toThrow('SNAPSHOT_SMOKE_BASE_URL is required')
  })

  it('rejects paths, credentials and non-http origins', () => {
    for (const value of ['https://example.com/path', 'https://user@example.com', 'ftp://example.com']) {
      expect(() => resolvePublicProbeBaseUrl({
        env: { SNAPSHOT_SMOKE_BASE_URL: value },
      })).toThrow('must be an absolute HTTP origin')
    }
  })
})
