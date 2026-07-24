import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RAW_SCHEMA_VERSION } from './constants.mjs'
import {
  assertReplayScope, computeBundleHash, expectedEndpointSpecs, fetchRawBundle,
  parseRetryAfter, replayRawBundle, requestJsonWithRetry, validateManifest,
} from './tdx-source.mjs'
import { contentHash, stableStringify } from './util.mjs'

const roots = []
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function cacheFixture({ cities = ['Taipei'], includeIntercity = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'shape-measure-cache-'))
  roots.push(root)
  const endpoints = []
  for (const spec of expectedEndpointSpecs(cities, includeIntercity)) {
    const payload = [{ RouteUID: spec.endpointId, UpdateTime: '2026-07-22T00:00:00+08:00' }]
    await writeFile(join(root, spec.fileName), `${stableStringify(payload)}\n`)
    endpoints.push({
      endpointId: spec.endpointId,
      scope: spec.scope,
      city: spec.city,
      category: spec.category,
      fileName: spec.fileName,
      contentHash: contentHash(payload),
      itemCount: payload.length,
      maxUpdateTime: payload[0].UpdateTime,
    })
  }
  const manifest = {
    schemaVersion: RAW_SCHEMA_VERSION,
    fetchedAt: '2026-07-22T01:00:00.000Z',
    cities,
    includeIntercity,
    endpoints,
    bundleContentHash: null,
  }
  manifest.bundleContentHash = computeBundleHash(manifest)
  await writeFile(join(root, 'manifest.json'), `${stableStringify(manifest, 2)}\n`)
  return { root, manifest }
}

async function rewriteManifest(root, mutate) {
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'))
  mutate(manifest)
  await writeFile(join(root, 'manifest.json'), `${stableStringify(manifest, 2)}\n`)
  return manifest
}

describe('verified raw replay manifest', () => {
  it('replays without credentials or network access', async () => {
    const { root, manifest } = await cacheFixture()
    const result = await replayRawBundle({ rawDir: root })
    expect(result.manifest).toEqual(manifest)
    expect(result.bundle.sources).toHaveLength(1)
  })

  it.each([
    ['../../outside.json'],
    [resolve('/tmp/outside.json')],
    ['city-Taipei-shape.json/../outside.json'],
  ])('rejects non-canonical endpoint fileName %s', async (fileName) => {
    const { root } = await cacheFixture()
    await rewriteManifest(root, (manifest) => { manifest.endpoints[0].fileName = fileName })
    await expect(replayRawBundle({ rawDir: root })).rejects.toThrow(/metadata|path|cache/i)
  })

  it('rejects a symlink even when its content hash is valid', async () => {
    const { root, manifest } = await cacheFixture()
    const entry = manifest.endpoints[0]
    const outside = join(await mkdtemp(join(tmpdir(), 'shape-measure-outside-')), 'payload.json')
    roots.push(resolve(outside, '..'))
    const payload = JSON.parse(await readFile(join(root, entry.fileName), 'utf8'))
    await writeFile(outside, `${stableStringify(payload)}\n`)
    await rm(join(root, entry.fileName))
    await symlink(outside, join(root, entry.fileName))
    await expect(replayRawBundle({ rawDir: root })).rejects.toThrow(/regular file|trusted/i)
  })

  it.each([
    ['missing endpoint', (manifest) => manifest.endpoints.pop()],
    ['duplicate endpoint', (manifest) => manifest.endpoints.push({ ...manifest.endpoints[0] })],
    ['extra endpoint', (manifest) => manifest.endpoints.push({ ...manifest.endpoints[0], endpointId: 'extra', fileName: 'extra.json' })],
    ['identity/filename mismatch', (manifest) => { manifest.endpoints[0].fileName = manifest.endpoints[1].fileName }],
  ])('fails closed for %s', async (_name, mutate) => {
    const { root } = await cacheFixture()
    const manifest = await rewriteManifest(root, mutate)
    expect(() => validateManifest(manifest)).toThrow(/endpoint|metadata|cache/i)
    await expect(replayRawBundle({ rawDir: root })).rejects.toThrow()
  })

  it('rejects replay scope restatement that differs from the verified manifest', async () => {
    const { manifest } = await cacheFixture({ cities: ['Taipei'], includeIntercity: false })
    expect(() => assertReplayScope({ citiesExplicit: true, cities: ['NewTaipei'], includeIntercityExplicit: false }, manifest)).toThrow(/cities/)
    expect(() => assertReplayScope({ citiesExplicit: false, includeIntercityExplicit: true, includeIntercity: true }, manifest)).toThrow(/InterCity/)
    expect(() => assertReplayScope({ citiesExplicit: false, includeIntercityExplicit: false }, manifest)).not.toThrow()
  })

  it('binds metadata as well as payload hashes into the bundle hash', async () => {
    const { root } = await cacheFixture()
    await rewriteManifest(root, (manifest) => { manifest.endpoints[0].itemCount += 1 })
    await expect(replayRawBundle({ rawDir: root })).rejects.toThrow(/bundle hash/i)
  })

  it('rejects corrupted endpoint payload, corrupted bundle, and a partial cache', async () => {
    const first = await cacheFixture()
    await writeFile(join(first.root, first.manifest.endpoints[0].fileName), '[]\n')
    await expect(replayRawBundle({ rawDir: first.root })).rejects.toThrow(/content hash/i)

    const second = await cacheFixture()
    await rewriteManifest(second.root, (manifest) => { manifest.bundleContentHash = '0'.repeat(64) })
    await expect(replayRawBundle({ rawDir: second.root })).rejects.toThrow(/bundle hash/i)

    const third = await cacheFixture()
    await rm(join(third.root, third.manifest.endpoints[0].fileName))
    await expect(replayRawBundle({ rawDir: third.root })).rejects.toThrow(/regular file/i)
  })
})

describe('body-inclusive request timeout and bounded retry', () => {
  it('aborts when headers arrive but body consumption never completes', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn(async (_url, init) => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: () => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
      }),
    }))
    const promise = requestJsonWithRetry({
      endpointCategory: 'shape', city: 'Taipei', url: 'https://example.invalid', init: {},
      fetcher, random: () => 0, now: () => new Date('2026-07-22T00:00:00Z'),
      expectArray: true, maxAttempts: 1, timeoutMs: 10,
    })
    const rejection = expect(promise).rejects.toMatchObject({ details: { failureClass: 'timeout', retryCount: 0 } })
    await vi.advanceTimersByTimeAsync(11)
    await rejection
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('does not retry 401 or expose response body', async () => {
    const fetcher = vi.fn(async () => ({
      ok: false, status: 401, headers: new Headers(),
      text: vi.fn(async () => 'secret response body'),
    }))
    const error = await requestJsonWithRetry({
      endpointCategory: 'shape', city: 'Taipei', url: 'https://example.invalid', init: {},
      fetcher, random: () => 0, now: () => new Date(), expectArray: true,
      maxAttempts: 5, timeoutMs: 10,
    }).catch((caught) => caught)
    expect(error).toMatchObject({ details: { httpStatus: 401, failureClass: 'upstream_4xx', retryCount: 0 } })
    expect(String(error)).not.toContain('secret response body')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('parses Retry-After seconds and HTTP dates', () => {
    const now = new Date('2026-07-22T00:00:00.000Z')
    expect(parseRetryAfter('3', now)).toBe(3000)
    expect(parseRetryAfter('Wed, 22 Jul 2026 00:00:05 GMT', now)).toBe(5000)
  })
})

describe('atomic live cache target', () => {
  it('fails before requesting credentials or network when the target already exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shape-measure-existing-'))
    roots.push(root)
    const fetcher = vi.fn()
    await expect(fetchRawBundle({
      cities: ['Taipei'], includeIntercity: false, rawDir: root,
      fetcher, credentials: { clientId: 'id', clientSecret: 'secret' },
    })).rejects.toThrow(/already exists/i)
    expect(fetcher).not.toHaveBeenCalled()
  })
})
