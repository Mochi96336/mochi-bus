# Instance bundle staleness gate

A saved change-bundle artifact proves what was reviewed. Before using its apply command, `instance:check-bundle-freshness` checks whether the repository manifest still has the exact source state that produced that artifact.

The command is read-only. It does not write the manifest, compile generated files, execute the reviewed apply command, invoke Wrangler or contact Cloudflare.

## Check one reviewed artifact

```sh
npm run instance:check-bundle-freshness -- \
  --input .generated/review/island-worker-cutover.json
```

The current manifest defaults to `bundle.instance.configPath` inside the artifact. It can be supplied explicitly only when it is the same repository-relative path:

```sh
npm run instance:check-bundle-freshness -- \
  --input .generated/review/island-worker-cutover.json \
  --config instances/island.json
```

Pin both review identities when the hashes came from a trusted review channel:

```sh
npm run instance:check-bundle-freshness -- \
  --input .generated/review/island-worker-cutover.json \
  --expect-hash <bundle-sha256> \
  --expect-artifact-hash <artifact-sha256>
```

## Results

### `fresh`

`fresh` means all of the following are true:

- the artifact passes its complete offline integrity verification
- optional expected bundle and artifact hashes match
- the current manifest path equals the reviewed config path
- the current instance ID equals the reviewed instance ID
- the current manifest has the exact UTF-8 source bytes stored in artifact evidence
- the canonical current manifest equals the reviewed baseline manifest

Only a fresh artifact with an effective proposal exposes the reviewed apply metadata in the report.

A fresh operator provisioning draft may still be written to the repository, but `deploymentReady` remains false until the separately projected resource and cutover blockers are resolved.

### `stale`

`stale` means the artifact is valid, but the current manifest no longer has the exact reviewed source state.

The report distinguishes:

- `formatting_drift`: canonical manifest content still equals the baseline, but bytes, indentation, key order or line endings changed
- `semantic_drift`: canonical content differs from both the reviewed baseline and target
- `already_applied`: the current manifest already equals the reviewed target, so the apply command must not run again

Formatting-only drift is intentionally stale. Repository writes use optimistic source-state checks, so review evidence must match exact source bytes rather than only equivalent parsed JSON.

### `blocked`

`blocked` means freshness cannot be trusted. Examples include:

- invalid or tampered artifact hashes
- expected hash mismatch
- unsafe or unreadable current manifest
- duplicate JSON keys
- path mismatch
- instance identity mismatch
- absolute paths, traversal or symlinked manifests

A blocked report never exposes apply eligibility.

## Machine-readable and GitHub output

```sh
npm run instance:check-bundle-freshness -- \
  --input review/bundle.json \
  --json
```

The JSON report contains:

```text
status                 fresh | stale | blocked
currentState           baseline | target | diverged | unavailable
staleKind              formatting_drift | semantic_drift | already_applied | null
applyAllowed
deploymentReady
source                  exact byte hash comparison
baseline                canonical baseline comparison
target                  current target comparison
proposal                reviewed preview/apply metadata
checks
errors
```

Append the same result to a GitHub job summary:

```sh
npm run instance:check-bundle-freshness -- \
  --input review/bundle.json \
  --github-summary
```

Fresh exits successfully. Stale or blocked prints the complete report and then exits nonzero so CI can act as a gate.

## Read safety

The command:

- reads artifacts through the existing strict 8 MiB artifact reader
- independently verifies every artifact integrity layer
- reads at most 1 MiB from the current manifest
- rejects duplicate JSON object keys
- opens files without following final symlinks where supported
- rejects `.git`, `.generated` and `node_modules` manifest paths
- verifies that the manifest parent resolves inside the repository
- compares file identity and size before and after reading
- performs no subprocess or network operation
- changes no file unless `--github-summary` explicitly appends a report

## Workflow evidence

The manual review workflow also performs this gate immediately after creating and verifying `bundle.json`. A successful run uploads:

```text
.generated/review/workflow-<run-id>-<attempt>/
  bundle.json
  verification.json
  freshness.json
```

`freshness.json` proves that the artifact source evidence matched the checked-out manifest when the review package was created. It does not prove the repository remained unchanged after the workflow ended.

## Apply the reviewed artifact

A standalone freshness check does not lock or write the manifest. The gate does not execute the apply command. Use `instance:apply-bundle` when the reviewed proposal should be committed to the repository:

```sh
npm run instance:apply-bundle -- \
  --input review/bundle.json \
  --expect-hash <bundle-sha256> \
  --expect-artifact-hash <artifact-sha256> \
  --write
```

The apply command requires both review hashes. It repeats the complete freshness verification, independently rechecks the critical source, baseline and target identities, prepares a same-directory temporary file, checks the source again immediately before atomic rename, and verifies the written target afterward.

See [Apply a reviewed instance bundle](./INSTANCE_BUNDLE_APPLY.md) for the lock, atomic-write and remaining race boundaries.

Recommended sequence:

```text
verify artifact hashes through the review channel
→ optionally inspect with instance:check-bundle-freshness
→ preview instance:apply-bundle
→ run instance:apply-bundle --write
→ validate or finish provisioning
→ compile
→ run the live doctor
→ deploy through the normal release process
```

Neither freshness nor apply compiles generated files or deploys remote resources.
