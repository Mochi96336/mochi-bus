# Apply a reviewed instance bundle

`instance:apply-bundle` is the repository-write boundary for a persisted Mochi Bus instance change-bundle artifact.

It accepts only a saved artifact whose bundle SHA-256 and artifact SHA-256 are both supplied explicitly. It repeats the complete artifact verification and freshness checks, rebuilds the exact target manifest bytes using the current file's JSON formatting policy, rechecks the source immediately before replacement, and then uses an atomic rename.

The command changes only the selected instance manifest. It does not compile generated files, run Wrangler, provision Cloudflare resources, deploy a Worker, copy R2 objects, migrate D1 data or execute any command stored inside the artifact.

## Preview

```sh
npm run instance:apply-bundle -- \
  --input .generated/review/island-worker-cutover.json \
  --expect-hash <reviewed-bundle-sha256> \
  --expect-artifact-hash <reviewed-artifact-sha256>
```

Preview mode performs the same read, integrity and freshness validation as write mode. It prints:

- artifact and config paths
- instance identity
- bundle, artifact and target-manifest hashes
- reviewed field changes
- proposal warnings
- projected deployment readiness
- the exact command required to apply the artifact

It does not change any file.

## Apply

Add the explicit write flag:

```sh
npm run instance:apply-bundle -- \
  --input .generated/review/island-worker-cutover.json \
  --expect-hash <reviewed-bundle-sha256> \
  --expect-artifact-hash <reviewed-artifact-sha256> \
  --write
```

Both hashes are mandatory even when the artifact verifies internally. They bind the write to the exact review identities obtained through a trusted channel.

An optional config path may be supplied, but it must resolve to the same repository-relative path recorded in the artifact:

```sh
npm run instance:apply-bundle -- \
  --input review/bundle.json \
  --config instances/island.json \
  --expect-hash <reviewed-bundle-sha256> \
  --expect-artifact-hash <reviewed-artifact-sha256> \
  --write
```

## Required state

Apply is allowed only when all of the following remain true:

- the complete artifact integrity report passes
- the supplied bundle hash matches
- the supplied artifact hash matches
- the current config path matches the reviewed path
- the current `instanceId` matches the reviewed identity
- the current manifest has the exact reviewed UTF-8 source bytes
- the canonical current manifest equals the reviewed baseline hash
- the target manifest equals the reviewed target hash
- the artifact contains at least one effective change

The command refuses formatting-only drift, semantic drift, an already-applied target, a no-op artifact, an unsafe path, a symlink manifest, duplicate JSON keys or an unreadable current file.

## Write sequence

The write boundary uses this order:

```text
verify artifact and expected hashes
→ run the complete freshness gate
→ independently re-read artifact and current manifest
→ verify path, instance identity and all source/baseline/target hashes again
→ serialize the reviewed target with the current indentation, line ending and final-newline policy
→ acquire an exclusive <manifest>.apply.lock
→ verify exact source bytes and file identity
→ write a same-directory exclusive temporary file
→ fsync the temporary file
→ verify exact source bytes and file identity again
→ atomic rename over the manifest
→ reopen without following the final symlink
→ strictly parse and verify the target hash and instance identity
→ remove the apply lock
```

The apply lock serializes concurrent `instance:apply-bundle` writers for the same manifest. An existing lock is never removed by a process that did not create it.

The lock is intentionally fail-closed. If a previous process crashed and left a lock file, inspect the manifest, artifact and running processes before removing the stale lock manually.

## Race boundary

The source is checked after the replacement file is fully written and immediately before atomic rename. This prevents a stale preview from being committed and serializes official apply-bundle writers.

No portable Node filesystem API provides a compare-and-swap rename against arbitrary editors that ignore the apply lock. A separate process with direct filesystem access can still race in the tiny interval between the final check and rename. The command therefore also reopens and verifies the written target after replacement. Repository permissions should restrict direct writers around a reviewed apply operation.

## Result after write

A successful write does not imply that the instance is deployable.

- A valid starter, managed or fully provisioned operator manifest points next to `instance:validate`.
- An operator provisioning draft points next to `instance:provision-plan`.
- Compilation and deployment remain separate, explicit operations.

Recommended continuation:

```text
instance:apply-bundle --write
→ instance:validate or instance:provision-plan
→ instance:compile
→ instance:doctor --remote when credentials are intentionally available
→ normal deployment workflow
```

## Machine-readable output

```sh
npm run instance:apply-bundle -- \
  --input review/bundle.json \
  --expect-hash <reviewed-bundle-sha256> \
  --expect-artifact-hash <reviewed-artifact-sha256> \
  --json
```

The JSON result includes readiness, write status, hashes, reviewed changes, warnings, deployment projection and the complete freshness report. It deliberately omits the internal source bytes, target bytes, file identity and temporary-write state.

A blocked plan is printed before the command exits nonzero. A ready preview exits successfully without writing. A successful `--write` exits successfully only after post-write verification passes.

## Apply through an isolated Draft PR

Repository operators can use the manual `Apply reviewed instance bundle to Draft PR` workflow instead of writing a local checkout directly.

The workflow downloads one exact review artifact from one same-repository review run, requires both trusted hashes, invokes this same atomic apply boundary, preserves apply evidence, verifies that exactly one manifest changed, and pushes only a deterministic isolated branch before opening a Draft PR.

It does not compile or deploy, and a workflow-created PR is not a claim that formal repository CI ran. See [Apply a reviewed instance bundle to a Draft PR](./INSTANCE_BUNDLE_APPLY_PR_WORKFLOW.md) for the complete trust, Git, evidence and CI boundaries.
