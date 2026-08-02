import { describe, expect, it, vi } from 'vitest'
import {
  loadOperationalResources,
  resolveOperationalOrigin,
  resolveOperationalResources,
} from './operational-resources.mjs'

function runtime(canonicalOrigin = 'https://bus.example') {
  return { schemaVersion: 1, site: { canonicalOrigin } }
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
      workerName: 'chiayi-bus',
      d1DatabaseName: 'chiayi-transit',
      d1DatabaseId: '123e4567-e89b-42d3-a456-426614174000',
      r2BucketName: 'chiayi-transit-shapes',
      publicOrigin: 'https://bus.example',
    })
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

  it('keeps request-derived origins unavailable to unattended operations', () => {
    expect(resolveOperationalResources(runtime('request'), wrangler()).publicOrigin).toBeNull()
  })

  it('fails closed on ambiguous bindings and malformed resource identity', () => {
    expect(() => resolveOperationalResources(runtime(), wrangler({ d1_databases: [] })))
      .toThrow('exactly one TRANSIT_DB binding')
    expect(() => resolveOperationalResources(runtime(), wrangler({
      r2_buckets: [{ binding: 'TRANSIT_SHAPES', bucket_name: 'Invalid_Name' }],
    }))).toThrow('valid Cloudflare resource name')
    expect(() => resolveOperationalResources(runtime('http://bus.example'), wrangler()))
      .toThrow('fixed HTTPS origin')
  })
})
