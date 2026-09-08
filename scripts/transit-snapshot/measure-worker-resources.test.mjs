import { describe, expect, it, vi } from 'vitest'
import {
  buildMeasurementWranglerConfig,
  measurementWorkerName,
  parseWorkerAnalytics,
  selectDirectMeasurementSample,
  selectTransferMeasurementSample,
} from './measure-worker-resources.mjs'

function place(id, bytes, patternDefs) {
  const patterns = new Map()
  const occurrences = new Map()
  for (const [patternId, sequences, circular = false] of patternDefs) {
    patterns.set(patternId, {
      patternId,
      circular,
      minSequence: Math.min(...sequences),
      maxSequence: Math.max(...sequences),
    })
    occurrences.set(patternId, [...sequences])
  }
  return {
    entry: {
      placeId: id,
      key: `places/${id}.json`,
      patterns: patternDefs.length,
      occurrences: patternDefs.reduce((sum, [, sequences]) => sum + sequences.length, 0),
      bytes,
      sha256: 'a'.repeat(64),
    },
    place: { placeId: id, name: `Place ${id}` },
    patterns,
    occurrences,
  }
}

describe('snapshot Worker resource measurement', () => {
  it('selects the globally largest reachable direct endpoint pair with a bounded read', async () => {
    const places = new Map([
      ['A', place('A', 100, [['p1', [1]]])],
      ['B', place('B', 90, [['p1', [5]]])],
      ['C', place('C', 80, [['p2', [1]]])],
    ])
    const reads = []
    const result = await selectDirectMeasurementSample({
      entries: [...places.values()].map((item) => item.entry),
      readPlace: vi.fn(async (entry) => {
        reads.push(entry.placeId)
        return places.get(entry.placeId)
      }),
    })

    expect(result).toMatchObject({
      fromPlaceId: 'A',
      toPlaceId: 'B',
      patternId: 'p1',
      endpointBytes: 190,
      candidatePlacesRead: 2,
    })
    expect(reads).toEqual(['A', 'B'])
  })

  it('selects a maximum transfer-shard fanout pair and stops once all shards are covered', async () => {
    const places = new Map([
      ['A', place('A', 100, [['p0', [1]], ['p1', [1]]])],
      ['B', place('B', 90, [['p2', [1]], ['p3', [1]]])],
      ['C', place('C', 80, [['p0', [2]]])],
    ])
    const patternShards = new Map([
      ['p0', 0],
      ['p1', 1],
      ['p2', 2],
      ['p3', 3],
    ])
    const reads = []
    const result = await selectTransferMeasurementSample({
      entries: [...places.values()].map((item) => item.entry),
      patternShards,
      shardCount: 4,
      readPlace: vi.fn(async (entry) => {
        reads.push(entry.placeId)
        return places.get(entry.placeId)
      }),
    })

    expect(result).toMatchObject({
      fromPlaceId: 'A',
      toPlaceId: 'B',
      shardFanout: 4,
      candidatePlacesRead: 2,
      endpointBytes: 190,
    })
    expect(result.shardIds).toEqual([0, 1, 2, 3])
    expect(reads).toEqual(['A', 'B'])
  })

  it('uses a conservative unseen-place bound before stopping below total shard coverage', async () => {
    const places = new Map([
      ['A', place('A', 100, [['p0', [1]], ['p1', [1]], ['p2', [1]]])],
      ['B', place('B', 90, [['p3', [1]], ['p4', [1]], ['p5', [1]]])],
      ['C', place('C', 80, [['p6', [1]]])],
      ['D', place('D', 70, [['p7', [1]]])],
    ])
    const patternShards = new Map([...Array(8)].map((_, index) => [`p${index}`, index]))
    const reads = []
    const result = await selectTransferMeasurementSample({
      entries: [...places.values()].map((item) => item.entry),
      patternShards,
      shardCount: 8,
      readPlace: vi.fn(async (entry) => {
        reads.push(entry.placeId)
        return places.get(entry.placeId)
      }),
    })

    expect(result.shardFanout).toBe(6)
    expect(result.candidatePlacesRead).toBe(2)
    expect(reads).toEqual(['A', 'B'])
  })

  it('forces temporary workers.dev isolation and strips production routes and triggers', () => {
    const base = {
      name: 'mochi-tools',
      main: '../../src/index.ts',
      workers_dev: false,
      routes: [{ pattern: 'bus.example/*', zone_name: 'example' }],
      triggers: { crons: ['0 0 * * *'] },
      tail_consumers: [{ service: 'tail' }],
      d1_databases: [{ binding: 'TRANSIT_DB', database_id: 'db' }],
      r2_buckets: [{ binding: 'TRANSIT_SHAPES', bucket_name: 'bucket' }],
      observability: { enabled: false, logs: { invocation_logs: false } },
    }
    const config = buildMeasurementWranglerConfig(base, 'mochi-res-123-1-taipei-direct')

    expect(config.name).toBe('mochi-res-123-1-taipei-direct')
    expect(config.workers_dev).toBe(true)
    expect(config.preview_urls).toBe(false)
    expect(config.observability.enabled).toBe(true)
    expect(config.d1_databases).toEqual(base.d1_databases)
    expect(config.r2_buckets).toEqual(base.r2_buckets)
    expect(config).not.toHaveProperty('routes')
    expect(config).not.toHaveProperty('triggers')
    expect(config).not.toHaveProperty('tail_consumers')
    expect(base.routes).toHaveLength(1)
  })

  it('requires complete successful GraphQL memory and subrequest evidence', () => {
    const scriptName = 'mochi-res-123-1-taipei-direct'
    const result = parseWorkerAnalytics({
      data: {
        viewer: {
          accounts: [{
            workersInvocationsAdaptive: [{
              dimensions: { scriptName, status: 'success' },
              quantiles: {
                memoryUsageBytesP50: 10_000_000,
                memoryUsageBytesP90: 12_000_000,
                memoryUsageBytesP99: 13_000_000,
                memoryUsageBytesP999: 14_000_000,
              },
              sum: { requests: 3, subrequests: 15, errors: 0 },
            }],
          }],
        },
      },
    }, { scriptName, expectedRequests: 3 })

    expect(result).toEqual({
      requests: 3,
      subrequests: 15,
      subrequestsPerRequest: 5,
      errors: 0,
      memoryUsageBytes: {
        p50: 10_000_000,
        p90: 12_000_000,
        p99: 13_000_000,
        p999: 14_000_000,
      },
    })
  })

  it('fails closed when GraphQL has not ingested all measured requests', () => {
    const scriptName = 'mochi-res-123-1-taipei-direct'
    expect(() => parseWorkerAnalytics({
      data: {
        viewer: {
          accounts: [{
            workersInvocationsAdaptive: [{
              dimensions: { scriptName, status: 'success' },
              quantiles: {
                memoryUsageBytesP50: 1,
                memoryUsageBytesP90: 1,
                memoryUsageBytesP99: 1,
                memoryUsageBytesP999: 1,
              },
              sum: { requests: 2, subrequests: 4, errors: 0 },
            }],
          }],
        },
      },
    }, { scriptName, expectedRequests: 3 })).toThrow('expected at least 3')
  })

  it('builds bounded unique Worker names from the workflow identity', () => {
    const name = measurementWorkerName({
      runId: '34217978418',
      runAttempt: '12',
      city: 'NewTaipei',
      kind: 'transfer',
    })
    expect(name).toBe('mochi-res-34217978418-12-newtaipei-transfer')
    expect(name.length).toBeLessThanOrEqual(63)
  })
})
