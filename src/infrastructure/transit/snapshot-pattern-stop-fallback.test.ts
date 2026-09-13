import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetMemoryCacheForTests } from '../../lib/memory-cache'

const legacy = vi.hoisted(() => ({
  getActiveSnapshotVersion: vi.fn(),
  getJourneyLegStopRefs: vi.fn(),
}))

vi.mock('./snapshot-repository', async (importOriginal) => ({
  ...await importOriginal<typeof import('./snapshot-repository')>(),
  getActiveSnapshotVersion: legacy.getActiveSnapshotVersion,
  getJourneyLegStopRefs: legacy.getJourneyLegStopRefs,
}))

import {
  getJourneyLegStopRefs,
  type PatternStopFallbackObserver,
  type TransitBindings,
} from './snapshot-pattern-stop-repository'

const meta = {
  duration: 0,
  size_after: 0,
  rows_read: 0,
  rows_written: 0,
  last_row_id: 0,
  changed_db: false,
  changes: 0,
}

function result<T>(rows: T[]): D1Result<T> {
  return { success: true, meta, results: rows }
}

function artifact(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    city: 'Taichung',
    version: 'v1',
    patternId: 'P1',
    stops: [
      { stopUid: 'S1', placeId: 'A', stopSequence: 1, name: 'Alpha', latitude: 24.1, longitude: 120.6 },
      { stopUid: 'S2', placeId: 'B', stopSequence: 2, name: 'Beta', latitude: 24.2, longitude: 120.7 },
    ],
    ...overrides,
  }
}

function database() {
  const db = {
    prepare() {
      const statement = {
        bind: () => statement,
        all: async <T>() => result([{
          pattern_id: 'P1',
          route_uid: 'R1',
          subroute_uid: 'SUB1',
          direction: 0,
          route_name: '300',
        }] as T[]),
      } as D1PreparedStatement
      return statement
    },
  } as D1Database
  return db
}

function bucket({
  manifest = true,
  throwHead = false,
  missingArtifact = false,
  invalidArtifact = false,
  throwArtifact = false,
}: {
  manifest?: boolean
  throwHead?: boolean
  missingArtifact?: boolean
  invalidArtifact?: boolean
  throwArtifact?: boolean
} = {}) {
  const heads: string[] = []
  const r2 = {
    async head(key: string) {
      heads.push(key)
      if (throwHead) throw new Error('temporary R2 HEAD failure')
      return manifest ? {} as R2Object : null
    },
    async get(key: string) {
      if (!key.endsWith('/patterns/P1/stops.json')) return null
      if (throwArtifact) throw new Error('temporary R2 GET failure')
      if (missingArtifact) return null
      const value = invalidArtifact ? artifact({ patternId: 'WRONG' }) : artifact()
      return { json: async <T>() => value as T } as unknown as R2ObjectBody
    },
  } as unknown as R2Bucket
  return { r2, heads }
}

function env(r2: R2Bucket): TransitBindings {
  return { TRANSIT_DB: database(), TRANSIT_SHAPES: r2 }
}

function observer() {
  return vi.fn<PatternStopFallbackObserver>()
}

const legs = [{ key: 'leg', patternId: 'P1', sequence: 1 }]
const legacyFallback = [{
  key: 'legacy',
  patternId: 'P1',
  routeUid: 'R1',
  direction: 0 as const,
  routeName: '300',
  stopUid: 'S1',
}]

beforeEach(() => {
  resetMemoryCacheForTests()
  Object.values(legacy).forEach((mock) => mock.mockReset())
  legacy.getActiveSnapshotVersion.mockResolvedValue('v1')
  legacy.getJourneyLegStopRefs.mockResolvedValue(legacyFallback)
})

describe('pattern-stop fallback attribution', () => {
  it('reports cached missing manifests once per affected public lookup call', async () => {
    const observe = observer()
    const r2 = bucket({ manifest: false })
    const bindings = env(r2.r2)

    await getJourneyLegStopRefs(bindings, 'Taichung', legs, observe)
    await getJourneyLegStopRefs(bindings, 'Taichung', legs, observe)

    expect(r2.heads).toEqual(['snapshots/v1/cities/Taichung/pattern-stops-export.json'])
    expect(observe).toHaveBeenCalledTimes(2)
    expect(observe).toHaveBeenNthCalledWith(1, {
      city: 'Taichung', snapshotVersion: 'v1', reason: 'manifest_missing',
    })
    expect(observe).toHaveBeenNthCalledWith(2, {
      city: 'Taichung', snapshotVersion: 'v1', reason: 'manifest_missing',
    })
  })

  it('reports transient manifest HEAD failures as manifest_read_failed without caching them', async () => {
    const observe = observer()
    const r2 = bucket({ throwHead: true })
    const bindings = env(r2.r2)

    await getJourneyLegStopRefs(bindings, 'Taichung', legs, observe)
    await getJourneyLegStopRefs(bindings, 'Taichung', legs, observe)

    expect(r2.heads).toHaveLength(2)
    expect(observe).toHaveBeenCalledTimes(2)
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ reason: 'manifest_read_failed' }))
  })

  it('reports a missing manifest-approved pattern artifact as routing_authority_incomplete', async () => {
    const observe = observer()

    await getJourneyLegStopRefs(env(bucket({ missingArtifact: true }).r2), 'Taichung', legs, observe)

    expect(observe).toHaveBeenCalledTimes(1)
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ reason: 'routing_authority_incomplete' }))
    expect(legacy.getJourneyLegStopRefs).toHaveBeenCalledTimes(1)
  })

  it('reports a malformed pattern artifact as routing_authority_invalid', async () => {
    const observe = observer()

    await getJourneyLegStopRefs(env(bucket({ invalidArtifact: true }).r2), 'Taichung', legs, observe)

    expect(observe).toHaveBeenCalledTimes(1)
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ reason: 'routing_authority_invalid' }))
  })

  it('reports transient pattern artifact reads as r2', async () => {
    const observe = observer()

    await getJourneyLegStopRefs(env(bucket({ throwArtifact: true }).r2), 'Taichung', legs, observe)

    expect(observe).toHaveBeenCalledTimes(1)
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ reason: 'r2' }))
  })

  it('keeps the legacy D1 fallback available when the observer throws', async () => {
    const observe: PatternStopFallbackObserver = () => {
      throw new Error('telemetry sink unavailable')
    }

    await expect(getJourneyLegStopRefs(
      env(bucket({ missingArtifact: true }).r2),
      'Taichung',
      legs,
      observe,
    )).resolves.toBe(legacyFallback)
  })

  it('does not report a fallback when complete pattern-stop authority answers from R2', async () => {
    const observe = observer()

    const refs = await getJourneyLegStopRefs(env(bucket().r2), 'Taichung', legs, observe)

    expect(refs).toEqual([{
      key: 'leg',
      patternId: 'P1',
      routeUid: 'R1',
      subRouteUid: 'SUB1',
      direction: 0,
      routeName: '300',
      stopUid: 'S1',
    }])
    expect(legacy.getJourneyLegStopRefs).not.toHaveBeenCalled()
    expect(observe).not.toHaveBeenCalled()
  })
})
