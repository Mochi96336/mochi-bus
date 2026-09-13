import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  collectHighCardSchemaInventory,
  normalizeSchemaRows,
  referencedTargets,
} from './high-card-retirement-schema-inventory.mjs'

const source = readFileSync('scripts/transit-snapshot/high-card-retirement-schema-inventory.mjs', 'utf8')
const workflow = readFileSync('.github/workflows/snapshot-high-card-retirement-readiness.yml', 'utf8')

function expectedLegacyRows() {
  return [
    { type: 'table', name: 'stops', tbl_name: 'stops', sql: 'CREATE TABLE stops (version TEXT, stop_uid TEXT, PRIMARY KEY (version, stop_uid))' },
    { type: 'index', name: 'sqlite_autoindex_stops_1', tbl_name: 'stops', sql: null },
    { type: 'index', name: 'stops_place_idx', tbl_name: 'stops', sql: 'CREATE INDEX stops_place_idx ON stops(version, place_id)' },
    { type: 'index', name: 'stops_name_idx', tbl_name: 'stops', sql: 'CREATE INDEX stops_name_idx ON stops(version, city_code, normalized_name)' },
    { type: 'table', name: 'pattern_stops', tbl_name: 'pattern_stops', sql: 'CREATE TABLE pattern_stops (version TEXT, pattern_id TEXT, stop_sequence INTEGER, PRIMARY KEY (version, pattern_id, stop_sequence))' },
    { type: 'index', name: 'sqlite_autoindex_pattern_stops_1', tbl_name: 'pattern_stops', sql: null },
    { type: 'index', name: 'pattern_stops_place_idx', tbl_name: 'pattern_stops', sql: 'CREATE INDEX pattern_stops_place_idx ON pattern_stops(version, place_id, pattern_id)' },
  ]
}

async function reportFor(rows) {
  return collectHighCardSchemaInventory({
    env: { GITHUB_SHA: 'abc123', GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1' },
    now: () => new Date('2026-09-13T00:00:00.000Z'),
    readSchema: async () => rows,
  })
}

describe('legacy high-card D1 schema inventory', () => {
  it('recognizes the expected legacy tables, explicit indexes, and SQLite primary-key autoindexes', async () => {
    const report = await reportFor(expectedLegacyRows())

    expect(report).toMatchObject({
      schemaVersion: 1,
      kind: 'snapshot-high-card-d1-schema-inventory',
      sourceCommit: 'abc123',
      schemaState: 'legacy-present',
      tablesPresent: ['pattern_stops', 'stops'],
      missingExpectedObjects: [],
      unexpectedOwnedObjects: [],
      externalDependencies: [],
      schemaMatchesExpectedLegacyShape: true,
      dependencyClear: true,
    })
    expect(report.ownedObjects.map(({ type, name, table }) => ({ type, name, table }))).toEqual([
      { type: 'table', name: 'stops', table: 'stops' },
      { type: 'index', name: 'sqlite_autoindex_stops_1', table: 'stops' },
      { type: 'index', name: 'stops_place_idx', table: 'stops' },
      { type: 'index', name: 'stops_name_idx', table: 'stops' },
      { type: 'table', name: 'pattern_stops', table: 'pattern_stops' },
      { type: 'index', name: 'sqlite_autoindex_pattern_stops_1', table: 'pattern_stops' },
      { type: 'index', name: 'pattern_stops_place_idx', table: 'pattern_stops' },
    ])
  })

  it('distinguishes fully retired and partial high-card schema states', async () => {
    const retired = await reportFor([])
    expect(retired).toMatchObject({
      schemaState: 'retired',
      tablesPresent: [],
      schemaMatchesExpectedLegacyShape: false,
      dependencyClear: true,
    })

    const partial = await reportFor([
      { type: 'table', name: 'stops', tbl_name: 'stops', sql: 'CREATE TABLE stops (version TEXT)' },
    ])
    expect(partial).toMatchObject({
      schemaState: 'partial',
      tablesPresent: ['stops'],
      schemaMatchesExpectedLegacyShape: false,
      dependencyClear: false,
    })
  })

  it('reports missing expected indexes and unexpected target-owned objects without exposing SQL', async () => {
    const rows = expectedLegacyRows().filter((row) => row.name !== 'stops_name_idx')
    rows.push({
      type: 'trigger',
      name: 'stops_shadow_trigger',
      tbl_name: 'stops',
      sql: 'CREATE TRIGGER stops_shadow_trigger AFTER INSERT ON stops BEGIN SELECT 1; END',
    })
    const report = await reportFor(rows)

    expect(report.missingExpectedObjects).toEqual(['stops_name_idx'])
    expect(report.unexpectedOwnedObjects).toEqual([
      { type: 'trigger', name: 'stops_shadow_trigger', table: 'stops' },
    ])
    expect(report.schemaMatchesExpectedLegacyShape).toBe(false)
    expect(JSON.stringify(report)).not.toContain('CREATE TRIGGER')
    expect(JSON.stringify(report)).not.toContain('AFTER INSERT')
  })

  it('records exact external view/trigger dependencies but filters LIKE false positives', async () => {
    const report = await reportFor([
      ...expectedLegacyRows(),
      {
        type: 'view',
        name: 'legacy_stop_view',
        tbl_name: 'legacy_stop_view',
        sql: 'CREATE VIEW legacy_stop_view AS SELECT stop_uid FROM stops',
      },
      {
        type: 'trigger',
        name: 'route_audit_trigger',
        tbl_name: 'routes',
        sql: 'CREATE TRIGGER route_audit_trigger AFTER UPDATE ON routes BEGIN SELECT COUNT(*) FROM pattern_stops; END',
      },
      {
        type: 'view',
        name: 'archive_view',
        tbl_name: 'archive_view',
        sql: 'CREATE VIEW archive_view AS SELECT * FROM bus_stops_archive JOIN pattern_stops_backup USING (id)',
      },
    ])

    expect(report.externalDependencies).toEqual([
      { type: 'view', name: 'legacy_stop_view', table: 'legacy_stop_view', references: ['stops'] },
      { type: 'trigger', name: 'route_audit_trigger', table: 'routes', references: ['pattern_stops'] },
    ])
    expect(report.dependencyClear).toBe(false)
    expect(report.schemaMatchesExpectedLegacyShape).toBe(false)
    expect(JSON.stringify(report)).not.toContain('SELECT stop_uid')
    expect(JSON.stringify(report)).not.toContain('COUNT(*)')
  })

  it('uses identifier boundaries when classifying schema dependencies', () => {
    expect(referencedTargets('SELECT * FROM stops')).toEqual(['stops'])
    expect(referencedTargets('SELECT * FROM pattern_stops ps JOIN stops s')).toEqual(['pattern_stops', 'stops'])
    expect(referencedTargets('SELECT * FROM bus_stops_archive')).toEqual([])
    expect(referencedTargets('SELECT * FROM pattern_stops_backup')).toEqual([])
    expect(referencedTargets(null)).toEqual([])
  })

  it('fails closed on unbounded, unsafe, or oversized sqlite schema metadata', () => {
    const valid = { type: 'table', name: 'stops', tbl_name: 'stops', sql: 'CREATE TABLE stops (version TEXT)' }
    expect(() => normalizeSchemaRows(Array.from({ length: 257 }, () => valid))).toThrow(/bounded row set/)
    expect(() => normalizeSchemaRows([{ ...valid, name: '../stops' }])).toThrow(/invalid schema metadata/)
    expect(() => normalizeSchemaRows([{ ...valid, type: 'virtual-table' }])).toThrow(/invalid schema metadata/)
    expect(() => normalizeSchemaRows([{ ...valid, sql: 'x'.repeat(65_537) }])).toThrow(/invalid schema metadata/)
  })

  it('keeps the inventory implementation read-only and independent of publication credentials', () => {
    expect(source).toContain('FROM sqlite_schema')
    expect(source).toContain("kind: 'snapshot-high-card-d1-schema-inventory'")
    expect(source).not.toMatch(/(?:INSERT\s+INTO|DELETE\s+FROM|UPDATE|DROP\s+TABLE|ALTER\s+TABLE)\s+(?:stops|pattern_stops)\b/i)
    expect(source).not.toContain('TDX_CLIENT_ID')
    expect(source).not.toContain('TDX_CLIENT_SECRET')
    expect(source).not.toContain('snapshot:window')
    expect(source).not.toContain('sync-transit-snapshot')
    expect(source).toContain('does not authorize destructive retirement')
  })

  it('captures inventory in the existing read-only retirement evidence workflow', () => {
    expect(workflow).toContain('permissions:\n  contents: read')
    expect(workflow).not.toContain('schedule:')
    expect(workflow).toContain("scripts/transit-snapshot/high-card-retirement-schema-inventory.mjs")
    expect(workflow).toContain("scripts/transit-snapshot/high-card-retirement-schema-inventory.test.mjs")
    expect(workflow).toContain('SNAPSHOT_HIGH_CARD_SCHEMA_INVENTORY_REPORT: .transit-snapshot/high-card-retirement-schema-inventory.json')
    expect(workflow).toContain('.transit-snapshot/high-card-retirement-schema-inventory.json')
    expect(workflow).toContain('.transit-snapshot/high-card-retirement-readiness.json')
    expect(workflow).not.toContain('TDX_CLIENT_ID')
    expect(workflow).not.toContain('TDX_CLIENT_SECRET')
    expect(workflow).not.toContain('wrangler deploy')
    expect(workflow).not.toContain('snapshot:window')

    const inventoryStart = workflow.indexOf('- name: Inventory legacy high-card D1 schema')
    const readinessStart = workflow.indexOf('- name: Read legacy high-card retirement readiness')
    expect(inventoryStart).toBeGreaterThan(-1)
    expect(readinessStart).toBeGreaterThan(inventoryStart)
    const inventoryStep = workflow.slice(inventoryStart, readinessStart)
    expect(inventoryStep).toContain('CLOUDFLARE_API_TOKEN')
    expect(inventoryStep).toContain('CLOUDFLARE_ACCOUNT_ID')
    expect(inventoryStep).toContain('TRANSIT_DATABASE_ID')
    expect(inventoryStep).not.toContain('R2_ACCESS_KEY_ID')
    expect(inventoryStep).not.toContain('R2_SECRET_ACCESS_KEY')
  })
})
