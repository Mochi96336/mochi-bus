-- Realtime diagnostics are now sampled across cities while hard snapshot health
-- remains daily and exhaustive. SQLite cannot alter CHECK constraints in place,
-- so rebuild the two low-volume public-probe city tables to add the explicit
-- snapshot_healthy state without mislabeling un-sampled realtime as healthy.

CREATE TABLE public_probe_city_attempts_status_v2 (
  probe_schema_version INTEGER NOT NULL CHECK (probe_schema_version = 1),
  probe_run_id TEXT NOT NULL,
  evaluated_at TEXT NOT NULL,
  probe_date TEXT NOT NULL,
  city_code TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'healthy', 'snapshot_healthy', 'realtime_degraded',
    'hard_failed', 'unknown', 'record_write_failed'
  )),
  active_version TEXT,
  observed_version TEXT,
  failure_class TEXT NOT NULL,
  hard_checks_passed INTEGER NOT NULL CHECK (hard_checks_passed BETWEEN 0 AND 10),
  warning_count INTEGER NOT NULL CHECK (warning_count BETWEEN 0 AND 16),
  warnings TEXT NOT NULL,
  probe_case_version INTEGER NOT NULL CHECK (probe_case_version >= 1),
  sample_case_id TEXT NOT NULL,
  latency_bucket TEXT NOT NULL,
  PRIMARY KEY (probe_run_id, city_code),
  FOREIGN KEY (probe_run_id) REFERENCES public_probe_runs(probe_run_id)
);

INSERT INTO public_probe_city_attempts_status_v2 (
  probe_schema_version, probe_run_id, evaluated_at, probe_date, city_code,
  status, active_version, observed_version, failure_class, hard_checks_passed,
  warning_count, warnings, probe_case_version, sample_case_id, latency_bucket
)
SELECT
  probe_schema_version, probe_run_id, evaluated_at, probe_date, city_code,
  status, active_version, observed_version, failure_class, hard_checks_passed,
  warning_count, warnings, probe_case_version, sample_case_id, latency_bucket
FROM public_probe_city_attempts;

DROP TABLE public_probe_city_attempts;
ALTER TABLE public_probe_city_attempts_status_v2 RENAME TO public_probe_city_attempts;

CREATE TABLE public_probe_city_results_status_v2 (
  probe_schema_version INTEGER NOT NULL CHECK (probe_schema_version = 1),
  probe_run_id TEXT NOT NULL,
  evaluated_at TEXT NOT NULL,
  probe_date TEXT NOT NULL,
  city_code TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'healthy', 'snapshot_healthy', 'realtime_degraded',
    'hard_failed', 'unknown', 'record_write_failed'
  )),
  active_version TEXT,
  observed_version TEXT,
  failure_class TEXT NOT NULL,
  hard_checks_passed INTEGER NOT NULL CHECK (hard_checks_passed BETWEEN 0 AND 10),
  warning_count INTEGER NOT NULL CHECK (warning_count BETWEEN 0 AND 16),
  warnings TEXT NOT NULL,
  probe_case_version INTEGER NOT NULL CHECK (probe_case_version >= 1),
  sample_case_id TEXT NOT NULL,
  latency_bucket TEXT NOT NULL,
  PRIMARY KEY (probe_date, city_code)
);

INSERT INTO public_probe_city_results_status_v2 (
  probe_schema_version, probe_run_id, evaluated_at, probe_date, city_code,
  status, active_version, observed_version, failure_class, hard_checks_passed,
  warning_count, warnings, probe_case_version, sample_case_id, latency_bucket
)
SELECT
  probe_schema_version, probe_run_id, evaluated_at, probe_date, city_code,
  status, active_version, observed_version, failure_class, hard_checks_passed,
  warning_count, warnings, probe_case_version, sample_case_id, latency_bucket
FROM public_probe_city_results;

DROP TABLE public_probe_city_results;
ALTER TABLE public_probe_city_results_status_v2 RENAME TO public_probe_city_results;
CREATE INDEX public_probe_city_results_status_idx
  ON public_probe_city_results(probe_date, status);
