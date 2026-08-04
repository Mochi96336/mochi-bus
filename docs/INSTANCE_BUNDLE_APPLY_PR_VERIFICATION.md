# Verify a generated reviewed-bundle Draft PR

`instance:verify-apply-pr` performs a read-only, fail-closed verification of a Draft PR created by the reviewed bundle apply workflow. It connects the original review artifact, the atomic apply evidence, the live pull request, its single commit, both manifest blobs and the exact formal CI workflow observation into one merge-preparation report.

The verifier does not write the instance manifest, push a branch, edit the pull request, mark it ready, dispatch CI, merge, compile generated files, run Wrangler or contact Cloudflare.

## Manual workflow

Run **Verify reviewed instance bundle Draft PR** with:

```text
confirmation                     VERIFY
pull_request_number              generated reviewed-instance-bundle Draft PR number
apply_run_id                     successful apply-to-PR workflow run ID
artifact_name                    instance-bundle-apply-<instance>-<run>-<attempt>
expected_bundle_hash             exact reviewed bundle SHA-256
expected_artifact_hash           exact reviewed artifact SHA-256
expected_target_manifest_hash    exact reviewed target manifest SHA-256
```

Use values copied from trusted review and apply summaries. The apply artifact name must embed the same apply run ID supplied separately.

## Trust sequence

```text
validate immutable workflow inputs
→ download one exact apply artifact from one same-repository run
→ require the exact six persisted review/apply evidence files
→ independently verify the full bundle artifact and every trusted hash
→ validate verification.json, freshness.json, apply-result.json and provenance.json
→ regenerate pr-body.md and require byte-for-byte equality
→ expose only validated config, run and branch identities
→ bind review, apply and CI runs to exact workflow IDs and paths
→ collect PR, commit, manifest and exact formal CI data through read-only GitHub APIs
→ re-read immutable PR identity and reject relevant metadata changes during collection
→ sample mergeability separately from immutable identity
→ perform the final offline cross-check
→ upload the collected evidence and verification report
```

The GitHub API collection step receives the validated manifest path and run IDs as environment values. They are not interpolated into a shell command.

## Required PR shape

Verification is blocked unless all of the following remain true:

- the PR is open, unmerged and still Draft
- base and head repositories are the same repository
- the base branch equals the apply provenance base branch
- the current base SHA still equals the exact apply source SHA
- the head branch has the deterministic `agent/instance-bundle-apply-<run>-<attempt>` name
- the PR title and body equal the deterministic persisted versions
- the PR reports one commit and one changed file
- the only changed path is the reviewed manifest, with status `modified`
- the head commit has exactly the apply source SHA as its parent
- the commit message equals the deterministic apply message

A base branch advance is intentionally stale. Regenerate or rebase through the reviewed flow rather than accepting a PR whose original source identity no longer matches its current base.

The collector compares state, Draft state, merge state, title, body, base and head identities, counts and diff statistics before and after evidence collection. Mergeability is sampled after the immutable identity comparison because GitHub computes that field asynchronously; a `null` to `true` calculation is not treated as a PR edit.

## Manifest verification

The workflow fetches the manifest at the exact base and head commit SHAs.

The base manifest must:

- contain valid UTF-8 and strict JSON
- equal the exact source bytes stored in the review artifact
- match the reviewed source SHA-256
- match the canonical baseline manifest hash
- retain the reviewed instance ID

The head manifest must:

- contain valid UTF-8 and strict JSON
- retain the reviewed instance ID
- produce the exact trusted canonical target manifest SHA-256
- have the same blob identity reported by the PR file list

The verifier does not trust a patch excerpt as the source of truth. It reads the complete blobs at immutable commit SHAs.

## Workflow run verification

The apply run must be a successful `workflow_dispatch` run of the exact `.github/workflows/apply-instance-bundle-pr.yml` workflow on the exact base branch and source SHA.

The original review run must be a successful `workflow_dispatch` run of the exact `.github/workflows/review-instance-bundle.yml` workflow on the same source SHA. Its branch name may differ when multiple refs point to the same reviewed commit.

For both runs, the collector verifies the workflow ID and path plus the repository and head-repository identities before writing the run snapshot. A same-named workflow at another path is rejected.

## Formal CI observation

The collector queries the exact `.github/workflows/ci.yml` workflow and considers only runs whose workflow ID, workflow path, head branch and head SHA match the generated PR head. Unrelated GitHub App checks, legacy commit statuses and same-SHA checks from other workflows cannot satisfy readiness.

The newest matching CI run is projected into the offline evidence as:

```text
missing    no matching CI workflow run exists for the exact head SHA
pending    the matching CI workflow run has not completed
failed     the matching CI workflow run completed without conclusion success
success    the matching CI workflow run completed with conclusion success
```

Neutral, skipped, cancelled, timed-out or action-required workflow conclusions do not count as formal CI success.

Identity verification and CI readiness are separate:

- a PR can be `verified` while formal CI is `missing`
- `readyForReviewTransition` requires verified identity, GitHub mergeability and successful formal CI
- the workflow never dispatches CI or changes Draft state

A PR created with `GITHUB_TOKEN` may not automatically trigger `pull_request` workflows. When CI is missing, manually dispatch the existing `CI` workflow on the isolated apply branch, then run verification again.

## Output evidence

A successful or blocked verification preserves:

```text
.generated/verify-apply-pr/
  download/                  exact apply workflow artifact
  github/                    immutable API snapshots
    apply-run.json
    base-manifest.json
    checks.json
    commits.json
    files.json
    head-commit.json
    head-manifest.json
    pull-request.json
    review-run.json
  result/
    verification.json
```

`checks.json` records the trusted CI workflow ID and path, its derived state and the exact matching run snapshot when one exists.

The uploaded artifact is named:

```text
instance-bundle-apply-pr-verification-<pr>-<verification-run>-<attempt>
```

## Permissions and boundaries

The workflow grants only:

```yaml
permissions:
  actions: read
  contents: read
  pull-requests: read
```

It does not request any write, Checks API or commit-status permission. The only filesystem writes are generated evidence, `GITHUB_OUTPUT` and `GITHUB_STEP_SUMMARY` inside the ephemeral workflow workspace.

The offline runner imports no subprocess or network client. GitHub access is confined to the pinned read-only `actions/github-script` collection step.

## Remaining boundary

The report is a point-in-time observation. A human must still confirm that the PR head and base SHAs shown in the report remain current before changing Draft state or merging. Running the verifier again is the supported way to refresh that proof.
