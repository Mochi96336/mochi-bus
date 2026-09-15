import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { executePublisherD1File, parseObservedD1WriteRecord } from './observed-d1-write.mjs'
import { isPublisherRemoteD1FileExecute } from './install-observed-d1-write.mjs'

const sha = 'a'.repeat(40)

function successJson(rowsWritten = 12) {
  return JSON.stringify([{
    success: true,
    results: [],
    meta: { rows_written: rowsWritten, rows_read: 3, num_queries: 2, duration: 1.5 },
  }])
}

function observedEnv(file) {
  return {
    SNAPSHOT_D1_OBSERVED_WRITE: '1',
    SNAPSHOT_D1_OBSERVED_WRITE_FILE: file,
    SNAPSHOT_D1_OBSERVED_WRITE_CITY: 'Taichung',
    SNAPSHOT_WINDOW_ID: 'v1:Taichung:2026-09-18:0317',
    GITHUB_RUN_ID: '123456789',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_SHA: sha,
  }
}

describe('scheduled observed D1 writes', () => {
  it('leaves normal publisher execution unchanged when observation is disabled', () => {
    const calls = []
    const result = { status: 0 }
    const actual = executePublisherD1File({
      spawnSyncImpl: (...args) => { calls.push(args); return result },
      execPath: '/node',
      database: 'db',
      file: '.transit-snapshot/Taichung/import-0.sql',
      env: {},
    })
    expect(actual).toBe(result)
    expect(calls).toEqual([[
      '/node',
      ['node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'db', '--remote', '--file', '.transit-snapshot/Taichung/import-0.sql'],
      { stdio: 'inherit' },
    ]])
  })

  it('executes the original SQL file once and records bounded committed metrics', () => {
    const root = mkdtempSync(join(tmpdir(), 'observed-d1-'))
    try {
      const output = join(root, 'observed.jsonl')
      const calls = []
      const result = { status: 0, stdout: successJson(17), stderr: '' }
      const lines = []
      const actual = executePublisherD1File({
        spawnSyncImpl: (...args) => { calls.push(args); return result },
        execPath: '/node',
        database: 'db',
        file: '.transit-snapshot/Taichung/import-0.sql',
        env: observedEnv(output),
        stdout: { write: (value) => lines.push(String(value)) },
        stderr: { write() {} },
        now: () => new Date('2026-09-18T00:00:00.000Z'),
      })
      expect(actual).toBe(result)
      expect(calls).toHaveLength(1)
      expect(calls[0][1]).toEqual([
        'node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'db', '--remote', '--file',
        '.transit-snapshot/Taichung/import-0.sql', '--json',
      ])
      const record = JSON.parse(readFileSync(output, 'utf8').trim())
      expect(parseObservedD1WriteRecord(record)).toMatchObject({
        city: 'Taichung',
        windowId: 'v1:Taichung:2026-09-18:0317',
        workflowRunId: '123456789',
        workflowRunAttempt: 1,
        scriptGitSha: sha,
        phase: 'stage',
        sourceFile: 'import-0.sql',
        rowsWritten: 17,
      })
      expect(lines.join('')).toContain('snapshot_d1_observed_write')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('fails open after a successful commit when metrics cannot be parsed', () => {
    const root = mkdtempSync(join(tmpdir(), 'observed-d1-'))
    try {
      const warnings = []
      const result = { status: 0, stdout: 'not-json', stderr: '' }
      const actual = executePublisherD1File({
        spawnSyncImpl: () => result,
        execPath: '/node',
        database: 'db',
        file: '.transit-snapshot/Taichung/cleanup.sql',
        env: observedEnv(join(root, 'observed.jsonl')),
        stdout: { write() {} },
        stderr: { write: (value) => warnings.push(String(value)) },
      })
      expect(actual.status).toBe(0)
      expect(warnings.join('')).toContain('snapshot_d1_observed_write_unavailable')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('returns failed executions unchanged so the publisher owns retry policy', () => {
    const output = []
    const errors = []
    const result = { status: 1, stdout: 'failed-stdout', stderr: 'failed-stderr' }
    const actual = executePublisherD1File({
      spawnSyncImpl: () => result,
      execPath: '/node',
      database: 'db',
      file: '.transit-snapshot/Taichung/import-0.sql',
      env: observedEnv('/tmp/unused-observed.jsonl'),
      stdout: { write: (value) => output.push(String(value)) },
      stderr: { write: (value) => errors.push(String(value)) },
    })
    expect(actual).toBe(result)
    expect(output.join('')).toBe('failed-stdout')
    expect(errors.join('')).toBe('failed-stderr')
  })

  it('intercepts only publisher import and cleanup files', () => {
    const base = ['node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'db', '--remote', '--file']
    expect(isPublisherRemoteD1FileExecute(process.execPath, [...base, '.transit-snapshot/Taichung/import-3.sql'])).toBe(true)
    expect(isPublisherRemoteD1FileExecute(process.execPath, [...base, '.transit-snapshot/Taichung/cleanup.sql'])).toBe(true)
    expect(isPublisherRemoteD1FileExecute(process.execPath, [...base, '.transit-snapshot/Taichung/query.sql'])).toBe(false)
    expect(isPublisherRemoteD1FileExecute('/usr/bin/wrangler', [...base, '.transit-snapshot/Taichung/import-0.sql'])).toBe(false)
  })
})
