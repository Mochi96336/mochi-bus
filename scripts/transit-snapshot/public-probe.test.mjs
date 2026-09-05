import { describe, expect, it, vi } from 'vitest'
import { PUBLIC_PROBE_HARD_CHECK_COUNT } from './public-probe-contract.mjs'
import { probePublicSurface } from './public-probe.mjs'

const probeDate = '2026-07-19'

function reference(overrides = {}) {
  return {
    activeVersion: 'v1',
    counts: {
      routes: 3, patterns: 4, places: 12,
      routeWithoutPattern: 0, sampleCount: 4,
      ...overrides.counts,
    },
    sample: {
      patternId: 'TPE307:0', routeUid: 'TPE307', routeName: '307',
      ...overrides.sample,
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'counts' && key !== 'sample')),
  }
}

function responses(overrides = {}) {
  return {
    routes: {
      schemaVersion: 2, city: 'Taipei', source: 'snapshot', snapshotVersion: 'v1',
      routes: [{ routeName: '307' }, { routeName: '299' }, { routeName: '0東' }],
      ...overrides.routes,
    },
    route: {
      schemaVersion: 1, city: 'Taipei', routeName: '307', source: 'snapshot',
      variants: [{
        variantKey: 'TPE307:0', routeUid: 'TPE307',
        stops: { features: [
          { properties: { stopUid: 'TPE1001', stopName: '第一站', sequence: 1 } },
          { properties: { stopUid: 'TPE1002', stopName: '第二站', sequence: 2 } },
        ] },
      }],
      ...overrides.route,
    },
    stopPlace: {
      schemaVersion: 1, city: 'Taipei', stopUid: 'TPE1001',
      place: { placeId: 'place-1', name: '第一站', latitude: 25.0, longitude: 121.5 },
      ...overrides.stopPlace,
    },
    arrivals: {
      schemaVersion: 1, city: 'Taipei', scheduleSource: 'place-bundle', snapshotVersion: 'v1',
      routes: [{ variantKey: 'TPE307:0', source: 'realtime' }],
      realtime: { candidates: 1, queries: 1, rateLimited: false },
      ...overrides.arrivals,
    },
    journey: {
      schemaVersion: 1, city: 'Taipei', fetchedAt: '2026-07-19T00:20:05.000Z',
      estimates: [{ key: 'probe', minutes: 4, source: 'realtime' }],
      ...overrides.journey,
    },
    vehicles: { schemaVersion: 1, city: 'Taipei', routeName: '307', vehicles: [], ...overrides.vehicles },
    networkPrefix: `{"schemaVersion":1,"city":"Taipei","version":"v1","routes":[`,
    ...(overrides.networkPrefix === undefined ? {} : { networkPrefix: overrides.networkPrefix }),
  }
}

function fakeApi(data, overrides = {}) {
  return {
    getJson: vi.fn(async (path) => {
      if (path.startsWith('/api/v1/map/routes')) return data.routes
      if (path.startsWith('/api/v1/map/route?')) return data.route
      if (path.startsWith('/api/v1/map/stop-place?')) return data.stopPlace
      if (path.includes('/arrivals')) return data.arrivals
      if (path.startsWith('/api/v1/map/vehicles')) return data.vehicles
      throw new Error(`unexpected path ${path}`)
    }),
    postJson: vi.fn(async () => data.journey),
    readPrefix: vi.fn(async () => data.networkPrefix),
    ...overrides,
  }
}

async function probe({ referenceOverrides = {}, responseOverrides = {}, apiOverrides = {} } = {}) {
  return await probePublicSurface({
    city: 'Taipei',
    probeDate,
    reference: reference(referenceOverrides),
    publicApi: fakeApi(responses(responseOverrides), apiOverrides),
    now: () => new Date('2026-07-19T00:20:00.000Z'),
  })
}

describe('public surface probe', () => {
  it('passes the full hard chain and stays green with live realtime data', async () => {
    await expect(probe()).resolves.toMatchObject({
      status: 'healthy',
      failureClass: 'none',
      activeVersion: 'v1',
      observedVersion: 'v1',
      hardChecksPassed: PUBLIC_PROBE_HARD_CHECK_COUNT,
      realtimeWarnings: [],
    })
  })

  it('resolves place identity from the sampled public route instead of D1 high-card rows', async () => {
    const api = fakeApi(responses())
    await probePublicSurface({
      city: 'Taipei', probeDate, reference: reference(), publicApi: api,
      now: () => new Date('2026-07-19T00:20:00.000Z'),
    })

    const paths = api.getJson.mock.calls.map(([path]) => path)
    expect(paths).toEqual([
      '/api/v1/map/routes?city=Taipei',
      '/api/v1/map/route?city=Taipei&route=307&routeUid=TPE307&patternId=TPE307%3A0',
      '/api/v1/map/stop-place?city=Taipei&stopUid=TPE1001',
      '/api/v1/map/place/place-1/arrivals?city=Taipei',
      '/api/v1/map/vehicles?city=Taipei&route=307',
    ])
    for (const path of paths) {
      const url = new URL(path, 'https://bus.example')
      expect(url.searchParams.has('probe')).toBe(false)
      expect(url.searchParams.has('snapshot')).toBe(false)
      expect(url.searchParams.has('publicProbe')).toBe(false)
    }
    expect(api.postJson).toHaveBeenCalledWith('/api/v1/map/journey-eta', {
      city: 'Taipei',
      legs: [{
        key: expect.stringMatching(/^probe:pub_[a-f0-9]{12}$/),
        patternId: 'TPE307:0',
        sequence: 1,
      }],
    })
  })

  it('turns a version mismatch red and records what the public surface actually served', async () => {
    await expect(probe({ responseOverrides: { routes: { snapshotVersion: 'v0' } } })).resolves.toMatchObject({
      status: 'hard_failed', failureClass: 'public_version_mismatch', activeVersion: 'v1', observedVersion: 'v0',
    })
  })

  it('treats a TDX-source catalogue as a hard failure even when the response is valid', async () => {
    await expect(probe({ responseOverrides: { routes: { source: 'tdx', snapshotVersion: null } } }))
      .resolves.toMatchObject({ status: 'hard_failed', failureClass: 'public_source_not_snapshot' })
  })

  it('fails hard when the public catalogue count deviates from the active dataset', async () => {
    await expect(probe({ responseOverrides: { routes: { routes: [{ routeName: '307' }] } } }))
      .resolves.toMatchObject({ status: 'hard_failed', failureClass: 'public_count_mismatch' })
  })

  it('verifies the network artifact with a bounded prefix instead of a download', async () => {
    const api = fakeApi(responses())
    await probePublicSurface({
      city: 'Taipei', probeDate, reference: reference(), publicApi: api,
      now: () => new Date('2026-07-19T00:20:00.000Z'),
    })
    expect(api.readPrefix).toHaveBeenCalledWith(expect.stringContaining('/api/v1/map/network'), 65_536)
    await expect(probe({ responseOverrides: { networkPrefix: '{"schemaVersion":1,"city":"Taipei","version":"v9",' } }))
      .resolves.toMatchObject({ status: 'hard_failed', failureClass: 'network_version_mismatch' })
  })

  it('keeps hard health green while degrading on schedule-only arrivals', async () => {
    const result = await probe({
      responseOverrides: {
        arrivals: {
          warning: 'tdx-rate-limit',
          routes: [{ variantKey: 'TPE307:0', source: 'schedule' }],
          realtime: { candidates: 1, queries: 0, rateLimited: true },
        },
      },
    })
    expect(result).toMatchObject({ status: 'realtime_degraded', hardChecksPassed: PUBLIC_PROBE_HARD_CHECK_COUNT })
    expect(result.realtimeWarnings).toEqual(['realtime_schedule_only', 'realtime_upstream_degraded'])
    expect(result.failureClass).toBe('realtime_schedule_only')
  })

  it('reports stale replay and unknown journey estimates as yellow diagnostics', async () => {
    const result = await probe({
      responseOverrides: {
        arrivals: { routes: [{ variantKey: 'TPE307:0', source: 'stale-realtime' }] },
        journey: { estimates: [{ key: 'probe', minutes: null, source: 'none' }] },
      },
    })
    expect(result.status).toBe('realtime_degraded')
    expect(result.realtimeWarnings).toEqual(['journey_estimate_unknown', 'realtime_stale_replay'])
  })

  it('keeps a legal empty vehicles list green but flags vehicle feed trouble', async () => {
    await expect(probe()).resolves.toMatchObject({ realtimeWarnings: [] })
    const result = await probe({ responseOverrides: { vehicles: { warning: 'tdx-unavailable' } } })
    expect(result.realtimeWarnings).toEqual(['vehicles_upstream_degraded'])
  })

  it('never lets a realtime-plane crash reach hard health', async () => {
    const result = await probe({
      apiOverrides: { postJson: vi.fn(async () => { throw new Error('journey exploded') }) },
    })
    expect(result).toMatchObject({ status: 'realtime_degraded', hardChecksPassed: PUBLIC_PROBE_HARD_CHECK_COUNT })
    expect(result.realtimeWarnings).toContain('journey_estimate_unknown')
  })

  it('classifies its own rate limiter as incomplete evidence, not a red city', async () => {
    const rateLimited = Object.assign(new Error('429'), { status: 429 })
    const data = responses()
    const result = await probe({
      apiOverrides: {
        getJson: vi.fn(async (path) => {
          if (path.includes('/arrivals')) throw rateLimited
          if (path.startsWith('/api/v1/map/routes')) return data.routes
          if (path.startsWith('/api/v1/map/route?')) return data.route
          if (path.startsWith('/api/v1/map/stop-place?')) return data.stopPlace
          return data.vehicles
        }),
      },
    })
    expect(result).toMatchObject({ status: 'unknown', failureClass: 'probe_rate_limited' })
  })

  it('fails hard when the deterministic route, StopUID lookup or place sample is unavailable', async () => {
    await expect(probe({ responseOverrides: { route: { variants: [] } } }))
      .resolves.toMatchObject({ status: 'hard_failed', failureClass: 'route_sample_failed' })
    await expect(probe({ responseOverrides: { stopPlace: { place: null } } }))
      .resolves.toMatchObject({ status: 'hard_failed', failureClass: 'route_sample_failed' })
    await expect(probe({ responseOverrides: { arrivals: { scheduleSource: 'route-objects', snapshotVersion: null } } }))
      .resolves.toMatchObject({ status: 'hard_failed', failureClass: 'place_bundle_sample_failed' })
  })

  it('fails hard from the D1 reference when the catalogue has routes without patterns', async () => {
    await expect(probe({ referenceOverrides: { counts: { routeWithoutPattern: 2 } } }))
      .resolves.toMatchObject({ status: 'hard_failed', failureClass: 'route_without_pattern' })
    await expect(probe({ referenceOverrides: { activeVersion: null } }))
      .resolves.toMatchObject({ status: 'hard_failed', failureClass: 'active_pointer_missing' })
  })

  it('does not require high-cardinality counts in the D1 reference', async () => {
    await expect(probe({ referenceOverrides: { counts: { stops: undefined, patternStops: undefined } } }))
      .resolves.toMatchObject({ status: 'healthy', failureClass: 'none' })
  })
})
