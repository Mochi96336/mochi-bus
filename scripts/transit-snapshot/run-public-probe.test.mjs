import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseTelemetryEvent } from '../../src/observability/telemetry.ts'
import { operationEnabledCities } from '../instance/operations-plan.mjs'
import { PUBLIC_PROBE_HARD_CHECK_COUNT } from './public-probe-contract.mjs'
import {
  createPublicApiAdapter,
  PUBLIC_PROBE_CITIES,
  publicProbeSummaryMarkdown,
  readResponsePrefix,
  runPublicProbe,
} from './run-public-probe.mjs'

function reference(city) {
  return {
    activeVersion: 'v1',
    counts: {
      routes: 1, patterns: 1, stops: 1, places: 1, patternStops: 2,
      routeWithoutPattern: 0, sampleCount: 1,
    },
    sample: {
      patternId: `${city}:0`, routeUid: `${city}307`, routeName: '307', placeId: 'place-1', stopSequence: 1,
    },
  }
}

function healthyApi() {
  return {
    getJson: vi.fn(async (path) => {
      if (path.startsWith('/api/v1/map/routes')) {
        return { schemaVersion: 2, source: 'snapshot', snapshotVersion: 'v1', routes: [{ routeName: '307' }] }
      }
      if (path.startsWith('/api/v1/map/route?')) {
        const cityMatch = /city=([A-Za-z]+)/.exec(path)
        return {
          schemaVersion: 1, source: 'snapshot',
          variants: [{ variantKey: `${cityMatch[1]}:0`, stops: { features: [{}, {}] } }],
        }
      }
      if (path.includes('/arrivals')) {
        const cityMatch = /city=([A-Za-z]+)/.exec(path)
        return {
          schemaVersion: 1, scheduleSource: 'place-bundle', snapshotVersion: 'v1',
          routes: [{ variantKey: `${cityMatch[1]}:0`, source: 'realtime' }],
          realtime: { candidates: 1, queries: 1, rateLimited: false },
        }
      }
      return { schemaVersion: 1, vehicles: [] }
    }),
    postJson: vi.fn(async () => ({
      schemaVersion: 1, estimates: [{ key: 'probe', minutes: 3, source: 'realtime' }],
    })),
    readPrefix: vi.fn(async (path) => {
      const cityMatch = /city=([A-Za-z]+)/.exec(path)
      return `{"schemaVersion":1,"city":"${cityMatch[1]}","version":"v1",`
    }),
  }
}

function fakeStore(overrides = {}) {
  return {
    readReference: vi.fn(async () => reference('Taipei')),
    readSample: vi.fn(async () => reference('Taipei').sample),
    startRun: vi.fn(async () => undefined),
    completeCity: vi.fn(async () => undefined),
    completeRun: vi.fn(async () => undefined),
    ...overrides,
  }
}

function runOptions(overrides = {}) {
  return {
    env: { GITHUB_RUN_ID: '29600000000', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: '0123456789abcdef0123456789abcdef01234567' },
    now: () => new Date('2026-07-19T00:20:00.000Z'),
    monotonic: () => 1_000,
    emitter: vi.fn(),
    summaryWriter: vi.fn(),
    ...overrides,
  }
}

describe('public probe runner', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => vi.restoreAllMocks())

  it('covers every enabled snapshot city once with strict telemetry per city', async () => {
    const emitter = vi.fn()
    const store = fakeStore({
      readReference: vi.fn(async (city) => reference(city)),
      readSample: vi.fn(async (city) => reference(city).sample),
    })
    const result = await runPublicProbe(runOptions({ store, publicApi: healthyApi(), emitter }))

    expect(new Set(PUBLIC_PROBE_CITIES)).toEqual(new Set(operationEnabledCities()))
    expect(result.ok).toBe(true)
    expect(result.summary.results.map((item) => item.city)).toEqual([...PUBLIC_PROBE_CITIES])
    expect(result.summary.results.every((item) => item.status === 'healthy')).toBe(true)
    expect(emitter).toHaveBeenCalledTimes(PUBLIC_PROBE_CITIES.length)
    for (const [event] of emitter.mock.calls) {
      expect(parseTelemetryEvent(event)).toEqual(event)
      expect(event).toMatchObject({ event: 'public_probe_completed', result: 'success' })
    }
  })

  it('keeps yellow realtime degradation from failing the job', async () => {
    const api = healthyApi()
    api.postJson = vi.fn(async () => ({ schemaVersion: 1, estimates: [{ key: 'probe', minutes: null, source: 'none' }] }))
    const store = fakeStore({
      readReference: vi.fn(async (city) => reference(city)),
      readSample: vi.fn(async (city) => reference(city).sample),
    })
    const result = await runPublicProbe(runOptions({ store, publicApi: api }))

    expect(result.ok).toBe(true)
    expect(result.summary.results.every((item) => item.status === 'realtime_degraded')).toBe(true)
    expect(result.failedCities).toEqual([])
  })

  it('fails the job on a hard failure but leaves other cities independent', async () => {
    const failedCity = PUBLIC_PROBE_CITIES[0]
    const api = healthyApi()
    const baseGetJson = api.getJson
    api.getJson = vi.fn(async (path) => {
      const url = new URL(path, 'https://bus.example')
      if (url.pathname === '/api/v1/map/routes' && url.searchParams.get('city') === failedCity) {
        return { schemaVersion: 2, source: 'snapshot', snapshotVersion: 'v0', routes: [{ routeName: '307' }] }
      }
      return baseGetJson(path)
    })
    const store = fakeStore({
      readReference: vi.fn(async (city) => reference(city)),
      readSample: vi.fn(async (city) => reference(city).sample),
    })
    const result = await runPublicProbe(runOptions({ store, publicApi: api }))

    expect(result.ok).toBe(false)
    expect(result.failedCities).toEqual([failedCity])
    const failed = result.summary.results.find((item) => item.city === failedCity)
    expect(failed).toMatchObject({ status: 'hard_failed', failureClass: 'public_version_mismatch', observedVersion: 'v0' })
  })

  it('marks unreachable references unknown without claiming city health', async () => {
    const store = fakeStore({
      readReference: vi.fn(async () => { throw new Error('D1 unavailable') }),
    })
    const result = await runPublicProbe(runOptions({ store, publicApi: healthyApi() }))

    expect(result.ok).toBe(false)
    expect(result.summary.results.every((item) =>
      item.status === 'unknown' && item.failureClass === 'reference_unavailable')).toBe(true)
  })

  it('reports durable-write failure without hiding it behind a green run', async () => {
    const store = fakeStore({
      readReference: vi.fn(async (city) => reference(city)),
      readSample: vi.fn(async (city) => reference(city).sample),
      completeCity: vi.fn(async () => { throw new Error('write refused') }),
    })
    const result = await runPublicProbe(runOptions({ store, publicApi: healthyApi() }))

    expect(result.ok).toBe(false)
    expect(result.summary.results.every((item) => item.status === 'record_write_failed')).toBe(true)
  })

  it('summarizes the two health planes separately', () => {
    const markdown = publicProbeSummaryMarkdown({
      probeDate: '2026-07-19',
      evaluatedAt: '2026-07-19T00:20:00.000Z',
      results: [
        {
          city: 'Taipei', status: 'healthy', activeVersion: 'v1', observedVersion: 'v1',
          hardChecksPassed: PUBLIC_PROBE_HARD_CHECK_COUNT, realtimeWarnings: [], failureClass: 'none', latencyBucket: '1_3s',
        },
        {
          city: 'Kaohsiung', status: 'realtime_degraded', activeVersion: 'v1', observedVersion: 'v1',
          hardChecksPassed: PUBLIC_PROBE_HARD_CHECK_COUNT,
          realtimeWarnings: ['realtime_schedule_only'], failureClass: 'realtime_schedule_only', latencyBucket: '1_3s',
        },
      ],
    })
    expect(markdown).toContain('- Healthy: Taipei')
    expect(markdown).toContain('- Realtime degraded: Kaohsiung')
    expect(markdown).toContain('- Hard failed: none')
  })
})

describe('public API adapter', () => {
  it('paces expensive endpoints below the shared rate limit', async () => {
    const sleeps = []
    let clock = 0
    const fetchImpl = vi.fn(async () => Response.json({ ok: true }))
    const adapter = createPublicApiAdapter({
      baseUrl: 'https://public.example',
      fetchImpl,
      expensiveIntervalMs: 2_500,
      sleep: async (milliseconds) => { sleeps.push(milliseconds); clock += milliseconds },
      monotonic: () => clock,
    })

    await adapter.getJson('/api/v1/map/routes?city=Taipei')
    await adapter.getJson('/api/v1/map/place/p1/arrivals?city=Taipei')
    await adapter.postJson('/api/v1/map/journey-eta', { city: 'Taipei', legs: [] })
    expect(sleeps).toEqual([2_500])
  })

  it('surfaces HTTP status for rate-limit classification', async () => {
    const adapter = createPublicApiAdapter({
      baseUrl: 'https://public.example',
      fetchImpl: vi.fn(async () => new Response('slow down', { status: 429 })),
    })
    await expect(adapter.getJson('/api/v1/map/routes?city=Taipei')).rejects.toMatchObject({ status: 429 })
  })

  it('reads only a bounded prefix of large streaming payloads', async () => {
    const chunk = new TextEncoder().encode('x'.repeat(1_024))
    let pulls = 0
    let cancelled = false
    const body = new ReadableStream({
      pull(controller) {
        pulls += 1
        controller.enqueue(chunk)
      },
      cancel() {
        cancelled = true
      },
    })
    const prefix = await readResponsePrefix(new Response(body), 4_096)
    expect(prefix).toHaveLength(4_096)
    expect(pulls).toBeLessThanOrEqual(6)
    expect(cancelled).toBe(true)
  })
})
