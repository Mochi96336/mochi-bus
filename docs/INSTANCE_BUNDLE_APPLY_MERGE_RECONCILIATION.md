# Reconcile a merged reviewed instance bundle PR

`Reconcile merged reviewed instance bundle PR` is a manual, read-only post-merge boundary.

It starts only after a reviewed-bundle apply PR has been merged. The workflow reopens the original apply artifact, proves the merged PR is the exact reviewed one, proves the selected branch contains that merge, compares the reviewed head, merge commit and current branch manifest, compiles the current manifest into an isolated generated directory, and runs the local instance doctor against those isolated outputs.

It does not modify the manifest, branch or PR. It does not contact Cloudflare and does not claim deployment readiness.

## Inputs

Dispatch `.github/workflows/reconcile-instance-bundle-apply-merge.yml` from the branch into which the reviewed manifest PR was merged.

Provide:

```text
confirmation                     RECONCILE
pull_request_number              merged reviewed-bundle PR number
apply_run_id                     successful apply-to-PR workflow run ID
artifact_name                    instance-bundle-apply-<instance>-<run>-<attempt>
expected_bundle_hash             exact reviewed bundle SHA-256
expected_artifact_hash           exact reviewed artifact SHA-256
expected_target_manifest_hash    exact reviewed target manifest SHA-256
```

The workflow binds the artifact name to its embedded instance ID, apply run ID and attempt before download. The selected branch and exact `GITHUB_SHA` are also validated before any artifact or GitHub API data is trusted.

## Trust sequence

```text
validate immutable inputs and branch snapshot
→ download one exact apply artifact
→ verify the complete review and apply evidence
→ collect merged PR, branch, commit, ancestry and manifest snapshots
→ reject PR or branch movement during collection
→ compile the current manifest into an isolated generated directory
→ compare all generated files with the deterministic compiler
→ run the local doctor against those isolated files
→ persist reconciliation evidence
```

The original artifact is reused as evidence; no proposal is rebuilt from free-form update arguments.

## Merged PR proof

The selected PR must remain:

- closed and merged
- no longer Draft
- in the same repository
- based on the branch used to dispatch reconciliation
- headed by the deterministic `agent/instance-bundle-apply-<run>-<attempt>` branch
- exactly one reviewed commit
- exactly one modified reviewed manifest
- unchanged title and byte-identical deterministic PR body

The reviewed head commit must still have the original source SHA as its only parent and the fixed instance-derived commit message.

The merge commit may be a merge, squash or rebase result. Reconciliation does not infer the merge method from the commit shape. It instead requires the PR's recorded merge commit to be an ancestor of the exact dispatch branch SHA.

## Branch advancement

The dispatch branch may contain commits after the reviewed merge.

A branch comparison must report either:

```text
identical
```

or:

```text
ahead, behindBy = 0
```

The report records the number of commits after merge. Later commits are acceptable only when the reviewed manifest still has the same canonical target hash and exact manifest bytes.

A diverged branch, a branch behind the merge commit, or a branch that moves while evidence is collected is blocked.

## Manifest proof

The workflow reads complete manifest blobs from immutable SHAs rather than trusting patch excerpts.

It verifies three snapshots:

1. reviewed apply-PR head
2. recorded merge commit
3. exact current dispatch branch SHA

All three must:

- parse as strict UTF-8 JSON without duplicate keys
- use the reviewed manifest path
- retain the reviewed instance ID
- produce the exact trusted target manifest SHA-256

The merge manifest must have the exact manifest bytes from the reviewed head. The current branch manifest must preserve the exact merge bytes. Formatting-only edits therefore count as post-merge drift even when canonical JSON remains equivalent.

## Isolated generated evidence

The workflow runs the existing deterministic compiler with:

```text
--config <reviewed manifest>
--out-dir .generated/reconcile-apply-merge/compiled
```

The directory must contain exactly:

```text
instance-runtime.json
wrangler.instance.jsonc
operations-plan.json
```

Each file is reopened through bounded, no-follow reads and compared with the compiler's in-memory result. The report records both individual canonical hashes and a generated-set hash.

The isolated output is workflow evidence. It is not committed and does not replace the repository's normal generated directory.

## Local doctor

The existing instance doctor runs against the reviewed manifest and isolated generated directory with remote verification disabled.

Reconciliation requires the doctor to confirm:

- manifest validation and instance identity
- all three generated artifacts are current
- remote verification was not requested

Environment and operation checks may still be blocked when required local secrets or overrides are unavailable. This is reported separately rather than being confused with content drift.

## Result states

### `reconciled`

The artifact, merged PR, branch ancestry, exact manifest bytes, target hash, generated files and local doctor all agree.

Remote resources are still unverified and deployment readiness remains false.

### `locally_blocked`

The reviewed content, merge ancestry, exact manifest bytes and generated outputs agree, but the local doctor is blocked by environment or operation requirements.

This state preserves successful content reconciliation while requiring the doctor blockers to be resolved before any deployment decision.

### `blocked`

One or more authority checks failed. Examples include:

- wrong or tampered artifact hashes
- PR not merged or merged into a different branch
- additional PR file or commit
- changed deterministic PR body
- merge commit not in the selected branch ancestry
- branch movement during evidence collection
- canonical target mismatch
- exact manifest byte drift
- stale or tampered generated output
- doctor manifest or generated-artifact mismatch

A blocked result exits nonzero.

## Evidence

The workflow writes only beneath:

```text
.generated/reconcile-apply-merge/
  download/
  github/
  compiled/
  result/
    reconciliation.json
```

The uploaded reconciliation artifact retains GitHub snapshots, isolated generated files and the final machine-readable report for 30 days.

## Permissions and boundaries

The workflow uses only:

```yaml
permissions:
  actions: read
  contents: read
  pull-requests: read
```

It:

- does not update a branch
- does not modify or comment on a PR
- does not write the instance manifest
- does not run Wrangler
- does not dispatch CI
- does not read repository secrets
- does not contact Cloudflare
- does not provision D1, R2, rate-limit or Worker resources
- does not migrate D1 data or copy R2 objects
- does not deploy a Worker
- does not claim deployment readiness

After reconciliation, live doctor checks, provisioning validation and deployment remain separate explicit operations.
