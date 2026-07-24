import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchRawBundle, TDXMeasurementError } from './tdx-source.mjs'

const roots = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('raw cache cleanup failure contract', () => {
  it('preserves the primary bounded error and exposes only a bounded orphan leaf', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'raw-cache-cleanup-'))
    roots.push(parent)
    const rawDir = join(parent, 'raw')
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify({ access_token: 'fake-access-token' }),
    }))
    const error = await fetchRawBundle({
      cities: ['Taipei'],
      includeIntercity: false,
      rawDir,
      concurrency: 1,
      fetcher,
      credentials: { clientId: 'fake-client-id', clientSecret: 'fake-client-secret' },
      progress: () => {
        throw new TDXMeasurementError('raw callback fake secret', {
          endpointCategory: 'shape', city: 'Taipei', failureClass: 'progress_failure',
        })
      },
      removeDirectory: async () => { throw Object.assign(new Error('EACCES raw path'), { code: 'EACCES' }) },
    }).catch((caught) => caught)

    expect(error.code).toBe('TDX_MEASUREMENT_ERROR')
    expect(error.details).toMatchObject({ failureClass: 'progress_failure' })
    expect(error.cleanupFailures).toHaveLength(1)
    expect(error.cleanupFailures[0]).toMatchObject({ stage: 'raw-cache-temporary-cleanup' })
    expect(error.cleanupFailures[0].temporaryPath).toMatch(/^raw\.tmp-/)
    const publicText = JSON.stringify(error)
    for (const forbidden of ['fake-access-token', 'fake-client-secret', 'raw callback fake secret', 'EACCES raw path']) {
      expect(publicText).not.toContain(forbidden)
    }
    expect((await readdir(parent)).some((name) => name.startsWith('raw.tmp-'))).toBe(true)
    expect((await readdir(parent))).not.toContain('raw')
  })
})
