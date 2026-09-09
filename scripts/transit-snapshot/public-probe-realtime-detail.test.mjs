import { describe, expect, it, vi } from 'vitest'
import { probePublicSurface } from './public-probe.mjs'
import { runPublicProbe } from './run-public-probe.mjs'

const probeDate = '2026-07-19'

function reference(city = 'Taipei') {
  return {
    activeVersion: 'v1',
    counts: {
      routes: 1,
      patterns: 1,
      places: 1,
      routeWithoutPattern: 0,
      sampleCount: 1,
    },
    sample: {
      patternId: `${city}:0`,
      routeUid: `${city}307`,
      routeName: '307',
    },
  }
}

function api({ arrivalsWarning = null, journeyWarning = null, vehiclesWarning = null } = {}) {
  const getJson = vi.fn(async (path) => {
    const url = new URL(path, 'https://bus.example')
    const city = url.searchParams.get('city') ?? 'Taipei'
    if (url.pathname === '/api/v1/map/routes') {
      return { schemaVersion: 2, source: 'snapshot', snapshotVersion: 'v1', routes: [{ routeName: '307' }] }
    }
    if (url.pathname === '/api/v1/map/route') {
      return {
        schemaVersion: 1,
        source: 'snapshot',
        variants: [{
          variantKey: `${city}:0`,
          routeUid: `${city}307`,
          stops: { features: [
            { properties: { stopUid: `${city}-stop-1`, sequence: 1 } },
            { properties: { stopUid: `${city}-stop-2`, sequence: 2 } },
          ] },
        }],
      }
    }
    if (url.pathname === '/api/v1/map/stop-place') {
      const stopUid = url.searchParams.get('stopUid')
      return {
        schemaVersion: 1,
        city,
        stopUid,
        place: { placeId: `${city}-place-1`, name: '第一站', latitude: 25, longitude: 121.5 },
      }
    }
    if (url.pathname.includes('/arrivals')) {
      return {
        schemaVersion: 1,
        scheduleSource: 'place-bundle',
        snapshotVersion: 'v1',
        warning: arrivalsWarning,
        routes: [{ variantKey: `${city}:0`, source: arrivalsWarning ? 'schedule' : 'realtime' }],
        realtime: { candidates: 1, queries: arrivalsWarning ? 0 : 1, rateLimited: arrivalsWarning === 'tdx-rate-limit' || arrivalsWarning === 'tdx-quota' },
      }
    }
    if (url.pathname === '/api/v1/map/vehicles') {
      return { schemaVersion: 1, vehicles: [], warning: vehiclesWarning }
    }
    throw new Error(`unexpected path ${path}`)
  })

  const postJson = vi.fn(async () => ({
    schemaVersion: 1,
    warning: journeyWarning,
    estimates: [{ key: 'probe', minutes: journeyWarning ? null : 3, source: journeyWarning ? 'none' : 'realtime' }],
  }))

  const readPrefix = vi.fn(async () => '{"schemaVersion":1,"city":"Taipei","version":"v1",')
  return { getJson, postJson, readPrefix }
}

async function probeWithDetail(options = {}) {
  const publicApi = api(options)
  const realtimeDetailEmitter = vi.fn()
  const result = await probePublicSurface({
    city: 'Taipei',
    probeDate,
    reference: reference(),
    publicApi,
    realtimeDetailEmitter,
    now: () => new Date('2026-07-19T00:20:00.000Z'),
  })
  return { result, publicApi, realtimeDetailEmitter }
}

describe('public probe realtime detail', () => {
  it.each(['tdx-quota', 'tdx-rate-limit', 'tdx-unavailable'])(
    'preserves the safe %s warning without adding requests',
    async (warning) => {
      const { result, publicApi, realtimeDetailEmitter } = await probeWithDetail({
        arrivalsWarning: warning,
        journeyWarning: warning,
        vehiclesWarning: warning,
      })

      expect(result.status).toBe('realtime_degraded')
      expect(realtimeDetailEmitter).toHaveBeenCalledTimes(1)
      expect(realtimeDetailEmitter).toHaveBeenCalledWith(expect.objectContaining({
        message: 'public_probe_realtime_detail',
        city: 'Taipei',
        sampleCaseId: expect.stringMatching(/^pub_[a-f0-9]{12}$/),
        arrivalsWarning: warning,
        journeyWarning: warning,
        vehiclesWarning: warning,
      }))
      expect(publicApi.getJson).toHaveBeenCalledTimes(5)
      expect(publicApi.postJson).toHaveBeenCalledTimes(1)
      expect(publicApi.readPrefix).toHaveBeenCalledTimes(1)
    },
  )

  it('drops unknown warning text instead of copying upstream data into logs', async () => {
    const { realtimeDetailEmitter } = await probeWithDetail({
      arrivalsWarning: 'credential body: secret-looking text',
      journeyWarning: { unexpected: 'object' },
      vehiclesWarning: 'some-new-warning',
    })

    expect(realtimeDetailEmitter).toHaveBeenCalledWith(expect.objectContaining({
      arrivalsWarning: null,
      journeyWarning: null,
      vehiclesWarning: null,
    }))
  })

  it('keeps detail logging fail-open', async () => {
    const publicApi = api({ arrivalsWarning: 'tdx-quota' })
    const result = await probePublicSurface({
      city: 'Taipei',
      probeDate,
      reference: reference(),
      publicApi,
      realtimeDetailEmitter: () => { throw new Error('logging unavailable') },
      now: () => new Date('2026-07-19T00:20:00.000Z'),
    })

    expect(result).toMatchObject({ status: 'realtime_degraded', activeVersion: 'v1', observedVersion: 'v1' })
  })

  it('forwards one detail event per healthy city through the runner', async () => {
    const publicApi = api()
    const realtimeDetailEmitter = vi.fn()
    const store = {
      startRun: vi.fn(async () => undefined),
      readReference: vi.fn(async () => reference()),
      readSample: vi.fn(async () => reference().sample),
      completeCity: vi.fn(async () => undefined),
      completeRun: vi.fn(async () => undefined),
    }

    const result = await runPublicProbe({
      env: {
        GITHUB_RUN_ID: '29600000000',
        GITHUB_RUN_ATTEMPT: '1',
        GITHUB_SHA: '0123456789abcdef0123456789abcdef01234567',
      },
      now: () => new Date('2026-07-19T00:20:00.000Z'),
      monotonic: () => 1_000,
      store,
      publicApi,
      cities: ['Taipei'],
      emitter: vi.fn(),
      realtimeDetailEmitter,
      summaryWriter: vi.fn(),
    })

    expect(result.ok).toBe(true)
    expect(realtimeDetailEmitter).toHaveBeenCalledTimes(1)
    expect(realtimeDetailEmitter).toHaveBeenCalledWith(expect.objectContaining({
      message: 'public_probe_realtime_detail',
      city: 'Taipei',
      arrivalsWarning: null,
      journeyWarning: null,
      vehiclesWarning: null,
      journeyRequestFailed: false,
      vehiclesRequestFailed: false,
    }))
  })
})
