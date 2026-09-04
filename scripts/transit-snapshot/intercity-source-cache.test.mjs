import { describe, expect, it, vi } from 'vitest'
import {
  createIntercityCachedFetch,
  freshIntercityManifest,
  INTERCITY_RESOURCES,
} from './intercity-source-cache.mjs'

const encoder = new TextEncoder()
const NOW = new Date('2026-09-04T09:00:00.000Z')
const TDX_BASE = 'https://tdx.transportdata.tw/api/basic/v2/Bus'

function bytes(value) {
  return encoder.encode(JSON.stringify(value))
}

function resourceEntries(version, values = {}) {
  return Object.fromEntries(INTERCITY_RESOURCES.map((resource) => {
    const body = values[resource] ?? bytes([{ resource, version }])
    return [resource, {
      key: `source-cache/tdx/intercity/v1/${version}/${resource}.json`,
      bytes: body.byteLength,
    }]
  }))
}

function manifest(version, { generatedAt, expiresAt, values } = {}) {
  return {
    schemaVersion: 1,
    source: 'TDX Bus/InterCity',
    version,
    generatedAt: generatedAt ?? '2026-09-04T08:00:00.000Z',
    expiresAt: expiresAt ?? '2026-09-11T08:00:00.000Z',
    resources: resourceEntries(version, values),
  }
}

function fakeStore(initialManifest = null, initialBodies = new Map()) {
  const state = {
    manifest: initialManifest,
    bodies: new Map(initialBodies),
    events: [],
  }
  return {
    state,
    adapter: {
      async readManifest() {
        state.events.push({ type: 'read-manifest' })
        return state.manifest
      },
      async readResource(entry) {
        state.events.push({ type: 'read-resource', key: entry.key })
        return state.bodies.get(entry.key) ?? null
      },
      async writeResource(entry, body) {
        state.events.push({ type: 'write-resource', key: entry.key })
        state.bodies.set(entry.key, body.slice())
      },
      async writeManifest(next) {
        state.events.push({ type: 'write-manifest', version: next.version })
        state.manifest = next
      },
      async deleteResources(entries) {
        state.events.push({ type: 'delete-resources', keys: entries.map((entry) => entry.key) })
        for (const entry of entries) state.bodies.delete(entry.key)
      },
    },
  }
}

function upstreamFixture() {
  return vi.fn(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const resource = url.pathname.split('/').at(-2)
    return new Response(JSON.stringify([{ resource, source: 'upstream' }]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  })
}

describe('InterCity source cache', () => {
  it('accepts only complete, unexpired manifests', () => {
    expect(freshIntercityManifest(manifest('fresh'), NOW)).toBe(true)
    expect(freshIntercityManifest(manifest('expired', {
      expiresAt: '2026-09-04T09:00:00.000Z',
    }), NOW)).toBe(false)
    const incomplete = manifest('incomplete')
    delete incomplete.resources.Shape
    expect(freshIntercityManifest(incomplete, NOW)).toBe(false)
  })

  it('serves a fresh cached resource without calling TDX', async () => {
    const stopBody = bytes([{ resource: 'Stop', source: 'cache' }])
    const current = manifest('cached', { values: { Stop: stopBody } })
    const store = fakeStore(current, new Map([[current.resources.Stop.key, stopBody]]))
    const upstreamFetch = upstreamFixture()
    const cachedFetch = createIntercityCachedFetch({
      upstreamFetch,
      store: store.adapter,
      now: () => NOW,
    })

    const response = await cachedFetch(`${TDX_BASE}/Stop/InterCity?$format=JSON`, {
      headers: { Authorization: 'Bearer test' },
    })

    expect(await response.json()).toEqual([{ resource: 'Stop', source: 'cache' }])
    expect(upstreamFetch).not.toHaveBeenCalled()
    expect(store.state.events.filter((event) => event.type === 'read-manifest')).toHaveLength(1)
    expect(store.state.events.filter((event) => event.type === 'read-resource')).toHaveLength(1)
  })

  it('refreshes all five static resources once and publishes the manifest last', async () => {
    const old = manifest('old', {
      generatedAt: '2026-08-20T00:00:00.000Z',
      expiresAt: '2026-08-27T00:00:00.000Z',
    })
    const oldBodies = new Map(Object.values(old.resources).map((entry) => [entry.key, bytes([])]))
    const store = fakeStore(old, oldBodies)
    const upstreamFetch = upstreamFixture()
    const cachedFetch = createIntercityCachedFetch({
      upstreamFetch,
      store: store.adapter,
      now: () => NOW,
    })

    const stop = await cachedFetch(`${TDX_BASE}/Stop/InterCity?$format=JSON`, {
      headers: { Authorization: 'Bearer test' },
    })
    expect(await stop.json()).toEqual([{ resource: 'Stop', source: 'upstream' }])
    expect(upstreamFetch).toHaveBeenCalledTimes(INTERCITY_RESOURCES.length)

    const shape = await cachedFetch(`${TDX_BASE}/Shape/InterCity?$format=JSON`, {
      headers: { Authorization: 'Bearer test' },
    })
    expect(await shape.json()).toEqual([{ resource: 'Shape', source: 'upstream' }])
    expect(upstreamFetch).toHaveBeenCalledTimes(INTERCITY_RESOURCES.length)

    const writes = store.state.events.map((event) => event.type)
    const manifestIndex = writes.indexOf('write-manifest')
    expect(manifestIndex).toBeGreaterThan(-1)
    expect(writes.slice(0, manifestIndex).filter((type) => type === 'write-resource')).toHaveLength(INTERCITY_RESOURCES.length)
    expect(writes.indexOf('delete-resources')).toBeGreaterThan(manifestIndex)
    expect(freshIntercityManifest(store.state.manifest, NOW)).toBe(true)
  })

  it('refreshes a fresh cache when the operator forces publication', async () => {
    const current = manifest('cached')
    const store = fakeStore(current)
    const upstreamFetch = upstreamFixture()
    const cachedFetch = createIntercityCachedFetch({
      upstreamFetch,
      store: store.adapter,
      now: () => NOW,
      forceRefresh: true,
    })

    const response = await cachedFetch(`${TDX_BASE}/Route/InterCity?$format=JSON`, {
      headers: { Authorization: 'Bearer test' },
    })

    expect(await response.json()).toEqual([{ resource: 'Route', source: 'upstream' }])
    expect(upstreamFetch).toHaveBeenCalledTimes(INTERCITY_RESOURCES.length)
  })

  it('keeps snapshot publication usable when cache persistence fails', async () => {
    const store = fakeStore(null)
    store.adapter.writeResource = async () => { throw new Error('R2 unavailable') }
    const upstreamFetch = upstreamFixture()
    const cachedFetch = createIntercityCachedFetch({
      upstreamFetch,
      store: store.adapter,
      now: () => NOW,
    })

    const route = await cachedFetch(`${TDX_BASE}/Route/InterCity?$format=JSON`, {
      headers: { Authorization: 'Bearer test' },
    })
    expect(await route.json()).toEqual([{ resource: 'Route', source: 'upstream' }])

    const schedule = await cachedFetch(`${TDX_BASE}/Schedule/InterCity?$format=JSON`, {
      headers: { Authorization: 'Bearer test' },
    })
    expect(await schedule.json()).toEqual([{ resource: 'Schedule', source: 'upstream' }])
    expect(upstreamFetch).toHaveBeenCalledTimes(INTERCITY_RESOURCES.length)
    expect(store.state.events.some((event) => event.type === 'write-manifest')).toBe(false)
  })

  it('does not cache realtime or city-scoped TDX requests', async () => {
    const store = fakeStore(null)
    const upstreamFetch = vi.fn(async () => new Response('[]', { status: 200 }))
    const cachedFetch = createIntercityCachedFetch({
      upstreamFetch,
      store: store.adapter,
      now: () => NOW,
    })

    await cachedFetch(`${TDX_BASE}/EstimatedTimeOfArrival/InterCity?$format=JSON`)
    await cachedFetch(`${TDX_BASE}/Shape/City/Taipei?$format=JSON`)

    expect(upstreamFetch).toHaveBeenCalledTimes(2)
    expect(store.state.events).toEqual([])
  })
})
