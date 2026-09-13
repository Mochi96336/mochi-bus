import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { runPublicProbe } from './run-public-probe.mjs'

const probeDate = '2026-09-13'

function reference(city = 'Hsinchu') {
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
      routeUid: `${city}100`,
      routeName: '100',
    },
  }
}

function store(city = 'Hsinchu') {
  return {
    startRun: vi.fn(async () => undefined),
    readReference: vi.fn(async () => reference(city)),
    readSample: vi.fn(async () => reference(city).sample),
    completeCity: vi.fn(async () => undefined),
    completeRun: vi.fn(async () => undefined),
  }
}

function routeVariant(city = 'Hsinchu') {
  return {
    variantKey: `${city}:0`,
    routeUid: `${city}100`,
    stops: {
      features: [
        { properties: { stopUid: `${city}-stop-1`, sequence: 1 } },
        { properties: { stopUid: `${city}-stop-2`, sequence: 2 } },
      ],
    },
  }
}

function api({
  city = 'Hsinchu',
  route = { schemaVersion: 1, source: 'snapshot', variants: [routeVariant(city)] },
  stopPlace = {
    schemaVersion: 1,
    city,
    stopUid: `${city}-stop-1`,
    place: { placeId: `${city}-place-1` },
  },
  routeError = null,
} = {}) {
  return {
    getJson: vi.fn(async (path) => {
      if (path.startsWith('/api/v1/map/routes?')) {
        return {
          schemaVersion: 2,
          source: 'snapshot',
          snapshotVersion: 'v1',
          routes: [{ routeName: '100' }],
        }
      }
      if (path.startsWith('/api/v1/map/route?')) {
        if (routeError) throw routeError
        return route
      }
      if (path.startsWith('/api/v1/map/stop-place?')) return stopPlace
      throw new Error(`unexpected path ${path}`)
    }),
    postJson: vi.fn(async () => { throw new Error('not expected') }),
    readPrefix: vi.fn(async () => { throw new Error('not expected') }),
  }
}

async function runFailure(publicApi, routeSampleDetailEmitter = vi.fn()) {
  const result = await runPublicProbe({
    env: {
      GITHUB_RUN_ID: '34739021977',
      GITHUB_RUN_ATTEMPT: '1',
      GITHUB_SHA: '0123456789abcdef0123456789abcdef01234567',
    },
    now: () => new Date(`${probeDate}T04:56:00.000Z`),
    monotonic: () => 1_000,
    store: store(),
    publicApi,
    cities: ['Hsinchu'],
    realtimeSampleSize: 0,
    emitter: vi.fn(),
    realtimeDetailEmitter: vi.fn(),
    routeSampleDetailEmitter,
    summaryWriter: vi.fn(),
  })
  return { result, routeSampleDetailEmitter }
}

describe('public probe route-sample detail', () => {
  it('attributes a missing deterministic variant without adding a request', async () => {
    const publicApi = api({
      route: { schemaVersion: 1, source: 'snapshot', variants: [] },
    })
    const { result, routeSampleDetailEmitter } = await runFailure(publicApi)

    expect(result).toMatchObject({ ok: false, failedCities: ['Hsinchu'] })
    expect(routeSampleDetailEmitter).toHaveBeenCalledTimes(1)
    expect(routeSampleDetailEmitter).toHaveBeenCalledWith({
      message: 'public_probe_route_sample_detail',
      city: 'Hsinchu',
      sampleCaseId: expect.stringMatching(/^pub_[a-f0-9]{12}$/),
      stage: 'variant_missing',
    })
    expect(publicApi.getJson).toHaveBeenCalledTimes(2)
    expect(publicApi.postJson).not.toHaveBeenCalled()
    expect(publicApi.readPrefix).not.toHaveBeenCalled()
  })

  it('distinguishes a route fetch failure from a malformed route response', async () => {
    const failedFetch = api({ routeError: new Error('route request failed') })
    const fetchDetail = await runFailure(failedFetch)
    expect(fetchDetail.routeSampleDetailEmitter).toHaveBeenCalledWith(expect.objectContaining({
      stage: 'route_fetch_failed',
    }))

    const malformed = api({ route: { schemaVersion: 7, source: 'snapshot', variants: [] } })
    const malformedDetail = await runFailure(malformed)
    expect(malformedDetail.routeSampleDetailEmitter).toHaveBeenCalledWith(expect.objectContaining({
      stage: 'route_response_invalid',
    }))
  })

  it('distinguishes invalid route stops from an invalid stop-place response', async () => {
    const invalidStops = api({
      route: {
        schemaVersion: 1,
        source: 'snapshot',
        variants: [{
          variantKey: 'Hsinchu:0',
          routeUid: 'Hsinchu100',
          stops: { features: [{ properties: { stopUid: 'Hsinchu-stop-1', sequence: 1 } }] },
        }],
      },
    })
    const stopDetail = await runFailure(invalidStops)
    expect(stopDetail.routeSampleDetailEmitter).toHaveBeenCalledWith(expect.objectContaining({
      stage: 'variant_stops_invalid',
    }))

    const invalidStopPlace = api({ stopPlace: { schemaVersion: 1, city: 'Hsinchu', stopUid: 'Hsinchu-stop-1', place: null } })
    const placeDetail = await runFailure(invalidStopPlace)
    expect(placeDetail.routeSampleDetailEmitter).toHaveBeenCalledWith(expect.objectContaining({
      stage: 'stop_place_invalid',
    }))
  })

  it('distinguishes invalid first-stop, stop-place fetch, and reference sample stages', async () => {
    const invalidFirstStop = api({
      route: {
        schemaVersion: 1,
        source: 'snapshot',
        variants: [{
          variantKey: 'Hsinchu:0',
          routeUid: 'Hsinchu100',
          stops: { features: [
            { properties: { stopUid: '', sequence: 1 } },
            { properties: { stopUid: '', sequence: 2 } },
          ] },
        }],
      },
    })
    const firstStopDetail = await runFailure(invalidFirstStop)
    expect(firstStopDetail.routeSampleDetailEmitter).toHaveBeenCalledWith(expect.objectContaining({
      stage: 'first_stop_invalid',
    }))

    const stopPlaceFailure = api()
    const originalGetJson = stopPlaceFailure.getJson
    stopPlaceFailure.getJson = vi.fn(async (path) => {
      if (path.startsWith('/api/v1/map/stop-place?')) throw new Error('stop-place request failed')
      return await originalGetJson(path)
    })
    const stopPlaceDetail = await runFailure(stopPlaceFailure)
    expect(stopPlaceDetail.routeSampleDetailEmitter).toHaveBeenCalledWith(expect.objectContaining({
      stage: 'stop_place_fetch_failed',
    }))

    const missingSampleStore = store()
    missingSampleStore.readSample = vi.fn(async () => null)
    const routeSampleDetailEmitter = vi.fn()
    const publicApi = api()
    const result = await runPublicProbe({
      env: {
        GITHUB_RUN_ID: '34739021977',
        GITHUB_RUN_ATTEMPT: '1',
        GITHUB_SHA: '0123456789abcdef0123456789abcdef01234567',
      },
      now: () => new Date(`${probeDate}T04:56:00.000Z`),
      monotonic: () => 1_000,
      store: missingSampleStore,
      publicApi,
      cities: ['Hsinchu'],
      realtimeSampleSize: 0,
      emitter: vi.fn(),
      realtimeDetailEmitter: vi.fn(),
      routeSampleDetailEmitter,
      summaryWriter: vi.fn(),
    })
    expect(result).toMatchObject({ ok: false, failedCities: ['Hsinchu'] })
    expect(routeSampleDetailEmitter).toHaveBeenCalledWith(expect.objectContaining({
      stage: 'reference_sample_invalid',
    }))
    expect(publicApi.getJson).toHaveBeenCalledTimes(1)
  })

  it('keeps the bounded diagnostic emitter fail-open', async () => {
    const publicApi = api({
      route: { schemaVersion: 1, source: 'snapshot', variants: [] },
    })
    const { result } = await runFailure(publicApi, () => { throw new Error('logging unavailable') })

    expect(result).toMatchObject({ ok: false, failedCities: ['Hsinchu'] })
  })

  it('wires the bounded detail emitter into the production CLI', async () => {
    const source = await readFile(new URL('./run-public-probe.mjs', import.meta.url), 'utf8')
    expect(source).toContain("routeSampleDetailEmitter: (event) => console.log(JSON.stringify(event))")
    expect(source).not.toContain('routeSampleDetailEmitter: console.error')
  })
})
