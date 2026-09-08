import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  assertPublisherR2Credentials,
  resolvePublisherR2Credentials,
} from './publisher-r2-preflight.mjs'

const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
const rawEntrypoint = readFileSync(new URL('../sync-transit-snapshot.mjs', import.meta.url), 'utf8')
const preflightImport = '--import ./scripts/transit-snapshot/install-publisher-r2-preflight.mjs'

describe('snapshot publisher R2 preflight', () => {
  it('resolves the same env -> snapshot -> legacy worker precedence as the publisher', () => {
    const resolved = resolvePublisherR2Credentials({
      env: { R2_ACCESS_KEY_ID: 'env-access' },
      snapshotVars: {
        R2_ACCESS_KEY_ID: 'snapshot-access',
        R2_SECRET_ACCESS_KEY: 'snapshot-secret',
        CLOUDFLARE_ACCOUNT_ID: 'snapshot-account',
      },
      workerVars: {
        R2_SECRET_ACCESS_KEY: 'legacy-secret',
        CLOUDFLARE_ACCOUNT_ID: 'legacy-account',
      },
    })

    expect(resolved.credentials).toEqual({
      R2_ACCESS_KEY_ID: 'env-access',
      R2_SECRET_ACCESS_KEY: 'snapshot-secret',
      CLOUDFLARE_ACCOUNT_ID: 'snapshot-account',
    })
    expect(resolved.missing).toEqual([])
    expect(resolved.usesLegacyWorkerVars).toBe(false)
  })

  it('fails closed when any direct R2 credential is missing or blank', async () => {
    const readVars = vi.fn(async () => ({}))

    await expect(assertPublisherR2Credentials({
      env: {
        R2_ACCESS_KEY_ID: 'access',
        R2_SECRET_ACCESS_KEY: '   ',
        CLOUDFLARE_ACCOUNT_ID: 'account',
      },
      readVars,
    })).rejects.toThrow('R2_SECRET_ACCESS_KEY')

    expect(readVars).toHaveBeenCalledTimes(2)
  })

  it('keeps legacy .dev.vars compatibility but makes it explicit and deprecated', async () => {
    const warn = vi.fn()
    const readVars = vi.fn(async (file) => file === '.dev.vars' ? {
      R2_ACCESS_KEY_ID: 'legacy-access',
      R2_SECRET_ACCESS_KEY: 'legacy-secret',
      CLOUDFLARE_ACCOUNT_ID: 'legacy-account',
    } : {})

    await expect(assertPublisherR2Credentials({ env: {}, readVars, warn })).resolves.toEqual({
      R2_ACCESS_KEY_ID: 'legacy-access',
      R2_SECRET_ACCESS_KEY: 'legacy-secret',
      CLOUDFLARE_ACCOUNT_ID: 'legacy-account',
    })
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0][0]).toContain('.dev.vars')
  })

  it('preloads the guard on every supported snapshot publisher entrypoint', () => {
    for (const name of ['snapshot:city', 'snapshot:window']) {
      const command = packageJson.scripts[name]
      expect(command).toContain(preflightImport)
      expect(command.indexOf(preflightImport)).toBeLessThan(command.indexOf('scripts/'))
    }
  })

  it('guards the raw script before loading code that can acquire TDX data', () => {
    const guard = rawEntrypoint.indexOf('await assertPublisherR2Credentials()')
    const core = rawEntrypoint.indexOf("await import('./sync-transit-snapshot-core.mjs')")

    expect(guard).toBeGreaterThanOrEqual(0)
    expect(core).toBeGreaterThan(guard)
    expect(rawEntrypoint).not.toContain('tdx.transportdata.tw')
  })
})
