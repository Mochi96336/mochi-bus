# Apply a reviewed instance bundle to a Draft PR

`Apply reviewed instance bundle to Draft PR` is a manual `workflow_dispatch` boundary that turns one previously reviewed instance change-bundle artifact into an isolated Draft PR.

It does not rebuild the proposal from free-form arguments. It downloads the exact artifact produced by `Review instance change bundle`, requires both trusted review hashes, repeats the complete atomic apply verification, and permits Git to commit exactly one manifest path.

The workflow changes repository content only on a new `agent/instance-bundle-apply-<run-id>-<attempt>` branch. It does not directly update the selected source branch.

## Inputs

Dispatch `.github/workflows/apply-instance-bundle-pr.yml` from the branch that should become the Draft PR base.

The review artifact must come from `.github/workflows/review-instance-bundle.yml`.

The workflow reads the selected review run through the GitHub Actions API and binds its exact run attempt to the artifact name.

Provide:

```text
confirmation             APPLY
review_run_id            successful Review instance change bundle run ID
artifact_name            exact instance-bundle-review-<instance>-<run>-<attempt> name
expected_bundle_hash     exact reviewed bundle SHA-256
expected_artifact_hash   exact reviewed artifact SHA-256
```

The artifact name is not only a download selector. The runner parses its instance ID, review run ID and review attempt, then requires its embedded run ID to equal `review_run_id` before any download begins.

Both hashes must come from a trusted review channel. Internal artifact hashes alone are not sufficient authorization for a repository write.

## Preflight and download

The first runner invocation validates:

- exact `APPLY` confirmation
- decimal review and workflow run identities
- lowercase SHA-256 hashes
- same-repository identity
- branch-only dispatch ref
- safe base and generated branch names
- exact review-artifact naming convention

Only validated outputs are passed to the pinned `actions/download-artifact` action. The action downloads one named artifact from one run in the current repository and treats an artifact digest mismatch as an error.

The extracted directory must contain exactly:

```text
.generated/apply-input/
  bundle.json
  verification.json
  freshness.json
```

Extra entries, missing entries, directories and symbolic links are rejected.

## Persisted evidence checks

Before invoking the atomic writer, the runner independently reads the two persisted reports with strict duplicate-key rejection and a 1 MiB bound per report.

`verification.json` must prove:

- schema version 1
- successful complete artifact verification
- zero failed checks and zero errors
- exact trusted bundle and artifact hashes
- both expected hashes were pinned during review
- instance identity matches the artifact name

`freshness.json` must prove:

- schema version 1 and `fresh`
- current state was the reviewed baseline
- no staleness classification
- exact source and canonical baseline matches
- target was not already present
- an effective apply was allowed
- zero failed checks and zero errors
- exact trusted hashes and instance identity

These saved reports are evidence, not the final authority. The workflow then runs the current `instance:apply-bundle` implementation, which reopens the artifact and manifest and repeats hash, path, identity, freshness and source-byte validation immediately around the atomic write.

## Atomic apply and post-write verification

The runner calls the same `buildInstanceBundleApply` and `writeInstanceBundleApply` boundary used by the local CLI.

Before writing, it cross-checks the newly built plan against the persisted review evidence:

- bundle and artifact hashes
- instance identity
- manifest path
- target manifest hash
- effective change count

After the atomic writer returns, it reopens the manifest and requires:

- the same repository-relative path
- the same `instanceId`
- exact prepared target bytes
- the reviewed canonical target hash

Only then does it create generated evidence for the apply workflow.

## Evidence preservation

Before any Git commit or push, the workflow uploads:

```text
.generated/apply-input/
  bundle.json
  verification.json
  freshness.json

.generated/apply-pr/workflow-<run-id>-<attempt>/
  apply-result.json
  provenance.json
  pr-body.md
```

This ordering preserves audit evidence even when a later Git push or PR API call fails.

`provenance.json` records the repository, review run, artifact name, trusted hashes, source ref and SHA, generated branch, manifest path, instance identity, reviewed change paths, and projected readiness flags. It contains no credentials or manifest source bytes.

## Single-file Git boundary

The shell step starts only after evidence upload. It requires checkout `HEAD` to remain the workflow's original `GITHUB_SHA` and examines NUL-delimited porcelain output.

Outside ignored `.generated` evidence, the working tree must contain exactly one record:

```text
 M <reviewed-manifest-path>
```

The step then:

1. checks the manifest diff for whitespace errors
2. creates the deterministic isolated branch
3. stages only the exact reviewed manifest path
4. verifies the staged file list is exactly one manifest
5. rejects an empty staged diff
6. commits with a fixed instance-derived message
7. pushes only the isolated branch

It never uses `git add -A` or stages the repository root.

## Draft PR boundary

The workflow opens a Draft PR against the branch selected when dispatching the workflow.

The PR title is fixed from the validated instance ID. The PR body is generated by the runner and records review, repository and target identities. Artifact warnings and change paths are rendered as indented inert evidence so they cannot inject headings, lists or workflow instructions into the PR description.

The workflow does not merge the PR, mark it ready, change the base branch after creation, or write directly to the base branch.

## CI boundary

Creating a Draft PR is not proof that repository CI ran.

GitHub generally suppresses new workflow runs caused by events created with the repository `GITHUB_TOKEN`. Therefore this workflow does not claim that PR CI passed. The generated PR body states that formal CI is separate.

When formal checks are required, dispatch the existing `CI` workflow on the generated apply branch, or use the repository's normal reviewed mechanism to trigger its `pull_request` checks.

The apply-to-PR workflow itself verifies artifact integrity, exact manifest freshness, the atomic write, the post-write target, and the exactly one manifest Git diff. Those checks do not replace the full CI workflow.

## Read-only verification

After the workflow creates the Draft PR, run `instance:verify-apply-pr` through **Verify reviewed instance bundle Draft PR**. It rechecks the persisted review/apply evidence against the live PR, current base and head SHAs, single commit, single modified manifest, complete base/head blobs and formal CI observations.

The verification workflow never edits the PR or repository. See [Verify a generated reviewed-bundle Draft PR](./INSTANCE_BUNDLE_APPLY_PR_VERIFICATION.md).

## Operational boundaries

The workflow:

- does not install dependencies
- does not compile generated instance files
- does not run Wrangler
- does not read repository secrets
- does not contact Cloudflare
- does not provision D1, R2, rate-limit or Worker resources
- does not migrate D1 data or copy R2 objects
- does not deploy a Worker
- does not execute commands stored inside the artifact
- does not claim deployment readiness from a successful manifest write

After the Draft PR receives normal review and CI, provisioning, compilation, live doctor checks and deployment remain separate explicit operations.
