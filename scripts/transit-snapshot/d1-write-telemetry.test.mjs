import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  classifyPublisherD1Statement,
  parseWranglerD1ImportJson,
  segmentPublisherD1Sql,
  splitSqlStatements,
} from './d1-write-telemetry.mjs'
import {
  createSnapshotD1TelemetrySpawnSync,
  createTdxTokenDiagnosticFetch,
} from './install-d1-write-telemetry.mjs'
import { parseJsonLines, summarizeD1WriteEvidence } from './summarize-d1-write-telemetry.mjs'

const TDX_TOKEN_ENDPOINT = 'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token'

describe('snapshot D1 write telemetry', () => {
  it('splits generated SQL without breaking quoted semicolons or escaped quotes', () => {
    expect(splitSqlStatements("INSERT INTO routes VALUES ('a;b');\nDELETE FROM routes WHERE x='it''s';")).toEqual([
      "INSERT INTO routes VALUES ('a;b');",
      "DELETE FROM routes WHERE x='it''s';",
    ])
    expect(() => splitSqlStatements("INSERT INTO routes VALUES ('oops);")).toThrow('unterminated')
  })

  it('classifies only the low-cardinality publisher tables', () => {
    expect(classifyPublisherD1Statement('INSERT OR REPLACE INTO routes VALUES (1);')).toBe('routes')
    expect(classifyPublisherD1Statement('DELETE FROM stop_places WHERE version=1;')).toBe('stop_places')
    expect(classifyPublisherD1Statement('PRAGMA foreign_keys=OFF;')).toBeNull()
    expect(classifyPublisherD1Statement('INSERT INTO stops VALUES (1);')).toBeNull()
  })

  it('keeps statement order while making table-aligned import segments', () => {
    const segments = segmentPublisherD1Sql(`
      PRAGMA foreign_keys=OFF;
      INSERT OR REPLACE INTO routes VALUES ('v', 'c', 'r1');
      INSERT OR REPLACE INTO routes VALUES ('v', 'c', 'r2');
      INSERT OR REPLACE INTO patterns VALUES ('v', 'p1');
      INSERT OR REPLACE INTO stop_places VALUES ('v', 's1');
      INSERT OR REPLACE INTO stop_places VALUES ('v', 's2');
    `)
    expect(segments.map((segment) => [segment.table, segment.statements.length, segment.writeStatementCount])).toEqual([
      ['routes', 3, 2],
      ['patterns', 1, 1],
      ['stop_places', 2, 2],
    ])
    expect(segments[0].sql).toMatch(/^PRAGMA foreign_keys=OFF;/)
  })

  it('parses Wrangler dedicated-import billing metadata', () => {
    expect(parseWranglerD1ImportJson(JSON.stringify([{
      results: [{ 'Total queries executed': 3, 'Rows read': 0, 'Rows written': 9 }],
      success: true,
      meta: { duration: 12.5, rows_read: 0, rows_written: 9 },
    }]))).toEqual({ rowsWritten: 9, rowsRead: 0, queryCount: 3, durationMs: 12.5 })
  })

  it('captures only the bounded TDX OAuth error code without consuming the response body', async () => {
    const root = mkdtempSync(join(tmpdir(), 'snapshot-tdx-diagnostic-test-'))
    try {
      const telemetryFile = join(root, 'telemetry.jsonl')
      const originalFetch = async () => new Response(JSON.stringify({
        error: 'invalid_client',
        error_description: 'sensitive server description',
        access_token: 'must-not-be-recorded',
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
      const diagnosticFetch = createTdxTokenDiagnosticFetch({
        originalFetch,
        env: {
          SNAPSHOT_D1_WRITE_TELEMETRY_FILE: telemetryFile,
          SNAPSHOT_D1_WRITE_TELEMETRY_CITY: 'Taichung',
          GITHUB_RUN_ID: '123',
        },
        stdout: { write() {} },
      })
      const response = await diagnosticFetch(TDX_TOKEN_ENDPOINT, {
        method: 'POST',
        body: 'grant_type=client_credentials&client_secret=top-secret',
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({
        error: 'invalid_client',
        error_description: 'sensitive server description',
        access_token: 'must-not-be-recorded',
      })
      const raw = readFileSync(telemetryFile, 'utf8')
      const [record] = parseJsonLines(raw)
      expect(record).toMatchObject({
        event: 'snapshot_d1_write_telemetry',
        action: 'tdx_token_error',
        phase: 'source_fetch',
        city: 'Taichung',
        httpStatus: 400,
        oauthError: 'invalid_client',
      })
      expect(raw).not.toContain('sensitive server description')
      expect(raw).not.toContain('must-not-be-recorded')
      expect(raw).not.toContain('top-secret')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not rewrite a segment that already committed before a later segment retry', () => {
    const root = mkdtempSync(join(tmpdir(), 'snapshot-d1-telemetry-test-'))
    try {
      const directory = join(root, '.transit-snapshot', 'Taichung')
      mkdirSync(directory, { recursive: true })
      const file = join(directory, 'import-00.sql')
      writeFileSync(file, [
        'PRAGMA foreign_keys=OFF;',
        "INSERT OR REPLACE INTO routes VALUES ('v','c','r1');",
        "INSERT OR REPLACE INTO routes VALUES ('v','c','r2');",
        "INSERT OR REPLACE INTO patterns VALUES ('v','p1');",
        "INSERT OR REPLACE INTO stop_places VALUES ('v','s1');",
      ].join('\n'))
      const telemetryFile = join(root, 'telemetry.jsonl')
      const calls = []
      let failPatternOnce = true
      const originalSpawnSync = (_command, args) => {
        const fileIndex = args.indexOf('--file')
        const sql = readFileSync(args[fileIndex + 1], 'utf8')
        const table = /routes/.test(sql) ? 'routes' : /patterns/.test(sql) ? 'patterns' : 'stop_places'
        calls.push(table)
        if (table === 'patterns' && failPatternOnce) {
          failPatternOnce = false
          return { status: 1, stdout: '', stderr: 'simulated failure\n' }
        }
        const rowsWritten = table === 'routes' ? 6 : 3
        return {
          status: 0,
          stdout: JSON.stringify([{
            results: [{ 'Total queries executed': 1, 'Rows read': 0, 'Rows written': rowsWritten }],
            success: true,
            meta: { duration: 1, rows_read: 0, rows_written: rowsWritten },
          }]),
          stderr: '',
        }
      }
      const spawnSync = createSnapshotD1TelemetrySpawnSync({
        originalSpawnSync,
        execPath: '/node',
        env: {
          SNAPSHOT_D1_WRITE_TELEMETRY_FILE: telemetryFile,
          SNAPSHOT_D1_WRITE_TELEMETRY_CITY: 'Taichung',
        },
        stdout: { write() {} },
        stderr: { write() {} },
      })
      const args = ['node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'db', '--remote', '--file', file]
      expect(spawnSync('/node', args, { stdio: 'inherit' }).status).toBe(1)
      expect(spawnSync('/node', args, { stdio: 'inherit' }).status).toBe(0)
      expect(calls).toEqual(['routes', 'patterns', 'patterns', 'stop_places'])
      const records = readFileSync(telemetryFile, 'utf8').trim().split(/\r?\n/).map(JSON.parse)
      expect(records.map((record) => [record.action, record.table])).toEqual([
        ['segment_committed', 'routes'],
        ['segment_failed', 'patterns'],
        ['reuse_committed_segment', 'routes'],
        ['segment_committed', 'patterns'],
        ['segment_committed', 'stop_places'],
      ])
      expect(records.filter((record) => record.action === 'segment_committed' && record.table === 'routes')).toHaveLength(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('summarizes only committed segments and requires all low-card tables for a published result', () => {
    const telemetryRecords = [
      { event: 'snapshot_d1_write_telemetry', action: 'segment_committed', phase: 'stage', table: 'routes', writeStatementCount: 2, rowsWritten: 6, rowsRead: 0, queryCount: 3 },
      { event: 'snapshot_d1_write_telemetry', action: 'reuse_committed_segment', phase: 'stage', table: 'routes', writeStatementCount: 2, rowsWritten: 6, rowsRead: 0, queryCount: 3 },
      { event: 'snapshot_d1_write_telemetry', action: 'segment_committed', phase: 'stage', table: 'patterns', writeStatementCount: 1, rowsWritten: 3, rowsRead: 0, queryCount: 1 },
      { event: 'snapshot_d1_write_telemetry', action: 'segment_committed', phase: 'stage', table: 'stop_places', writeStatementCount: 4, rowsWritten: 12, rowsRead: 0, queryCount: 4 },
      { event: 'snapshot_d1_write_telemetry', action: 'segment_committed', phase: 'cleanup', table: 'routes', writeStatementCount: 1, rowsWritten: 9, rowsRead: 0, queryCount: 1 },
    ]
    const logRecords = [{ event: 'snapshot_window_terminal', city: 'Taichung', result: 'published', activeVersion: 'v2', previousVersion: 'v1' }]
    const evidence = summarizeD1WriteEvidence({ telemetryRecords, logRecords, sourceCommit: 'a'.repeat(40), workflowRunId: '1' })
    expect(evidence.acceptanceEvidence).toBe(true)
    expect(evidence.stage.routes.logicalRows).toBe(2)
    expect(evidence.stage.routes.rowsWritten).toBe(6)
    expect(evidence.stageRowsWritten).toBe(21)
    expect(evidence.cleanupRowsWritten).toBe(9)
    expect(evidence.tdxTokenFailure).toBeNull()
    expect(parseJsonLines('noise\n{"a":1}\n')).toEqual([{ a: 1 }])
    expect(() => summarizeD1WriteEvidence({
      telemetryRecords: telemetryRecords.filter((record) => record.table !== 'patterns'),
      logRecords,
    })).toThrow('missing patterns')
    expect(summarizeD1WriteEvidence({
      telemetryRecords: [],
      logRecords: [{ event: 'snapshot_window_terminal', city: 'Taichung', result: 'unchanged', activeVersion: 'v1' }],
    }).acceptanceEvidence).toBe(false)
  })

  it('retains failed window identity and bounded TDX auth classification', () => {
    const evidence = summarizeD1WriteEvidence({
      telemetryRecords: [{
        event: 'snapshot_d1_write_telemetry',
        action: 'tdx_token_error',
        phase: 'source_fetch',
        city: null,
        httpStatus: 400,
        oauthError: 'invalid_client',
      }],
      logRecords: [{
        event: 'snapshot_window_completed',
        city: 'Taichung',
        windowResult: 'failed',
        activeVersion: 'v1',
      }],
    })
    expect(evidence).toMatchObject({
      city: 'Taichung',
      result: 'failed',
      activeVersion: 'v1',
      acceptanceEvidence: false,
      tdxTokenFailure: { httpStatus: 400, oauthError: 'invalid_client' },
      stageRowsWritten: 0,
      cleanupRowsWritten: 0,
    })
  })
})
