# Instance change bundle

`instance:change-bundle` creates one review artifact for a proposed instance-manifest change.

It combines:

- the exact `instance:update` proposal
- the corresponding non-destructive migration plan
- a deterministic provisioning projection for the target manifest
- a projected doctor report describing what remains before the target can be ready
- SHA-256 digests that bind those sections together

```sh
npm run instance:change-bundle -- \
  --config instances/island.json \
  --worker-name island-v2 \
  --origin https://new-bus.example.com
```

The command does not write the manifest and does not contact Cloudflare. Human-readable output ends with:

```text
NO CHANGES WERE APPLIED
```

## Why this exists

`instance:update`, `instance:migration-plan`, `instance:provision-plan` and `instance:doctor` answer different questions:

- what JSON would change
- what remote migration work the change implies
- what resources, secrets and variables remain
- whether the applied and compiled instance is ready

Reviewing those commands separately can accidentally compare reports produced from different manifest revisions or different arguments. A change bundle records one canonical proposal fingerprint and hashes every derived section.

The migration planner derives its report from the same immutable updater proposal object. The bundle also verifies that the migration plan's canonical change fingerprint matches that shared proposal before producing output.

## Bundle contents

The JSON result contains:

```text
proposal
migrationPlan
provisioningPlan
doctor
hashes
consistency
```

`proposal.manifest` is the complete target manifest. It is an in-memory object only; the source file is not replaced.

`migrationPlan` is the same ordered prepare, remote-resource, cutover, verification and rollback report produced by `instance:migration-plan`.

`provisioningPlan` is projected directly from the target manifest. It does not check the current shell environment for secret values or contact Cloudflare, so identical inputs remain reproducible across developer machines and CI.

`doctor` is a projected doctor report. It validates the target manifest state, identifies operator provisioning blockers, marks generated artifacts and environment identity as not checked, and records that remote verification must occur after apply and compile.

A projected doctor is not evidence that the target is live. It exists to show which doctor sections will remain blocked or unverified immediately after the proposal is reviewed.

## Hashes

Every bundle includes:

- `sourceManifestHash` — exact UTF-8 bytes read from the source manifest
- `baselineManifestHash` — canonical JSON form of the current manifest
- `targetManifestHash` — canonical JSON form of the proposed manifest
- `proposalHash` — proposal changes, warnings, validation and manifest identities
- `migrationPlanHash` — complete migration plan
- `provisioningPlanHash` — complete deterministic provisioning projection
- `doctorHash` — complete projected doctor report
- `bundleHash` — the digest of all preceding review hashes

All hashes use lowercase SHA-256 hexadecimal output.

Canonical JSON hashing sorts object keys recursively while preserving array order. Formatting-only differences therefore affect `sourceManifestHash` but not `baselineManifestHash`. Changes to city order, operation order, target values, warnings or plan steps affect the corresponding canonical hash.

## Rebuild and verify

Record the `bundleHash` shown by the first review:

```text
Bundle SHA-256: 0123456789abcdef...
```

A later CI job or reviewer can rebuild the bundle and require an exact match:

```sh
npm run instance:change-bundle -- \
  --config instances/island.json \
  --worker-name island-v2 \
  --origin https://new-bus.example.com \
  --expect-hash 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
```

A mismatch fails before normal output:

```text
Change bundle hash mismatch: expected ..., received ...
```

`--expect-hash` accepts exactly 64 hexadecimal characters and is case-normalized.

The expected hash is not included in the bundle digest, so adding verification does not change the bundle being verified.

## Determinism boundary

The bundle hash depends on:

- exact source manifest bytes
- parsed target values
- updater warnings and validation results
- relative config and generated-output paths
- migration, provisioning and projected-doctor logic in the checked-out code

It intentionally does not depend on:

- current time
- random identifiers
- absolute checkout paths
- secret values
- whether a GitHub secret is currently injected
- live Cloudflare responses
- generated artifact timestamps
- network availability

A source manifest formatting change changes `sourceManifestHash` and therefore changes `bundleHash`, even when parsed JSON is identical. This makes the bundle sensitive to the exact reviewed source revision.

## Provisioning projection

The target provisioning projection covers:

- manifest validity or operator provisioning-draft blockers
- generated artifact compilation
- D1 ID presence and remote verification
- R2 bucket verification
- operator rate-limit namespace IDs
- Worker runtime TDX secrets
- repository secrets required by enabled operations
- `MOCHI_BUS_INSTANCE_CONFIG` for non-production manifests
- explicit origins required when `canonicalOrigin` is `request`
- final local and remote doctor checks

Secret requirements are reported as `verify`, not `complete`, because the bundle deliberately does not read secret values or environment-dependent existence.

Starter-only scalable R2 S3 credentials remain `optional`, matching the starter snapshot fallback boundary.

## Projected doctor

The projected doctor uses the target manifest and has these semantics:

- a valid target manifest is `ready`
- an operator provisioning draft is `blocked`
- generated runtime, Wrangler and operations artifacts are `not_checked`
- environment identity is `not_checked`
- enabled operations are `not_checked`, except operator deployment is blocked when required identities are absent
- disabled public probe or watchdog operations remain `disabled`
- remote resources are `not_checked`
- overall `ok` remains false until the proposal is actually applied, compiled and checked

After applying the reviewed proposal, run:

```sh
npm run instance:compile -- \
  --config instances/island.json \
  --out-dir .generated/instance

npm run instance:doctor -- \
  --config instances/island.json \
  --out-dir .generated/instance \
  --remote
```

The live doctor report, not the projection, is the deployment readiness authority.

## Operator provisioning drafts

A managed-to-operator proposal may be accepted by `instance:update` while D1 or rate-limit identities remain absent. The bundle reports:

- `provisioningDraft: true`
- `cutoverReady: false`
- blocked projected manifest readiness
- action-required D1 or rate-limit provisioning steps

The draft may still be deliberately written and committed for review. It must not be deployed until `instance:provision-plan` is complete and the live remote doctor passes.

## JSON output

```sh
npm run instance:change-bundle -- \
  --config instances/island.json \
  --add-city Kaohsiung \
  --json
```

The complete target manifest and all plans are printed, but source manifest bytes and credential values are not included.

## GitHub Actions summary

```sh
npm run instance:change-bundle -- \
  --config instances/island.json \
  --r2-name island-shapes-v2 \
  --github-summary
```

`--github-summary` appends a compact Markdown review to `GITHUB_STEP_SUMMARY` containing:

- bundle and target-manifest hashes
- proposal, migration, provisioning and doctor counts
- changed paths
- warnings
- preview, apply and expected-hash commands

The summary file is the only path this command may write.

## Generated output directory

Use `--out-dir` when the instance uses a non-default generated artifact directory:

```sh
npm run instance:change-bundle -- \
  --config instances/island.json \
  --out-dir .generated/island \
  --profile operator \
  --origin https://island.example.com
```

The relative output path is included in projected compile and doctor commands and therefore participates in the plan hashes.

## Safety boundary

The change bundle:

- starts no subprocess
- sends no network request
- does not invoke Wrangler
- does not write or replace the instance manifest
- does not compile generated artifacts
- does not create, rename, migrate or delete Worker, D1 or R2 resources
- does not change rate-limit namespaces
- does not change GitHub secrets, variables, workflows or schedules
- does not read credential values into the report
- writes only `GITHUB_STEP_SUMMARY` when explicitly requested

The apply command shown in the report is text for a reviewer. It is never executed by the bundle.
