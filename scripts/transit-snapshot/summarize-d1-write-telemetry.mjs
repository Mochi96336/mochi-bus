import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const STAGE_TABLES = Object.freeze(['routes', 'patterns', 'stop_places'])

export function summarizeD1WriteEvidence({ telemetryRecords, logRecords, sourceCommit = null, workflowRunId = null }) {
  const terminal = [...logRecords].reverse().find((record) => record?.event === 'snapshot_window_terminal') ?? null
  const published = [...logRecords].reverse().find((record) => record?.phase === 'published' && record?.city) ?? null
  const city = terminal?.city ?? published?.city ?? telemetryRecords.find((record) => record?.city)?.city ?? null
  const result = terminal?.result ?? 'failed'
  const activeVersion = terminal?.activeVersion ?? published?.version ?? null
  const previousVersion = terminal?.previousVersion ?? published?.previousVersion ?? null

  const stage = aggregateTelemetry(telemetryRecords, 'stage')
  const cleanup = aggregateTelemetry(telemetryRecords, 'cleanup')
  if (result === 'published') {
    for (const table of STAGE_TABLES) {
      const item = stage[table]
      if (!item || item.segments < 1 || item.logicalRows < 1 || item.rowsWritten < 1) {
        throw new Error(`Published snapshot is missing ${table} D1 write telemetry`)
      }
    }
  }

  return Object.freeze({
    schemaVersion: 1,
    event: 'snapshot_d1_write_evidence',
    sourceCommit,
    workflowRunId,
    city,
    result,
    activeVersion,
    previousVersion,
    acceptanceEvidence: result === 'published',
    stage: freezeAggregate(stage),
    cleanup: freezeAggregate(cleanup),
    stageRowsWritten: sumRowsWritten(stage),
    cleanupRowsWritten: sumRowsWritten(cleanup),
  })
}

export function parseJsonLines(text) {
  return Object.freeze(String(text ?? '').split(/\r?\n/).flatMap((line) => {
    const trimmed = line.trim()
    if (!trimmed) return []
    try { return [JSON.parse(trimmed)] } catch { return [] }
  }))
}

function aggregateTelemetry(records, phase) {
  const aggregate = Object.fromEntries(STAGE_TABLES.map((table) => [table, null]))
  for (const record of records) {
    if (record?.event !== 'snapshot_d1_write_telemetry'
      || record.phase !== phase
      || record.action !== 'segment_committed'
      || !STAGE_TABLES.includes(record.table)) continue
    const current = aggregate[record.table] ?? { logicalRows: 0, rowsWritten: 0, rowsRead: 0, queries: 0, segments: 0 }
    current.logicalRows += nonNegativeInteger(record.writeStatementCount, 'writeStatementCount')
    current.rowsWritten += nonNegativeInteger(record.rowsWritten, 'rowsWritten')
    current.rowsRead += nonNegativeInteger(record.rowsRead, 'rowsRead')
    current.queries += nonNegativeInteger(record.queryCount, 'queryCount')
    current.segments += 1
    aggregate[record.table] = current
  }
  return aggregate
}

function freezeAggregate(aggregate) {
  return Object.freeze(Object.fromEntries(Object.entries(aggregate).map(([table, value]) => [
    table,
    value ? Object.freeze({ ...value }) : null,
  ])))
}

function sumRowsWritten(aggregate) {
  return Object.values(aggregate).reduce((sum, value) => sum + (value?.rowsWritten ?? 0), 0)
}

function nonNegativeInteger(value, label) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label} must be a non-negative integer`)
  return number
}

async function main() {
  const [logFile, telemetryFile, outputFile] = process.argv.slice(2)
  if (!logFile || !telemetryFile || !outputFile) {
    throw new Error('Usage: summarize-d1-write-telemetry.mjs <snapshot-log> <telemetry-jsonl> <evidence-json>')
  }
  const [logText, telemetryText] = await Promise.all([
    readFile(logFile, 'utf8'),
    readFile(telemetryFile, 'utf8').catch((error) => error?.code === 'ENOENT' ? '' : Promise.reject(error)),
  ])
  const evidence = summarizeD1WriteEvidence({
    telemetryRecords: parseJsonLines(telemetryText),
    logRecords: parseJsonLines(logText),
    sourceCommit: process.env.GITHUB_SHA ?? null,
    workflowRunId: process.env.GITHUB_RUN_ID ?? null,
  })
  await writeFile(outputFile, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 })
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = STAGE_TABLES.map((table) => {
      const item = evidence.stage[table]
      return `| ${table} | ${item?.logicalRows ?? 0} | ${item?.rowsWritten ?? 0} | ${item?.segments ?? 0} |`
    })
    await writeFile(process.env.GITHUB_STEP_SUMMARY, [
      '## Snapshot D1 write canary',
      '',
      `- City: \`${evidence.city ?? 'unknown'}\``,
      `- Result: \`${evidence.result}\``,
      `- Active version: \`${evidence.activeVersion ?? 'none'}\``,
      `- Acceptance evidence: **${evidence.acceptanceEvidence ? 'yes' : 'no'}**`,
      '',
      '| table | logical stage rows | rows_written | committed segments |',
      '| --- | ---: | ---: | ---: |',
      ...rows,
      `| **stage total** | | **${evidence.stageRowsWritten}** | |`,
      '',
      `Cleanup rows_written: **${evidence.cleanupRowsWritten}**`,
      '',
    ].join('\n'), { flag: 'a' })
  }
  console.log(JSON.stringify(evidence))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
