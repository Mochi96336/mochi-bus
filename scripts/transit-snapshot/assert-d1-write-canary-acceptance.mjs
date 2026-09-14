import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const STAGE_TABLES = Object.freeze(['routes', 'patterns', 'stop_places'])
const MAX_EVIDENCE_BYTES = 256 * 1024

export function assertD1WriteCanaryAcceptance(report, {
  expectedCity = 'Taichung',
  expectedSourceCommit = null,
  expectedWorkflowRunId = null,
} = {}) {
  if (!report || typeof report !== 'object'
    || report.schemaVersion !== 1
    || report.event !== 'snapshot_d1_write_evidence') {
    throw new Error('D1 write canary evidence contract is invalid')
  }
  if (report.city !== expectedCity) {
    throw new Error('D1 write canary evidence city does not match the requested canary')
  }
  if (expectedSourceCommit && report.sourceCommit !== expectedSourceCommit) {
    throw new Error('D1 write canary evidence source commit does not match this run')
  }
  if (expectedWorkflowRunId && String(report.workflowRunId) !== String(expectedWorkflowRunId)) {
    throw new Error('D1 write canary evidence workflow run does not match this run')
  }
  if (report.result !== 'published' || report.acceptanceEvidence !== true) {
    throw new Error('D1 write canary did not produce published acceptance evidence')
  }

  for (const table of STAGE_TABLES) {
    const item = report.stage?.[table]
    if (!item
      || !Number.isSafeInteger(item.logicalRows) || item.logicalRows <= 0
      || !Number.isSafeInteger(item.rowsWritten) || item.rowsWritten <= 0
      || !Number.isSafeInteger(item.segments) || item.segments <= 0) {
      throw new Error(`D1 write canary published evidence is incomplete for ${table}`)
    }
  }

  return report
}

export async function main(env = process.env, argv = process.argv.slice(2)) {
  const evidencePath = argv[0]
  if (!evidencePath) {
    throw new Error('Usage: assert-d1-write-canary-acceptance.mjs <evidence-json>')
  }
  const text = await readFile(evidencePath, 'utf8')
  if (Buffer.byteLength(text, 'utf8') > MAX_EVIDENCE_BYTES) {
    throw new Error('D1 write canary evidence exceeded byte limit')
  }
  let report
  try {
    report = JSON.parse(text)
  } catch {
    throw new Error('D1 write canary evidence returned invalid JSON')
  }
  assertD1WriteCanaryAcceptance(report, {
    expectedCity: 'Taichung',
    expectedSourceCommit: env.GITHUB_SHA ?? null,
    expectedWorkflowRunId: env.GITHUB_RUN_ID ?? null,
  })
  console.log(JSON.stringify({
    event: 'snapshot_d1_write_canary_acceptance',
    city: report.city,
    result: report.result,
    acceptanceEvidence: true,
    sourceCommit: report.sourceCommit,
    workflowRunId: report.workflowRunId,
  }))
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'D1 write canary acceptance failed')
    process.exitCode = 1
  })
}
