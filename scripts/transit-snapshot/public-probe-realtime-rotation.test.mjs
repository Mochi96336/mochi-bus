import { describe, expect, it, vi } from 'vitest'
import { parseTelemetryEvent } from '../../src/observability/telemetry'
import {
  createPublicProbeEvent,
  PUBLIC_PROBE_HARD_CHECK_COUNT,
} from './public-probe-contract.mjs'
import { probePublicSurface } from './public-probe.mjs'
import {
  PUBLIC_PROBE_CITIES,
  PUBLIC_PROBE_REALTIME_SAMPLE_SIZE,
  publicProbeRealtimeCities,
} from './run-public-probe.mjs'

const probeDate = '2026-09-09'

function reference() {
  return {
    activeVersion: 'v1',
    counts: { routes: 1, patterns: 1, places: 1, routeWithoutPattern: 0, sampleCount: 1 },
    sample: { patternId: 'TPE307:0', routeUid: 'TPE307', routeName: '307' },
  }
}

function snapshotOnlyApi() {
  const getJson = vi.fn(async (path) => {
    if (path === '/api/v1/map/routes?city=Taipei') {
      return { schemaVersion: 2, source: 'snapshot', snapshotVersion: 'v1', routes: [{ routeName: '307' }] }
    }
    if (path === '/api/v1/map/route?city=Taipei&route=307') {
      return {
        schemaVersion: 1,
        source: 'snapshot',
        variants: [{
          variantKey: 'TPE307:0',
          routeUid: 'TPE307',
          stops: { features: [
            { properties: { stopUid: 'TPE1001', sequence: 1 } },
            { properties: { stopUid: 'TPE1002', sequence: 2 } },
          ] },
        }],
      }
    }
    if (path === '/api/v1/map/stop-place?city=Taipei&stopUid=TPE1001') {
      return {
        schemaVersion: 1,
        city: 'Taipei',
        stopUid: 'TPE1001',
        place: { placeId: 'place-1', name: '第一站', latitude: 25, longitude: 121.5 },
      }
    }
    if (path === '/api/v1/map/place/place-1/arrivals?city=Taipei&realtime=0') {
      return {
        schemaVersion: 1,
        scheduleSource: 'place-bundle',
        snapshotVersion: 'v1',
        routes: [{ variantKey: 'TPE307:0', source: 'schedule' }],
        realtime: { candidates: 0, queries: 0, rateLimited: false },
      }
    }
    throw new Error(`unexpected realtime request: ${path}`)
  })
  return {
    getJson,
    postJson: vi.fn(async () => { throw new Error('journey realtime must not run') }),
    readPrefix: vi.fn(async () => '{"schemaVersion":1,"city":"Taipei","version":"v1","routes":['),
  }
}

describe('public probe realtime rotation', () => {
  it('samples four cities per day and covers all enabled cities within six days', () => {
    const covered = new Set()
    for (let offset = 0; offset < 6; offset += 1) {
      const date = new Date(Date.UTC(2026, 8, 9 + offset)).toISOString().slice(0, 10)
      const sampled = publicProbeRealtimeCities(PUBLIC_PROBE_CITIES, date, PUBLIC_PROBE_REALTIME_SAMPLE_SIZE)
      expect(sampled.size).toBe(PUBLIC_PROBE_REALTIME_SAMPLE_SIZE)
      for (const city of sampled) covered.add(city)
    }
    expect(covered).toEqual(new Set(PUBLIC_PROBE_CITIES))
  })

  it('keeps full snapshot evidence without claiming unsampled realtime health', async () => {
    const api = snapshotOnlyApi()
    const realtimeDetailEmitter = vi.fn()
    const result = await probePublicSurface({
      city: 'Taipei',
      probeDate,
      reference: reference(),
      publicApi: api,
      realtimeSampled: false,
      realtimeDetailEmitter,
      now: () => new Date('2026-09-09T00:20:00.000Z'),
    })

    expect(result).toMatchObject({
      status: 'snapshot_healthy',
      failureClass: 'none',
      hardChecksPassed: PUBLIC_PROBE_HARD_CHECK_COUNT,
      realtimeWarnings: [],
    })
    expect(api.postJson).not.toHaveBeenCalled()
    expect(api.getJson.mock.calls.map(([path]) => path).some((path) => path.includes('/vehicles'))).toBe(false)
    expect(realtimeDetailEmitter).not.toHaveBeenCalled()

    const event = createPublicProbeEvent(result)
    expect(event).toMatchObject({
      event: 'public_probe_completed',
      result: 'degraded',
      source: 'snapshot',
      failureClass: 'none',
      qualityBucket: 'partial_unknown',
      diagnosticWarningCount: 0,
    })
    expect(parseTelemetryEvent(event)).toEqual(event)
  })
})
