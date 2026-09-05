import { createHash } from 'node:crypto'
import { queryD1, queryD1Batch, TRANSIT_D1_DATABASE_ID } from './window-d1.mjs'
import { validatePublicProbeResult } from './public-probe-contract.mjs'

// Read-only reference queries. The public probe never writes to
// dataset_versions, snapshot tables, or R2 — it only records its own
// public_probe_* rows. Keep snapshot reference reads low-cardinality: the
// public surface itself is responsible for exercising R2 stop/routing data.
const ACTIVE_SQL = `
SELECT active_version
FROM dataset_versions
WHERE city_code = ?
LIMIT 1
`

const COUNTS_SQL = `
SELECT
  (SELECT COUNT(*) FROM routes WHERE version = ? AND city_code = ?) AS routes,
  (SELECT COUNT(*) FROM patterns WHERE version = ? AND city_code = ?) AS patterns,
  (SELECT COUNT(*) FROM stop_places WHERE version = ? AND city_code = ?) AS places,
  (SELECT COUNT(*) FROM routes r
    WHERE r.version = ? AND r.city_code = ?
      AND NOT EXISTS (
        SELECT 1 FROM patterns p
        WHERE p.version = r.version AND p.city_code = r.city_code AND p.route_uid = r.route_uid
      )) AS route_without_pattern,
  (SELECT COUNT(*) FROM patterns p
    JOIN routes r ON r.version = p.version AND r.city_code = p.city_code AND r.route_uid = p.route_uid
    WHERE p.version = ? AND p.city_code = ?) AS sample_count
`

const SAMPLE_SQL = `
SELECT p.pattern_id, p.route_uid, r.route_name
FROM patterns p
JOIN routes r ON r.version = p.version AND r.city_code = p.city_code AND r.route_uid = p.route_uid
WHERE p.version = ? AND p.city_code = ?
ORDER BY p.pattern_id, p.route_uid
LIMIT 1 OFFSET ?
`

const START_RUN_SQL = `
INSERT INTO public_probe_runs (
  probe_schema_version, probe_run_id, evaluated_at, probe_date,
  completed_at, result, failure_count
) VALUES (1, ?, ?, ?, NULL, 'running', 0)
ON CONFLICT(probe_run_id) DO UPDATE SET
  evaluated_at=excluded.evaluated_at,
  probe_date=excluded.probe_date,
  completed_at=NULL,
  result='running',
  failure_count=0
WHERE excluded.evaluated_at >= public_probe_runs.evaluated_at
`

const COMPLETE_RUN_SQL = `
UPDATE public_probe_runs
SET completed_at = ?, result = ?, failure_count = ?
WHERE probe_run_id = ? AND evaluated_at = ?
`

const INSERT_CITY_ATTEMPT_SQL = `
INSERT INTO public_probe_city_attempts (
  probe_schema_version, probe_run_id, evaluated_at, probe_date, city_code,
  status, active_version, observed_version, failure_class, hard_checks_passed,
  warning_count, warnings, probe_case_version, sample_case_id, latency_bucket
) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(probe_run_id, city_code) DO UPDATE SET
  evaluated_at=excluded.evaluated_at,
  probe_date=excluded.probe_date,
  status=excluded.status,
  active_version=excluded.active_version,
  observed_version=excluded.observed_version,
  failure_class=excluded.failure_class,
  hard_checks_passed=excluded.hard_checks_passed,
  warning_count=excluded.warning_count,
  warnings=excluded.warnings,
  probe_case_version=excluded.probe_case_version,
  sample_case_id=excluded.sample_case_id,
  latency_bucket=excluded.latency_bucket
WHERE excluded.evaluated_at >= public_probe_city_attempts.evaluated_at
`

const UPSERT_CANONICAL_CITY_SQL = `
INSERT INTO public_probe_city_results (
  probe_schema_version, probe_run_id, evaluated_at, probe_date, city_code,
  status, active_version, observed_version, failure_class, hard_checks_passed,
  warning_count, warnings, probe_case_version, sample_case_id, latency_bucket
) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(probe_date, city_code) DO UPDATE SET
  probe_schema_version=excluded.probe_schema_version,
  probe_run_id=excluded.probe_run_id,
  evaluated_at=excluded.evaluated_at,
  status=excluded.status,
  active_version=excluded.active_version,
  observed_version=excluded.observed_version,
  failure_class=excluded.failure_class,
  hard_checks_passed=excluded.hard_checks_passed,
  warning_count=excluded.warning_count,
  warnings=excluded.warnings,
  probe_case_version=excluded.probe_case_version,
  sample_case_id=excluded.sample_case_id,
  latency_bucket=excluded.latency_bucket
WHERE excluded.evaluated_at > public_probe_city_results.evaluated_at
  OR (excluded.evaluated_at = public_probe_city_results.evaluated_at
    AND excluded.probe_run_id >= public_probe_city_results.probe_run_id)
`

export function createD1PublicProbeStore({
  accountId,
  apiToken,
  databaseId = TRANSIT_D1_DATABASE_ID,
  fetchImpl = fetch,
}) {
  if (!accountId || !apiToken || !databaseId) throw new Error('Missing public probe D1 configuration')
  const query = (sql, params) => queryD1({ accountId, apiToken, databaseId, fetchImpl, sql, params })
  const batch = (queries) => queryD1Batch({ accountId, apiToken, databaseId, fetchImpl, queries })
  return Object.freeze({
    async readReference(city) {
      const activeRows = await query(ACTIVE_SQL, [city])
      const activeVersion = activeRows[0]?.active_version === null || activeRows[0]?.active_version === undefined
        ? null
        : String(activeRows[0].active_version)
      if (activeVersion === null) return Object.freeze({ activeVersion: null, counts: null })
      const countRows = await query(COUNTS_SQL, [
        activeVersion, city, activeVersion, city, activeVersion, city,
        activeVersion, city, activeVersion, city,
      ])
      const row = countRows[0] ?? {}
      return Object.freeze({
        activeVersion,
        counts: Object.freeze({
          routes: Number(row.routes ?? 0),
          patterns: Number(row.patterns ?? 0),
          places: Number(row.places ?? 0),
          routeWithoutPattern: Number(row.route_without_pattern ?? 0),
          sampleCount: Number(row.sample_count ?? 0),
        }),
      })
    },

    async readSample(city, activeVersion, sampleIndex) {
      const rows = await query(SAMPLE_SQL, [activeVersion, city, sampleIndex])
      const row = rows[0]
      if (!row) return null
      return Object.freeze({
        patternId: String(row.pattern_id),
        routeUid: String(row.route_uid),
        routeName: String(row.route_name),
      })
    },

    async startRun({ probeRunId, evaluatedAt, probeDate }) {
      await query(START_RUN_SQL, [probeRunId, evaluatedAt, probeDate])
    },

    async completeCity(probeRunId, result) {
      const safe = validatePublicProbeResult(result)
      const params = cityParams(probeRunId, safe)
      await batch([
        { sql: INSERT_CITY_ATTEMPT_SQL, params },
        { sql: UPSERT_CANONICAL_CITY_SQL, params },
      ])
    },

    async completeRun({ probeRunId, evaluatedAt, completedAt, result, failureCount }) {
      await query(COMPLETE_RUN_SQL, [completedAt, result, failureCount, probeRunId, evaluatedAt])
    },
  })
}

export function publicProbeRunId({ workflowRunId, workflowRunAttempt = 1, evaluatedAt }) {
  if (workflowRunId) return `gh:${safeIdentifier(workflowRunId)}:${positiveInteger(workflowRunAttempt)}`
  const time = new Date(evaluatedAt).toISOString()
  return `local:${createHash('sha256').update(time).digest('hex').slice(0, 16)}`
}

function cityParams(probeRunIdValue, value) {
  return [
    probeRunIdValue,
    value.evaluatedAt,
    value.probeDate,
    value.city,
    value.status,
    value.activeVersion,
    value.observedVersion,
    value.failureClass,
    value.hardChecksPassed,
    value.realtimeWarnings.length,
    value.realtimeWarnings.join(','),
    value.probeCaseVersion,
    value.sampleCaseId,
    value.latencyBucket,
  ]
}

function safeIdentifier(value) {
  const text = String(value)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(text)) throw new Error('Invalid public probe run identifier')
  return text
}

function positiveInteger(value) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1) throw new Error('Invalid public probe run attempt')
  return number
}
