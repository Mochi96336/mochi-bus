import { describe, expect, it } from 'vitest'
import { MAX_MANIFEST_READ_LIMIT } from './manifest-read-limit.mjs'
import {
  assertPublisherManifestBudget,
  publisherManifestBudget,
} from './publisher-manifest-budget.mjs'

function fixture() {
  const city = 'Chiayi'
  const version = '20260905T120000000Z'
  return {
    city,
    version,
    routes: new Map([['R1', { uid: 'R1' }]]),
    patterns: [{
      id: 'P1',
      shapeKey: `snapshots/${version}/cities/${city}/shapes/P1.json`,
    }],
    places: new Map([['L1', { id: 'L1' }]]),
    counts: { routes: 1, patterns: 1, stops: 2, places: 1, patternStops: 2 },
    quality: { networkBytes: 1024, networkCoordinates: 2 },
  }
}

describe('publisher manifest preflight', () => {
  it('counts every legacy and routing artifact class before remote staging', () => {
    const budget = assertPublisherManifestBudget(fixture())
    expect(budget.artifacts).toBe(42)
    expect(budget.bytes).toBeGreaterThan(0)
    expect(budget.bytes).toBeLessThan(MAX_MANIFEST_READ_LIMIT)
  })

  it('fails locally when the conservative manifest bound cannot fit the validator ceiling', () => {
    const input = fixture()
    const suffix = 'x'.repeat(512)
    input.routes = new Map()
    input.patterns = []
    input.places = new Map()
    for (let index = 0; index < 12_000; index += 1) {
      const routeUid = `R${index}-${suffix}`
      const patternId = `P${index}-${suffix}`
      const placeId = `L${index}-${suffix}`
      input.routes.set(routeUid, { uid: routeUid })
      input.patterns.push({
        id: patternId,
        shapeKey: `snapshots/${input.version}/cities/${input.city}/shapes/${patternId}.json`,
      })
      input.places.set(placeId, { id: placeId })
    }

    const budget = publisherManifestBudget(input)
    expect(budget.bytes).toBeGreaterThan(MAX_MANIFEST_READ_LIMIT)
    expect(() => assertPublisherManifestBudget(input)).toThrow(/manifest preflight exceeds/)
  })
})
