import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const MAX_REPORT_BYTES = 64 * 1024
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export function assertRootBoundRollbackWindow(report) {
  if (!report || typeof report !== 'object') throw gateError('invalid_evidence_report')
  if (report.schemaVersion !== 1
    || report.kind !== 'snapshot-rollback-authority-window'
    || report.city !== 'Taichung'
    || !safeId(report.activeVersion)
    || !safeId(report.previousVersion)
    || report.activeVersion === report.previousVersion) {
    throw gateError('invalid_evidence_report')
  }
  if (report.rootBoundRollbackWindow !== true
    || report.activeAuthorityMode !== 'root-bound'
    || report.previousAuthorityMode !== 'root-bound'
    || report.rollbackTargetAuthorityMode !== 'root-bound') {
    throw gateError('root_bound_window_required')
  }
  return report
}

export async function readAndAssertRootBoundRollbackWindow(path) {
  if (typeof path !== 'string' || !path.trim()) throw gateError('invalid_evidence_report')
  const body = await readFile(path)
  if (body.byteLength > MAX_REPORT_BYTES) throw gateError('invalid_evidence_report')
  let report
  try {
    report = JSON.parse(body.toString('utf8'))
  } catch {
    throw gateError('invalid_evidence_report')
  }
  return assertRootBoundRollbackWindow(report)
}

function gateError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function safeId(value) {
  return typeof value === 'string' && SAFE_ID.test(value)
}

async function main() {
  try {
    await readAndAssertRootBoundRollbackWindow(process.argv[2])
    console.log(JSON.stringify({
      event: 'snapshot_rollback_drill_authority_gate',
      outcome: 'root_bound_window_confirmed',
    }))
  } catch (error) {
    const outcome = error?.code === 'root_bound_window_required'
      ? 'root_bound_window_required'
      : 'invalid_evidence_report'
    console.error(JSON.stringify({
      event: 'snapshot_rollback_drill_authority_gate_failed',
      outcome,
    }))
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
