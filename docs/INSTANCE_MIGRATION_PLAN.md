# Instance migration plan

`instance:migration-plan` turns a proposed `instance:update` operation into a non-destructive migration, verification and rollback checklist.

It reuses the updater proposal directly. City validation, default-city protection, demo-query protection, profile defaults, operator provisioning-draft handling and schema validation therefore remain identical to `instance:update`.

```sh
npm run instance:migration-plan -- \
  --config instances/island.json \
  --worker-name island-v2 \
  --origin https://new-bus.example.com
```

The planner does not write the manifest and does not contact Cloudflare. Every human-readable report ends with:

```text
NO CHANGES WERE APPLIED
```

## What the report contains

The report separates work into five operational phases:

1. **prepare** — record the current repository and deployment baseline
2. **remote-resources** — prepare Worker, D1, R2, rate-limit, city snapshot and scheduled-operation changes
3. **cutover** — apply the exact reviewed manifest proposal
4. **verify** — validate generated artifacts and live behavior
5. **rollback** — restore the previous manifest and remote bindings if verification fails

Each step has one status:

| Status | Meaning |
| --- | --- |
| `blocked` | deployment cutover must not proceed |
| `action_required` | a local or remote operator action remains |
| `verify` | an identity or behavior must be independently confirmed |
| `complete` | the planner found no remaining work for the step |
| `not_applicable` | the proposal does not affect that area |

A `blocked` operator provisioning draft means **deployment cutover is blocked**. It does not prevent the maintainer from deliberately writing and committing the draft with `instance:update --write` so that `instance:provision-plan` can guide resource creation. The draft must not be deployed until its D1 and rate-limit identities are complete.

## Preview and apply commands

The plan reconstructs both commands from the same parsed updater options:

```text
Preview: npm run instance:update -- ...
Apply after review: npm run instance:update -- ... --write
```

Output-only flags such as `--json` and `--github-summary` are not copied into those commands.

The planner itself rejects `--write`:

```sh
npm run instance:migration-plan -- \
  --config instances/island.json \
  --site-name "Island Transit" \
  --write
```

```text
instance:migration-plan is non-destructive and does not accept --write
```

## Repository-only changes

A site-name-only proposal does not manufacture Cloudflare work:

```sh
npm run instance:migration-plan -- \
  --config instances/island.json \
  --site-name "Island Transit"
```

Worker, D1, R2, rate-limit and transit-snapshot steps remain `not_applicable`. The plan still asks for manifest validation, compilation and repository checks after the change.

## Worker and origin migration

```sh
npm run instance:migration-plan -- \
  --config instances/island.json \
  --worker-name island-v2 \
  --origin https://new-bus.example.com \
  --workers-dev false
```

The plan treats Worker identity or canonical-origin changes as high risk because editing JSON does not:

- deploy the new Worker
- create or bind a custom domain
- move DNS or Worker routes
- verify public traffic
- preserve the previous route automatically

The checklist requires the target Worker to be deployed and verified before traffic moves. The rollback section restores the previous Worker and canonical origin.

## D1 migration

Changing only the D1 display name while preserving the ID requires read-only verification:

```sh
npm run instance:migration-plan -- \
  --config instances/operator.json \
  --d1-name island-data-label
```

The plan asks `instance:doctor --remote` to confirm that the preserved ID resolves to the intended database.

Changing the D1 ID is treated as a data migration:

```sh
npm run instance:migration-plan -- \
  --config instances/operator.json \
  --d1-name island-transit-v2 \
  --database-id 223e4567-e89b-42d3-a456-426614174111
```

The report requires:

- target schema migrations
- production-data copy or rebuild
- critical row-count comparison
- read-only application probes
- retention of the previous database during the rollback window

Clearing an active D1 ID produces a blocker until a deliberate target is selected.

## R2 migration

```sh
npm run instance:migration-plan -- \
  --config instances/operator.json \
  --r2-name island-shapes-v2
```

An R2 bucket name change is always explicit migration work. The planner never claims that changing the manifest renamed a bucket or copied objects.

The checklist requires:

- target bucket creation or verification
- object and metadata copy
- object-count and representative checksum comparison
- public-read verification
- source-bucket retention for rollback

## Rate-limit identities

```sh
npm run instance:migration-plan -- \
  --config instances/operator.json \
  --standard-rate-limit-id 42001 \
  --expensive-rate-limit-id 42002
```

The plan requires both target IDs to exist, remain distinct and retain the intended standard/expensive limits. Removing an ID from an operator target blocks deployment cutover.

## City scope and snapshot data

```sh
npm run instance:migration-plan -- \
  --config instances/island.json \
  --add-city Kaohsiung \
  --remove-city Tainan
```

Added cities require snapshots to be seeded and verified before support is advertised. Removed cities require an explicit D1/R2 retention policy before data cleanup.

The updater still enforces its original safety rules:

- removing the default city requires `--default-city`
- removing the demo-query city requires `--clear-demo-query`
- the final city set cannot be empty
- unsupported city codes fail before a plan is built

## Profile and operation changes

```sh
npm run instance:migration-plan -- \
  --config instances/island.json \
  --profile operator \
  --origin https://operator.example.com
```

A profile change reapplies the target profile defaults through `instance:update`. The migration plan then asks the maintainer to review:

- enabled snapshot and verification workflows
- required GitHub secrets and repository variables
- schedule activation or shutdown
- overlapping old/new snapshot publishers
- operator D1 and rate-limit readiness

When the target still lacks operator IDs, the report marks operator readiness and deployment cutover as blocked and points to:

```sh
npm run instance:provision-plan -- --config instances/island.json
```

## Verification sequence

Repository-only proposals use:

```sh
npm run instance:validate -- --config instances/island.json
npm run instance:compile -- --config instances/island.json
npm run check
```

Proposals with remote impact additionally use:

```sh
npm run instance:doctor -- --config instances/island.json --remote
```

The operator should then run the enabled release smoke, public probe and representative city queries before closing the rollback window.

## Rollback planning

Every effective proposal includes a rollback section. Depending on the changed fields, it can require:

- restoring the previous manifest revision
- regenerating instance artifacts
- redeploying or routing traffic to the previous Worker
- rebinding the previous D1 database
- rebinding the previous R2 bucket
- restoring previous rate-limit namespace IDs
- restoring workflow schedules and operation flags

Previous remote resources should not be deleted until live verification passes and the rollback window has expired.

## JSON output

```sh
npm run instance:migration-plan -- \
  --config instances/island.json \
  --r2-name island-shapes-v2 \
  --json
```

The result includes:

- `nonDestructive`
- `cutoverReady`
- `provisioningDraft`
- overall `risk`
- before/after JSON-path changes
- repeatable preview and apply commands
- status counts
- ordered migration and rollback steps

It does not include Cloudflare, TDX or R2 credential values.

## GitHub Actions summary

A workflow may append the Markdown report to the job summary:

```sh
npm run instance:migration-plan -- \
  --config instances/island.json \
  --worker-name island-v2 \
  --github-summary
```

`--github-summary` requires `GITHUB_STEP_SUMMARY`. It only appends the report; it does not write the manifest or modify repository settings.

## Safety boundary

The migration planner:

- starts no subprocess
- sends no network request
- does not invoke Wrangler
- does not create, rename or delete a Worker
- does not create, migrate or delete D1 data
- does not create, copy or delete R2 objects
- does not change rate-limit namespaces
- does not change GitHub secrets, variables, schedules or settings
- does not write the instance manifest

Only the optional GitHub job-summary file is appended when `--github-summary` is explicitly requested.
