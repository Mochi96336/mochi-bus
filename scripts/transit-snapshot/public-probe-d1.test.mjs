import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createD1PublicProbeStore, publicProbeRunId } from './public-probe-d1.mjs'
import {
  PUBLIC_PROBE_HARD_CHECK_COUNT,
  validatePublicProbeResult,
} from './public-probe-contract.mjs'

const migration = readFileSync(new URL('../../migrations/0006_public_probe.sql', import.meta.url), 'utf8')

// Intentionally omit stops / pattern_stops. If the public reference store ever
// regresses to either high-cardinality table, these tests fail at SQL prepare.
const REFERENCE_TABLES = `
CREATE TABLE dataset_versions (city_code TEXT PRIMARY KEY, active_version TEXT);
CREATE TABLE routes (version TEXT, city_code TEXT, route_uid TEXT, route_name TEXT);
CREATE TABLE patterns (version TEXT, city_code TEXT, pattern_id TEXT, route_uid TEXT);
CREATE TABLE stop_places (version TEXT, city_code TEXT, place_id TEXT);
`

function cityResult(overrides = {}) {
  return validatePublicProbeResult({
    city: 'Taipei',
    probeDate: '2026-07-19',
    evaluatedAt: '2026-07-19T00:20:00.000Z',
    status: 'healthy',
    activeVersion: 'v1',
    observedVersion: 'v1',
    failureClass: 'none',
    hardChecksPassed: PUBLIC_PROBE_HARD_CHECK_COUNT,
    realtimeWarnings: [],
    probeCaseVersion: 1,
    sampleCaseId: 'pub_0123456789ab',
    latencyBucket: '1_3s',
    ...overrides,
  })
}

describe('public probe D1 store', () => {
  let db
  let store

  beforeEach(() => {
    db = new DatabaseSync(':memory:')
    db.exec(migration)
    db.exec(migration)
    db.exec(REFERENCE_TABLES)
    const fetchImpl = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body)
      const queries = Array.isArray(body.batch) ? body.batch : [body]
      const result = []
      db.exec('BEGIN')
      try {
        for (const { sql, params } of queries) {
          const statement = db.prepare(sql)
          const results = /^\s*SELECT/i.test(sql) ? statement.all(...params) : (statement.run(...params), [])
          result.push({ success: true, results })
        }
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      return Response.json({ success: true, result })
    })
    store = createD1PublicProbeStore({
      accountId: 'account', apiToken: 'private-token', databaseId: 'database', fetchImpl,
    })
  })

  afterEach(() => db.close())

  it('reads the active pointer, low-card counts and deterministic pattern sample read-only', async () => {
    db.prepare("INSERT INTO dataset_versions VALUES ('Taipei', 'v1')").run()
    db.prepare("INSERT INTO routes VALUES ('v1', 'Taipei', 'TPE307', '307')").run()
    db.prepare("INSERT INTO patterns VALUES ('v1', 'Taipei', 'TPE307:0', 'TPE307')").run()
    db.prepare("INSERT INTO stop_places VALUES ('v1', 'Taipei', 'place-1')").run()

    await expect(store.readReference('Taipei')).resolves.toMatchObject({
      activeVersion: 'v1',
      counts: { routes: 1, patterns: 1, places: 1, routeWithoutPattern: 0, sampleCount: 1 },
    })
    await expect(store.readSample('Taipei', 'v1', 0)).resolves.toEqual({
      patternId: 'TPE307:0', routeUid: 'TPE307', routeName: '307',
    })
  })

  it('counts only patterns that can resolve a low-card route sample', async () => {
    db.prepare("INSERT INTO dataset_versions VALUES ('Taipei', 'v1')").run()
    db.prepare("INSERT INTO routes VALUES ('v1', 'Taipei', 'TPE307', '307')").run()
    db.prepare("INSERT INTO patterns VALUES ('v1', 'Taipei', 'TPE307:0', 'TPE307')").run()
    db.prepare("INSERT INTO patterns VALUES ('v1', 'Taipei', 'orphan:0', 'missing-route')").run()
    db.prepare("INSERT INTO stop_places VALUES ('v1', 'Taipei', 'place-1')").run()

    await expect(store.readReference('Taipei')).resolves.toMatchObject({
      counts: { routes: 1, patterns: 2, places: 1, routeWithoutPattern: 0, sampleCount: 1 },
    })
    await expect(store.readSample('Taipei', 'v1', 0)).resolves.toEqual({
      patternId: 'TPE307:0', routeUid: 'TPE307', routeName: '307',
    })
  })

  it('reports a missing active pointer without inventing counts', async () => {
    await expect(store.readReference('Taipei')).resolves.toEqual({ activeVersion: null, counts: null })
  })

  it('keeps run and city writes idempotent and canonical per probe date', async () => {
    const newer = cityResult({ evaluatedAt: '2026-07-19T00:25:00.000Z' })
    const older = cityResult({
      evaluatedAt: '2026-07-19T00:20:00.000Z',
      status: 'hard_failed', failureClass: 'public_version_mismatch', hardChecksPassed: 5,
    })
    await store.startRun({ probeRunId: 'gh:300:1', evaluatedAt: newer.evaluatedAt, probeDate: '2026-07-19' })
    await store.completeCity('gh:300:1', newer)
    await store.completeCity('gh:300:1', newer)
    await store.startRun({ probeRunId: 'gh:299:1', evaluatedAt: older.evaluatedAt, probeDate: '2026-07-19' })
    await store.completeCity('gh:299:1', older)
    await store.completeRun({
      probeRunId: 'gh:300:1', evaluatedAt: newer.evaluatedAt,
      completedAt: '2026-07-19T00:26:00.000Z', result: 'success', failureCount: 0,
    })

    expect(db.prepare('SELECT COUNT(*) AS count FROM public_probe_city_attempts').get().count).toBe(2)
    expect(db.prepare('SELECT probe_run_id, status FROM public_probe_city_results').get())
      .toEqual({ probe_run_id: 'gh:300:1', status: 'healthy' })
    expect(db.prepare('SELECT result FROM public_probe_runs WHERE probe_run_id = ?').get('gh:300:1'))
      .toEqual({ result: 'success' })
  })

  it('persists realtime warnings as data without widening the schema', async () => {
    const degraded = cityResult({
      status: 'realtime_degraded',
      failureClass: 'journey_estimate_unknown',
      realtimeWarnings: ['realtime_schedule_only', 'journey_estimate_unknown'],
    })
    await store.startRun({ probeRunId: 'gh:301:1', evaluatedAt: degraded.evaluatedAt, probeDate: '2026-07-19' })
    await store.completeCity('gh:301:1', degraded)
    expect(db.prepare('SELECT status, warning_count, warnings FROM public_probe_city_results').get()).toEqual({
      status: 'realtime_degraded',
      warning_count: 2,
      warnings: 'journey_estimate_unknown,realtime_schedule_only',
    })
  })

  it('exposes no way to modify snapshot state', () => {
    expect(Object.keys(store).sort()).toEqual([
      'completeCity', 'completeRun', 'readReference', 'readSample', 'startRun',
    ])
  })

  it('uses stable GitHub identity and separates local runs', () => {
    expect(publicProbeRunId({ workflowRunId: '300', workflowRunAttempt: 2, evaluatedAt: '2026-07-19T00:20:00.000Z' }))
      .toBe('gh:300:2')
    expect(publicProbeRunId({ workflowRunId: null, evaluatedAt: '2026-07-19T00:20:00.000Z' }))
      .toMatch(/^local:[a-f0-9]{16}$/)
  })
})
