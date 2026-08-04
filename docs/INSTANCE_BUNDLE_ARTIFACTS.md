# Instance change-bundle artifacts

`instance:change-bundle` previews one deterministic instance update together with its migration, provisioning and doctor projections. The artifact commands persist that review result and verify it later without rebuilding the proposal or reading the repository manifest.

## Create a review artifact

Choose an explicit output path and repeat the same change arguments used for `instance:change-bundle`:

```sh
npm run instance:bundle-artifact -- \
  --config instances/island.json \
  --worker-name island-v2 \
  --origin https://new-bus.example.com \
  --output .generated/review/island-worker-cutover.json
```

The command creates one JSON file and prints both identifiers:

- **Bundle SHA-256** identifies the reviewed change, plans and projected readiness.
- **Artifact SHA-256** identifies the complete self-contained file, including the evidence needed to recompute the bundle hashes offline.

The source manifest, generated instance files and remote resources are not changed.

### Preview without writing

```sh
npm run instance:bundle-artifact -- \
  --config instances/island.json \
  --add-city Kaohsiung \
  --dry-run
```

Dry-run prints the complete artifact JSON to stdout. It does not choose or create an output path.

### Require an already reviewed bundle

```sh
npm run instance:bundle-artifact -- \
  --config instances/island.json \
  --worker-name island-v2 \
  --expect-hash <reviewed-bundle-sha256> \
  --output .generated/review/island-worker-cutover.json
```

A mismatch fails before the artifact file is created.

## Offline verification

```sh
npm run instance:verify-bundle -- \
  --input .generated/review/island-worker-cutover.json
```

Pin both review identifiers when moving the artifact between CI jobs or reviewers:

```sh
npm run instance:verify-bundle -- \
  --input .generated/review/island-worker-cutover.json \
  --expect-hash <reviewed-bundle-sha256> \
  --expect-artifact-hash <reviewed-artifact-sha256>
```

Verification requires only the artifact file. The original repository, source manifest, generated files, Cloudflare account and credentials are not consulted.

The verifier independently recomputes:

1. exact source manifest bytes
2. canonical baseline manifest
3. canonical target manifest
4. updater proposal
5. migration plan
6. provisioning projection
7. doctor projection
8. bundle digest
9. complete artifact digest

It also confirms that the updater and migration plan describe the same canonical proposal and that the baseline, target and bundle instance identities agree.

## Artifact contents

The artifact is intentionally self-contained:

```text
artifactSchemaVersion
kind
bundle
  proposal
  migrationPlan
  provisioningPlan
  doctor
  hashes
evidence
  sourceManifest       exact UTF-8 source bytes
  baselineManifest     parsed manifest before the proposal
integrity
  algorithm
  artifactHash
```

The target manifest is already stored in `bundle.proposal.manifest`. The two evidence fields supply the information that a normal terminal bundle does not need to print but an offline verifier needs to recompute every digest.

No credential value is included. Secret requirements remain verification instructions only.

## File safety

Artifact creation is deliberately narrower than manifest writing:

- `--output` is required unless `--dry-run` is used.
- output must stay inside the current working directory and use `.json`
- `.git`, `node_modules`, the selected source manifest and generated runtime filenames are rejected
- parent directories may be created
- the completed temporary file is linked into place atomically
- an existing artifact is never overwritten
- there is no `--force`

Offline verification:

- opens a regular file without following symlinks on supported platforms
- reads at most 8 MiB
- rejects empty or changing files
- validates JSON syntax before parsing
- rejects duplicate object keys, including equivalent escaped keys
- performs no subprocess or network operation
- changes no file unless `--github-summary` explicitly appends a verification summary

## GitHub Actions summary

```sh
npm run instance:verify-bundle -- \
  --input .generated/review/island-worker-cutover.json \
  --github-summary
```

The summary reports verification status and both hashes. The artifact itself is not modified.

## Recommended review sequence

```text
instance:update preview
→ instance:change-bundle review
→ instance:bundle-artifact --expect-hash ...
→ transfer or upload artifact
→ instance:verify-bundle with both expected hashes
→ apply only through the separately reviewed instance:update --write command
→ compile and run the live instance doctor
```

Artifact verification proves that the saved review package is internally intact. It does not prove that the proposal has been applied, compiled or deployed, and it never substitutes projected readiness for a live doctor run.
