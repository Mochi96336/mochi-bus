import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildHighCardRetirementPlan } from './high-card-retirement-plan.mjs'

export const HIGH_CARD_RETIREMENT_PLAN_EVIDENCE_SCHEMA_VERSION = 1
const PLAN_EVIDENCE_KIND = 'snapshot-high-card-d1-retirement-plan-evidence'
const DEFAULT_SCHEMA_REPORT_PATH = join('.transit-snapshot', 'high-card-retirement-schema-inventory.json')
const DEFAULT_AUTHORITY_REPORT_PATH = join('.transit-snapshot', 'high-card-retirement-readiness.json')
const DEFAULT_PLAN_REPORT_PATH = join('.transit-snapshot', 'high-card-retirement-plan.json')
const MAX_INPUT_REPORT_BYTES = 2 * 1024 * 1024
const SAFE_SHA = /^[0-9a-f]{40}$/i
const SAFE_RUN_ID = /^[1-9][0-9]{0,19}$/
const SAFE_RUN_ATTEMPT = /^[1-9][0-9]{0,5}$/

export function collectHighCardRetirementPlanEvidence({
  schemaInventory,
  authorityReadiness,
  env = process.env,
  now = () => new Date(),
} = {}) {
  const expected = expectedProvenance(env)
  const schemaProvenance = normalizeProvenance(schemaInventory, 'schema inventory')
  const authorityProvenance = normalizeProvenance(authorityReadiness, 'authority readiness')

  assertSameProvenance(schemaProvenance, expected, 'schema inventory')
  assertSameProvenance(authorityProvenance, expected, 'authority readiness')
  if (schemaProvenance.sourceCommit !== authorityProvenance.sourceCommit
    || schemaProvenance.workflowRunId !== authorityProvenance.workflowRunId
    || schemaProvenance.workflowRunAttempt !== authorityProvenance.workflowRunAttempt) {
    throw new Error('High-card retirement plan evidence inputs do not share one workflow provenance')
  }

  const plan = buildHighCardRetirementPlan({ schemaInventory, authorityReadiness, now })
  return Object.freeze({
    schemaVersion: HIGH_CARD_RETIREMENT_PLAN_EVIDENCE_SCHEMA_VERSION,
    kind: PLAN_EVIDENCE_KIND,
    sourceCommit: expected.sourceCommit,
    workflowRunId: expected.workflowRunId,
    workflowRunAttempt: expected.workflowRunAttempt,
    generatedAt: now().toISOString(),
    inputEvidence: Object.freeze({
      schemaInventoryGeneratedAt: schemaProvenance.generatedAt,
      authorityReadinessGeneratedAt: authorityProvenance.generatedAt,
    }),
    plan,
  })
}

export function normalizeProvenance(report, label = 'report') {
  const sourceCommit = safeSha(report?.sourceCommit)
  const workflowRunId = safeRunId(report?.workflowRunId)
  const workflowRunAttempt = safeRunAttempt(report?.workflowRunAttempt)
  const generatedAt = safeIsoTimestamp(report?.generatedAt)
  if (!sourceCommit || !workflowRunId || !workflowRunAttempt || !generatedAt) {
    throw new Error(`High-card retirement plan ${label} provenance is invalid`)
  }
  return Object.freeze({ sourceCommit, workflowRunId, workflowRunAttempt, generatedAt })
}

function expectedProvenance(env) {
  const sourceCommit = safeSha(env.GITHUB_SHA)
  const workflowRunId = safeRunId(env.GITHUB_RUN_ID)
  const workflowRunAttempt = safeRunAttempt(env.GITHUB_RUN_ATTEMPT)
  if (!sourceCommit || !workflowRunId || !workflowRunAttempt) {
    throw new Error('High-card retirement plan requires GitHub workflow provenance')
  }
  return Object.freeze({ sourceCommit, workflowRunId, workflowRunAttempt })
}

function assertSameProvenance(actual, expected, label) {
  if (actual.sourceCommit !== expected.sourceCommit
    || actual.workflowRunId !== expected.workflowRunId
    || actual.workflowRunAttempt !== expected.workflowRunAttempt) {
    throw new Error(`High-card retirement plan ${label} provenance does not match the current workflow`)
  }
}

async function readBoundedJson(path, label) {
  const metadata = await stat(path)
  if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_INPUT_REPORT_BYTES) {
    throw new Error(`High-card retirement plan ${label} file is invalid or too large`)
  }
  const text = await readFile(path, 'utf8')
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`High-card retirement plan ${label} is not valid JSON`)
  }
}

async function writeEvidence(evidence, env) {
  const path = env.SNAPSHOT_HIGH_CARD_RETIREMENT_PLAN_REPORT || DEFAULT_PLAN_REPORT_PATH
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 })
  if (env.GITHUB_STEP_SUMMARY) {
    await appendFile(env.GITHUB_STEP_SUMMARY, [
      '## Legacy high-card D1 retirement plan',
      '',
      `Planning state: ${evidence.plan.planningState}; destructive execution authorized: ${evidence.plan.destructiveExecutionAuthorized}.`,
      `Blockers: ${evidence.plan.blockers.length ? evidence.plan.blockers.join(', ') : 'none'}.`,
      `Remaining acceptance gates: ${evidence.plan.remainingAcceptanceGates.length ? evidence.plan.remainingAcceptanceGates.join(', ') : 'none'}.`,
      '',
      '> This plan is same-run evidence only. It emits no mutation SQL and cannot authorize destructive cleanup.',
      '',
    ].join('\n'))
  }
  return path
}

async function main(env = process.env) {
  const schemaPath = env.SNAPSHOT_HIGH_CARD_SCHEMA_INVENTORY_REPORT || DEFAULT_SCHEMA_REPORT_PATH
  const authorityPath = env.SNAPSHOT_HIGH_CARD_RETIREMENT_REPORT || DEFAULT_AUTHORITY_REPORT_PATH
  const [schemaInventory, authorityReadiness] = await Promise.all([
    readBoundedJson(schemaPath, 'schema inventory'),
    readBoundedJson(authorityPath, 'authority readiness'),
  ])
  const evidence = collectHighCardRetirementPlanEvidence({ schemaInventory, authorityReadiness, env })
  const reportPath = await writeEvidence(evidence, env)
  console.log(JSON.stringify({
    event: 'snapshot_high_card_retirement_plan_evidence',
    reportPath,
    sourceCommit: evidence.sourceCommit,
    workflowRunId: evidence.workflowRunId,
    workflowRunAttempt: evidence.workflowRunAttempt,
    planningState: evidence.plan.planningState,
    destructiveExecutionAuthorized: evidence.plan.destructiveExecutionAuthorized,
    blockers: evidence.plan.blockers,
    remainingAcceptanceGates: evidence.plan.remainingAcceptanceGates,
  }))
}

function safeSha(value) {
  return typeof value === 'string' && SAFE_SHA.test(value) ? value.toLowerCase() : null
}

function safeRunId(value) {
  return typeof value === 'string' && SAFE_RUN_ID.test(value) ? value : null
}

function safeRunAttempt(value) {
  return typeof value === 'string' && SAFE_RUN_ATTEMPT.test(value) ? value : null
}

function safeIsoTimestamp(value) {
  if (typeof value !== 'string') return null
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) return null
  return new Date(milliseconds).toISOString() === value ? value : null
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify({
      event: 'snapshot_high_card_retirement_plan_evidence_failed',
      message: error instanceof Error ? error.message : String(error),
    }))
    process.exitCode = 1
  })
}
