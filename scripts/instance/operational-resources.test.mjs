import { describe, expect, it, vi } from 'vitest'
import {
  loadOperationalResources,
  resolveOperationalOrigin,
  resolveOperationalResources,
} from './operational-resources.mjs'

function runtime(canonicalOrigin = 'https://bus.example', transit = {}) {
  return {
    schemaVersion: 1,
    instanceId: 'chiayi-bus',
    site: { canonicalOrigin },
    transit: {
      enabledCities: ['Chiayi'],
      defaultCity: 'Chiayi',
      demoQuery: null,
      ...transit,
    },
  }
}

function wrangler(overrides = {}) {
  return {
    name: 'chiayi-bus',
    d1_databases: [{
      binding: 'TRANSIT_DB',
      database_name: 'chiayi-transit',
      database_id: '123e4567-e89b-42d3-a456-426614174000',
    }],
    r2_buckets: [{ binding: 'TRANSIT_SHAPES', bucket_name: 'chiayi-transit-shapes' }],
    ratelimits: [
      { name: 'API_STANDARD_RATE_LIMITER', namespace_id: '1001' },
      { name: 'API_EXPENSIVE_RATE_LIMITER', namespace_id: '1002' },
    ],
    ...overrides,
  }
}

function generatedFiles(path) {
  return path.endsWith('instance-runtime.json')
    ? JSON.stringify(runtime())
    : JSON.stringify(wrangler())
}

describe('instance operational resources', () => {
  it('loads generated runtime and Wrangler identity without secrets', () => {
    const readFile = vi.fn(generatedFiles)
    const resources = loadOperationalResources({ cwd: '/repo', env: {}, readFile })

    expect(readFile.mock.calls.map(([path]) => path)).toEqual([
      '/repo/.generated/instance/instance-runtime.json',
      '/repo/.generated/instance/wrangler.instance.jsonc',
    ])
    expect(resources).toEqual({
      instanceId: 'chiayi-bus',
      enabledCities: ['Chiayi'],
      defaultCity: 'Chiayi',
      demoQuery: null,
      workerName: 'chiayi-bus',
      d1DatabaseName: 'chiayi-transit',
      d1DatabaseId: '123e4567-e89b-42d3-a456-426614174000',
      r2BucketName: 'chiayi-transit-shapes',
      publicOrigin: 'https://bus.example',
      rateLimitNamespaceIds: { standard: '1001', expensive: '1002' },
    })
  })

  it('keeps only the release-smoke demo identity from the runtime query', () => {
    expect(resolveOperationalResources(runtime('https://bus.example', {
      enabledCities: ['Taipei', 'Chiayi'],
      defaultCity: 'Chiayi',
      demoQuery: {
        city: 'Taipei',
        routeName: '307',
        stopName: '捷運西門站',
        stopUid: 'TPE213044',
        routeUid: 'TPE19108',
        direction: 0,
      },
    }), wrangler()).demoQuery).toEqual({ city: 'Taipei', routeName: '307' })
  })

  it('accepts matching workflow outputs but rejects stale resource overrides', () => {
    expect(loadOperationalResources({
      cwd: '/repo',
      env: {
        TRANSIT_D1_DATABASE_NAME: 'chiayi-transit',
        TRANSIT_DATABASE_ID: '123E4567-E89B-42D3-A456-426614174000',
        TRANSIT_R2_BUCKET_NAME: 'chiayi-transit-shapes',
      },
      readFile: generatedFiles,
    }).d1DatabaseName).toBe('chiayi-transit')

    expect(() => loadOperationalResources({
      cwd: '/repo',
      env: { TRANSIT_DATABASE_ID: '223e4567-e89b-42d3-a456-426614174000' },
      readFile: generatedFiles,
    })).toThrow('TRANSIT_DATABASE_ID must match generated operational identity')
  })

  it('keeps fixed origins authoritative and permits explicit request-derived origins', () => {
    const fixed = resolveOperationalResources(runtime(), wrangler())
    expect(resolveOperationalOrigin(fixed, 'https://bus.example/', 'RELEASE_SMOKE_ORIGIN'))
      .toBe('https://bus.example')
    expect(() => resolveOperationalOrigin(fixed, 'https://other.example', 'RELEASE_SMOKE_ORIGIN'))
      .toThrow('must match generated public origin')

    const requestDerived = resolveOperationalResources(runtime('request'), wrangler())
    expect(resolveOperationalOrigin(
      requestDerived,
      'http://localhost:8787',
      'SNAPSHOT_SMOKE_BASE_URL',
      { allowHttp: true },
    )).toBe('http://localhost:8787')
    expect(() => resolveOperationalOrigin(requestDerived, undefined, 'RELEASE_SMOKE_ORIGIN'))
      .toThrow('RELEASE_SMOKE_ORIGIN is required')
  })

  it('keeps request-derived origins and omitted rate-limit bindings explicit', () => {
    const resources = resolveOperationalResources(runtime('request'), wrangler({ ratelimits: undefined }))
    expect(resources.publicOrigin).toBeNull()
    expect(resources.rateLimitNamespaceIds).toEqual({ standard: null, expensive: null })
  })

  it('preserves generated integer namespace identity for operation-specific validation', () => {
    expect(resolveOperationalResources(runtime(), wrangler({
      ratelimits: [{ name: 'API_STANDARD_RATE_LIMITER', namespace_id: '0' }],
    })).rateLimitNamespaceIds).toEqual({ standard: '0', expensive: null })
  })

  it('fails closed on ambiguous bindings and malformed resource identity', () => {
    expect(() => resolveOperationalResources(runtime(), wrangler({ d1_databases: [] })))
      .toThrow('exactly one TRANSIT_DB binding')
    expect(() => resolveOperationalResources(runtime(), wrangler({
      r2_buckets: [{ binding: 'TRANSIT_SHAPES', bucket_name: 'Invalid_Name' }],
    }))).toThrow('valid Cloudflare resource name')
    expect(() => resolveOperationalResources(runtime(), wrangler({
      ratelimits: [{ name: 'API_STANDARD_RATE_LIMITER', namespace_id: 'not-an-id' }],
    }))).toThrow('integer string')
    expect(() => resolveOperationalResources(runtime(), wrangler({
      ratelimits: [
        { name: 'API_STANDARD_RATE_LIMITER', namespace_id: '1001' },
        { name: 'API_STANDARD_RATE_LIMITER', namespace_id: '1002' },
      ],
    }))).toThrow('must not contain duplicate API_STANDARD_RATE_LIMITER')
    expect(() => resolveOperationalResources(runtime('http://bus.example'), wrangler()))
      .toThrow('fixed HTTPS origin')
    expect(() => resolveOperationalResources(runtime('https://bus.example', {
      enabledCities: ['Chiayi'],
      defaultCity: 'Taipei',
    }), wrangler())).toThrow('defaultCity must be enabled')
    expect(() => resolveOperationalResources(runtime('https://bus.example', {
      enabledCities: ['Chiayi'],
      demoQuery: { city: 'Taipei', routeName: '307' },
    }), wrangler())).toThrow('demoQuery.city must be enabled')
    expect(() => resolveOperationalResources(runtime('https://bus.example', {
      demoQuery: { city: 'Chiayi', routeName: 'x'.repeat(41) },
    }), wrangler())).toThrow('up to 40 characters')
  })
})
