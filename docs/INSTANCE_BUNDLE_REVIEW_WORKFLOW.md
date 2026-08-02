# Manual instance bundle review workflow

The `Review instance change bundle` GitHub Actions workflow turns one proposed `instance:update` change into uploaded, offline-verifiable review evidence. It is deliberately separate from apply, compile and deploy operations.

The workflow uses only `workflow_dispatch`. It has `contents: read` permission, does not install package lifecycle hooks, does not read repository secrets and does not contact Cloudflare.

## Inputs

### `confirmation`

Enter exactly:

```text
REVIEW
```

Any other value fails before the manifest is read.

### `config_path`

Choose one repository-relative JSON manifest:

```text
instance.json
instances/island.json
```

The workflow accepts only `instance.json` or regular JSON files inside `instances/`. Absolute paths, traversal, symbolic links, `.git`, `.generated` and `node_modules` are rejected.

### `changes_json`

Provide a JSON array containing the same change arguments that would normally follow `instance:update`:

```json
[
  "--worker-name",
  "island-v2",
  "--origin",
  "https://new-bus.example.com",
  "--add-city",
  "Kaohsiung"
]
```

The array is parsed directly by Node and is never evaluated by a shell. Unknown updater arguments still fail through the normal parser.

Workflow-control flags are not accepted inside `changes_json`, including:

```text
--config
--write
--output
--dry-run
--json
--github-summary
--help
--expect-hash
--expect-artifact-hash
--out-dir
```

The input is limited to 16 KiB, 64 arguments and 2 KiB per argument.

### `expected_bundle_hash`

This optional 64-character SHA-256 pins a proposal that was reviewed earlier. A mismatch fails before an artifact is written or uploaded.

Leave it empty for a first review. Copy the bundle hash from the job summary or artifact before a later confirmation run.

## Produced evidence

A successful run writes one isolated directory:

```text
.generated/review/workflow-<run-id>-<attempt>/
  bundle.json
  verification.json
  freshness.json
```

`bundle.json` is the complete self-contained artifact from `instance:bundle-artifact`.

`verification.json` records the result of immediately reopening that file and independently checking the source, baseline, target, proposal, migration, provisioning, doctor, bundle and artifact hashes.

`freshness.json` compares the verified artifact against the exact manifest bytes in the checked-out repository. The workflow succeeds only when the result is `fresh`; path, instance identity, source bytes and canonical baseline must all match.

The directory is uploaded as:

```text
instance-bundle-review-<instance-id>-<run-id>-<attempt>
```

Artifacts are retained for 14 days. The job summary includes:

- checked-out commit and ref
- manifest path
- proposal changes and warnings
- migration, provisioning and projected doctor results
- exact bundle SHA-256
- exact artifact SHA-256
- offline verification result
- source freshness result
- whether manifest apply is currently allowed
- whether deployment cutover is projected ready
- the separately reviewable `instance:update --write` apply command when freshness permits it

## Safety boundary

The workflow does not apply the proposal. In particular, it does not:

- write the source manifest
- run `instance:update --write`
- compile generated instance files
- run package installation lifecycle hooks
- invoke Wrangler
- inspect repository secret values
- contact Cloudflare or TDX
- create, update or delete remote resources
- push commits or alter pull requests

No repository secret is mapped into the job environment. The runner passes an empty environment into deterministic bundle construction so unrelated runner variables cannot become evidence.

GitHub checkout, job-summary writing and artifact upload are the only platform services used.

## Review sequence

```text
1. Dispatch with REVIEW, config_path and changes_json
2. Inspect the change table, warnings and projected plans
3. Confirm verification.json has no failed integrity checks
4. Confirm freshness.json reports fresh
5. Record the bundle and artifact hashes
6. Download all three JSON files when independent review is needed
7. Run instance:verify-bundle locally with both expected hashes
8. Run instance:check-bundle-freshness against the current checkout
9. Dispatch again with expected_bundle_hash when a pinned confirmation is useful
10. Apply later through the separately reviewed instance:update --write command
11. Compile and run the live instance doctor
12. Deploy only through the normal release process
```

Artifact verification proves that the uploaded review package is internally intact. Freshness proves that its reviewed baseline matched the workflow checkout when the evidence was created. Neither check proves that the proposal has been applied, compiled or deployed, and freshness does not lock the manifest against later changes.
