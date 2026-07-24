# Shape-to-pattern TDX measurement harness

This directory contains the measurement-only MB-C01 harness for the deterministic Shape-to-pattern matcher. It is isolated under `scripts/` and is not imported by `src/`, `web/`, Vite, the Worker, the snapshot producer, public APIs, journey ranking, rendering, or production telemetry.

The harness creates replayable evidence. It does **not** establish a production guard or authorize production integration. Until real credentialed TDX reports are reviewed, the gate remains:

> C. Temporarily not ready for production integration.

Production PR 2 remains blocked. Production PR 3 has not started.

## Evidence boundary

Snapshot output is not valid matcher evidence because the snapshot producer has already selected Shapes using index and first-Shape fallback. This harness reads raw `StopOfRoute` and `Shape` endpoints and preserves all valid records in source-scoped `RouteUID + Direction` partitions. It never uses index pairing, first-candidate selection, lexical selection, greedy assignment, or snapshot output as measurement evidence.

Sanitized fixtures verify capability and safety only. A sanitized fixture must not select a production guard, and merging this harness does not mean the matcher passed the production gate.

The committed sanitized two-mode integration test materializes a canonical raw cache, verifies it through the formal raw-cache reader, builds candidates from that verified reader output, creates plain and instrumented reports, and runs formal report validation for both modes. It does **not** execute the complete CLI argument flow, final report atomic publication, or the completion-marker reader. Those capabilities remain covered by their separate focused tests and do not turn sanitized data into production evidence.

## Filesystem policy

Repository-local measurement data is allowed only below:

```text
.tdx-measurement/
```

The default pairwise-disjoint strict children are:

```text
.tdx-measurement/raw/
.tdx-measurement/reports/
.tdx-measurement/generated/
```

`web/`, `scripts/`, `docs/`, `test/`, `public/`, configuration directories, and every other repository-local path are rejected as measurement roots. External absolute paths are allowed only when they are realpath-safe, pairwise disjoint, outside the repository, do not contain the repository, and are not a filesystem root.

Each execution creates a unique generated `run-*` child using `mkdtemp()`. Cleanup verifies the generated root, strict-child relationship, ownership marker, and per-run token before removing only that child.

## Strict raw TDX boundary

The candidate builder validates original JSON values without coercion:

- `Direction` must be the number `0`, `1`, or `2`.
- Coordinates must be finite numbers within longitude and latitude ranges.
- A direct Shape with any invalid coordinate is rejected as a whole.
- `StopSequence` must be a unique positive safe integer.
- Stops are ordered numerically by `StopSequence`.
- Missing, null, empty, and non-empty identities remain distinct contract states.
- Rejected records retain explicit reasons and aggregate rejection counts.

A malformed record is removed from matcher input, but a valid record on the opposite side remains in its one-sided partition.

# Complete workflow

The following commands assume the repository root as the working directory.

## 1. Configure credentials

Live raw fetch reads credentials only from the process environment or the ignored `.dev.vars` file. Never place a secret on the command line.

Environment example:

```sh
export TDX_CLIENT_ID='member-client-id'
export TDX_CLIENT_SECRET='member-client-secret'
```

Ignored `.dev.vars` example:

```dotenv
TDX_CLIENT_ID=member-client-id
TDX_CLIENT_SECRET=member-client-secret
```

Secret CLI flags such as `--client-id`, `--client-secret`, and `--token` are rejected. Token responses, Authorization headers, client IDs, secrets, credential fingerprints, raw response headers, and response bodies are excluded from reports and bounded public errors.

## 2. Fetch the verified nine-city plus InterCity raw cache

This command performs one credentialed uninstrumented run and atomically publishes the verified raw cache. It is shown for the later credentialed environment; do not run it in an environment that is not authorized to use TDX credentials.

```sh
npm run measure:shape-pattern -- \
  --cities Taipei,NewTaipei,Taoyuan,Keelung,Taichung,Tainan,Kaohsiung,Chiayi,MiaoliCounty \
  --include-intercity \
  --raw-dir .tdx-measurement/raw \
  --report-dir .tdx-measurement/reports \
  --generated-dir .tdx-measurement/generated \
  --warmup 1 \
  --iterations 1
```

City endpoints:

- `StopOfRoute/City/{City}`
- `Shape/City/{City}`

InterCity endpoints, fetched once per run:

- `StopOfRoute/InterCity`
- `Shape/InterCity`

Fetches use bounded concurrency, bounded retry, exponential backoff with jitter, `Retry-After`, an `AbortController` for request and body consumption, and a dedicated `worker_threads` JSON parser. The worker receives only the response text, an empty environment, and no credential, header, filesystem, or network input.

Each request creates one absolute monotonic deadline. The same deadline covers response-body consumption, Worker construction after the constructor returns, Worker startup, JSON parsing, and message delivery. A synchronous Worker constructor cannot itself be interrupted; immediately after it returns, the harness recalculates remaining time and rejects as timeout rather than accepting success when the deadline has expired. Public timeout settlement removes result listeners and rejects immediately. Worker termination proceeds separately and cannot delay or replace the timeout result; a termination error or termination timeout is observable only as a bounded cleanup record containing stage, classification, and operation ID.

The cache is assembled in a temporary sibling directory. Endpoint payloads and the manifest are written and verified before same-filesystem rename publishes `.tdx-measurement/raw`. Existing targets fail closed.

## 3. Run uninstrumented offline replay

Replay reads the verified manifest as the source of truth and does not access credentials or the network.

```sh
npm run measure:shape-pattern -- \
  --replay \
  --raw-dir .tdx-measurement/raw \
  --report-dir .tdx-measurement/reports \
  --generated-dir .tdx-measurement/generated \
  --warmup 2 \
  --iterations 5 \
  --top-outliers 20
```

The final stdout line contains the unique `runDir` and `runId`. Record both values. Uninstrumented `pairs.jsonl` is empty and `pairMetricsAvailable` is false.

Replay rejects:

- explicit CLI scope differing from the verified manifest;
- missing, duplicate, or extra endpoints;
- endpoint identity or filename mismatch;
- traversal, absolute filenames, symlinks, and non-regular files;
- endpoint content-hash mismatch; and
- bundle metadata or hash mismatch.

## 4. Obtain the matcher file SHA-256

The production revision has two different hashes:

- **Git blob SHA-1 pin:** `fc67cdecd785e89b9b08937edab156ade430198b`
- **file SHA-256 supplied to instrumented replay:** calculate this from the exact file bytes.

Do not pass the Git blob SHA-1 to `--matcher-sha`.

Linux:

```sh
MATCHER_SHA256="$(sha256sum src/domain/map/shape-pattern-matcher.ts | awk '{print $1}')"
printf '%s\n' "$MATCHER_SHA256"
```

Portable Node command, including Windows PowerShell:

```sh
node -e "const fs=require('node:fs');const c=require('node:crypto');console.log(c.createHash('sha256').update(fs.readFileSync('src/domain/map/shape-pattern-matcher.ts')).digest('hex'))"
```

## 5. Run instrumented offline replay

```sh
npm run measure:shape-pattern -- \
  --replay \
  --instrumented \
  --matcher-sha "$MATCHER_SHA256" \
  --raw-dir .tdx-measurement/raw \
  --report-dir .tdx-measurement/reports \
  --generated-dir .tdx-measurement/generated \
  --warmup 2 \
  --iterations 5 \
  --top-outliers 20
```

`--expected-matcher-sha256` remains a compatibility alias for `--matcher-sha`; do not pass both. Instrumented mode also verifies the pinned Git blob SHA-1 and every exact injection anchor. Source revision mismatch fails closed.

The temporary instrumented matcher copy emits synchronous observer events from production control flow, compares plain and instrumented semantic results, and is removed during generated-child cleanup. Production source and semantics are not modified.

Projection statuses are:

- `no-path`: no initial solve state exists;
- `frontier-empty`: a middle projection layer has no remaining frontier;
- `threshold-rejected`: final nodes existed but all failed distance thresholds;
- `success`;
- `throw`.

Every orientation emits one `orientation-start` and one `orientation-end`. Every projection emits one start and one end with finite non-negative duration.

## 6. Verify both published run directories

List immutable run directories without including temporary dot-prefixed directories:

```sh
find .tdx-measurement/reports -mindepth 1 -maxdepth 1 -type d ! -name '.*' -print | sort
```

Each successful run contains exactly six report files plus `completion.json`:

```text
metadata.json
partitions.jsonl
pairs.jsonl
outcomes.json
outliers.json
summary.json
completion.json
```

Verify each run with the formal reader:

```sh
npm run verify:shape-pattern-report -- .tdx-measurement/reports/<UNINSTRUMENTED_RUN_ID>
npm run verify:shape-pattern-report -- .tdx-measurement/reports/<INSTRUMENTED_RUN_ID>
```

The verifier checks all six byte hashes and then performs semantic validation and cross-file reconciliation. Its output includes:

- `runId` and mode;
- matcher file SHA-256;
- matcher Git blob SHA-1;
- `bundleContentHash`;
- selected cities and InterCity scope; and
- `deterministicContentHash`.

Confirm both modes report the same `bundleContentHash`, matcher revision, selected cities, and InterCity setting. Unique run IDs prevent one mode from overwriting the other.

Report validation re-derives:

- candidate membership per source-scoped partition;
- matrix capacity, compatible-edge count, and density;
- all summary distributions;
- all top-N outlier lists and deterministic tie ordering;
- global outcome accounting; and
- deterministic content hash.

Updating only `completion.json` byte hashes cannot make a stale deterministic report valid.

## 7. Confirm cleanup and inspect orphan temporary directories

A successful run must leave:

- `.tdx-measurement/raw/` intact;
- immutable run directories under `.tdx-measurement/reports/` intact; and
- no per-run `run-*` child under `.tdx-measurement/generated/`.

The temporary naming contracts are:

- raw-cache staging: `.tdx-measurement/raw.tmp-<random>`;
- report staging: `.tdx-measurement/reports/.<run-id>-<random>`;
- generated child: `.tdx-measurement/generated/run-<random>`.

Inspect without deleting anything on POSIX systems:

```sh
find .tdx-measurement/generated -mindepth 1 -maxdepth 1 -type d -name 'run-*' -print
find .tdx-measurement/reports -mindepth 1 -maxdepth 1 -type d -name '.*-*' -print
find .tdx-measurement -mindepth 1 -maxdepth 1 -type d -name 'raw.tmp-*' -print
git status --short
```

Windows PowerShell equivalents:

```powershell
Get-ChildItem .tdx-measurement/generated -Directory -Filter 'run-*'
Get-ChildItem .tdx-measurement/reports -Directory -Hidden | Where-Object Name -Like '.*-*'
Get-ChildItem .tdx-measurement -Directory -Filter 'raw.tmp-*'
git status --short
```

The report command cannot match a published run because published run IDs are not dot-prefixed. The generated command matches only owned `run-*` children within the generated root, and the raw command matches only `raw.tmp-*` siblings within `.tdx-measurement`.

A write or validation failure attempts to remove its temporary file or directory. If cleanup also fails, the primary error code is preserved and a bounded cleanup failure identifies the orphan by a root-relative leaf name. Raw cleanup messages, stacks, file contents, credentials, and arbitrary absolute paths are not attached. The harness does not claim that no partial artifact remains in that case.

Before manually deleting an orphan:

1. confirm no measurement process is active;
2. confirm the path is a strict child of the expected measurement root;
3. confirm it is dot-prefixed report staging, `raw.tmp-*`, or an owned generated `run-*` directory; and
4. delete only that verified child, never the raw, report, generated, or repository root.

## 8. Keep the production gate closed

After successful verification:

- sanitized fixture results still must not select a guard;
- merging the harness still does not prove production readiness;
- a credentialed nine-city plus InterCity measurement and review are still required;
- production PR 2 remains blocked; and
- production PR 3 must not start.

# Metric and transaction contracts

## Assignment timing

For every formal iteration:

```text
bestAssignmentTotalTimeMs = sum(all best-assignment solve durations in that iteration)
ambiguityProofTotalTimeMs = sum(all forced-match and forced-unmatched durations in that iteration)
```

The report takes the nearest-rank median across per-iteration totals. Warmups are excluded. Structural solve counts must be identical across formal iterations.

When no best solve runs, `bestAssignmentTimeMs` is null and `assignmentBestSolveCount` is zero. When no forced solve runs, `ambiguityProofTimeMs` is null and both forced solve counts are zero. Unavailable metrics are never invented as zero.

## Memory

Memory observations are process RSS and heap before, after, and delta. The harness does not claim forced garbage collection or an unobserved peak.

## Transactional publication

A canonical bounded run ID is validated before filesystem mutation. The report root and every temporary and final directory must be realpath-safe strict children. Reports are written to a temporary sibling, parsed, reconciled, hashed, completed by writing `completion.json` last, verified again, and published by same-filesystem rename. `EXDEV` fails closed; there is no copy fallback pretending to be atomic.

## Public errors

Collector callback errors are reduced to a bounded public error:

```text
code: MEASUREMENT_COLLECTOR_ERROR
message: Measurement collector failed.
stage: observer-callback
```

Raw callback messages, causes, stacks, payloads, identities, and credentials are not attached. If cleanup also fails, the primary code remains authoritative and only a bounded cleanup failure is added. Cleanup-only failures use `MEASUREMENT_CLEANUP_ERROR`.

# Tests

```sh
npm ci
npm run test:shape-pattern-measurement
npm run check
npm run build:map
git diff --check
git status --short
```

The focused measurement tests include absolute Worker deadline races, bounded termination cleanup observation, canonical verified-raw sanitized replay, atomic-write cleanup composition, and executable orphan-pattern guidance.

CI does not call live TDX, receive production TDX credentials, or upload raw payloads or real route-level reports.

This PR must remain Draft until the fourth narrow review is complete.
