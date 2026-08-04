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
- the current manifest contains valid UTF-8 and has the exact source bytes stored in artifact evidence
- the canonical current manifest equals the reviewed baseline manifest

Only a fresh artifact with an effective proposal exposes the reviewed `instance:update --write` command in the report.

`applyAllowed` describes only whether this exact reviewed command may still be applied. `projectedCutoverReady` independently reports whether the reviewed target had no known migration blocker and was not an operator provisioning draft. It is a deterministic projection, not proof that generated files, the environment or remote resources are ready.

### `stale`

`stale` means the artifact is valid, but the current manifest no longer has the exact reviewed source state.

The report distinguishes:

- `formatting_drift`: canonical manifest content still equals the baseline, but bytes, indentation, key order or line endings changed
- `semantic_drift`: canonical content differs from both the reviewed baseline and target
- `already_applied`: an effective proposal's target is already present, so the apply command must not run again

A no-op proposal whose bytes later change remains `formatting_drift`; matching identical baseline and target hashes alone does not imply that anything was applied.

Formatting-only drift is intentionally stale. The existing updater uses optimistic source-state checks, so review evidence must match exact source bytes rather than only equivalent parsed JSON.

### `blocked`

`blocked` means freshness cannot be trusted. Examples include:

- invalid or tampered artifact hashes
- expected hash mismatch
- unsafe, unreadable or invalid-UTF-8 current manifest
- duplicate JSON keys
- path mismatch
- instance identity mismatch
- absolute paths, traversal or symlinked manifests
- manifest path replacement while the file is being opened or read

A blocked report never exposes the apply command.

## Machine-readable and GitHub output

```sh
npm run instance:check-bundle-freshness -- \
  --input review/bundle.json \
  --json
```

The JSON report contains:

```text
status                   fresh | stale | blocked
currentState             baseline | target | diverged | unavailable
staleKind                formatting_drift | semantic_drift | already_applied | null
applyAllowed
projectedCutoverReady
source                    exact byte hash comparison
baseline                  canonical baseline comparison
target                    current target comparison
proposal                  reviewed preview/apply metadata
checks
errors
```

Append the same result to a GitHub job summary:

```sh
npm run instance:check-bundle-freshness -- \
  --input review/bundle.json \
  --github-summary
```

Operator-controlled paths, identities, commands and errors are rendered with dynamically sized Markdown code spans so embedded backticks remain inert.

Fresh exits successfully. Stale or blocked prints the complete report and then exits nonzero so CI can act as a gate.

## Read safety

The command:

- reads artifacts through the existing strict 8 MiB artifact reader
- independently verifies every artifact integrity layer
- reads at most 1 MiB from the current manifest
- rejects invalid UTF-8 and duplicate JSON object keys
- rejects final symlinks with `lstat` on every platform and also uses no-follow opens where supported
- rejects `.git`, `.generated` and `node_modules` manifest paths
- verifies that the manifest parent resolves inside the repository
- compares the path identity with the opened handle before and after reading
- rejects atomic path replacement as well as in-place changes observed during the read
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

## Important race boundary

The reader detects replacement or mutation observed while it opens and reads the manifest, but a freshness check does not lock the path. Another process can still change the file after the final identity check and before a human runs the reviewed command.

Recommended sequence:

```text
verify artifact hashes
→ check freshness
→ inspect the reviewed apply command
→ run the updater separately
→ compile
→ run the live doctor
→ deploy through the normal release process
```

The gate does not execute the apply command and does not provide an atomic apply operation. A future apply-from-artifact command would need to repeat the source hash and path-identity checks and perform the write in one operation.
