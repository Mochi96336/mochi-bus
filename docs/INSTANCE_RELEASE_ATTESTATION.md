# Gate a reconciled instance release

`Gate reconciled instance release` converts one successful post-merge reconciliation into a portable release-content attestation.

The attestation binds the reviewed bundle lineage, exact release branch and commit SHA, exact manifest bytes, canonical target manifest hash and deterministic generated-set hash. It is then reopened and verified against the same checkout before the workflow uploads it.

This is a content identity gate. It does not contact Cloudflare and does not authorize deployment by itself.

## Manual and reusable workflow

The workflow supports both:

```text
workflow_dispatch
workflow_call
```

A future deployment workflow can call it as a reusable read-only gate. Until a deployment workflow is explicitly wired to consume the gate output, running it manually only creates evidence.

Required inputs:

```text
confirmation                     ATTEST
reconciliation_run_id            successful merge-reconciliation workflow run ID
reconciliation_artifact_name     instance-bundle-merge-reconciliation-<instance>-<run>-<attempt>
expected_release_sha             exact 40-character workflow release SHA
expected_bundle_hash             exact reviewed bundle SHA-256
expected_artifact_hash           exact reviewed bundle artifact SHA-256
expected_target_manifest_hash    exact reconciled target manifest SHA-256
expected_generated_set_hash      exact reconciled generated-set SHA-256
```

Dispatch from the exact branch and commit intended for the release. `expected_release_sha` must equal `GITHUB_SHA`; the workflow rejects a branch name or tag that resolves to another commit.

## Trust sequence

```text
validate exact inputs and release SHA
→ download one exact reconciliation artifact from one run
→ re-read the live release branch and require it to remain at the release SHA
→ verify reconciliation workflow identity and successful conclusion
→ require reconciliation status = reconciled
→ require contentReconciled and localDoctorReady
→ require remoteVerified = false and deploymentReady = false
→ compare trusted bundle, artifact, manifest and generated-set hashes
→ compare exact checkout manifest bytes with reconciliation current-manifest evidence
→ recreate deterministic runtime, Wrangler and operations identities
→ create release-attestation.json with an integrity hash
→ reopen the attestation and verify it against the checkout
→ upload the result evidence
```

The reconciliation artifact name embeds the same instance ID, run ID and run attempt supplied independently. A mismatched name is rejected before download.

## Accepted reconciliation state

Only this state may produce an attestation:

```text
status: reconciled
ok: true
contentReconciled: true
localDoctorReady: true
remoteVerified: false
deploymentReady: false
summary.failed: 0
```

`locally_blocked` is intentionally rejected. Content may be reconciled in that state, but a release gate cannot claim the local doctor was ready.

A reconciliation artifact from a failed, cancelled, pending or differently named workflow run is also rejected.

## Release branch snapshot

The gate reads the live branch before and after collecting workflow-run evidence.

Both reads must equal:

```text
<release branch>@<expected release SHA>
```

A release branch that advances during the gate is blocked. Re-run reconciliation and the release gate on the new SHA rather than reusing evidence for an older branch snapshot.

## Manifest and generated proof

The gate reopens:

```text
reconciliation/github/current-manifest.json
reconciliation/compiled/instance-runtime.json
reconciliation/compiled/wrangler.instance.jsonc
reconciliation/compiled/operations-plan.json
reconciliation/result/reconciliation.json
```

The current repository manifest must be byte-identical to the reconciled `current-manifest.json` snapshot. Canonically equivalent formatting changes are not accepted.

The current manifest is compiled again in memory. The downloaded generated files must match deterministic compiler output and the following hashes from reconciliation:

```text
runtimeHash
wranglerHash
operationsHash
generatedSetHash
```

The Wrangler comparison recreates the original reconciliation output location virtually, so rebased project paths remain deterministic even though the evidence was downloaded under another directory.

## Attestation structure

A successful gate writes:

```text
.generated/release-attestation/result/
  gate-evaluation.json
  release-attestation.json
  release-verification.json
```

The attestation contains:

```text
release repository, branch and SHA
instance ID and manifest path
canonical manifest hash
exact manifest-source hash and source bytes
generated-set and individual generated hashes
review, apply, reconciliation and gate provenance
trusted bundle/artifact/manifest/generated hashes
explicit operational boundary
SHA-256 integrity hash
```

The integrity hash covers the complete attestation payload except the `integrity` object itself.

## Verification

The workflow immediately runs:

```text
npm run instance:release-attestation -- --verify
```

Verification requires the exact attestation hash emitted by the creation step. It then checks:

- strict JSON and exact supported object keys
- recomputed attestation integrity hash
- trusted attestation hash
- exact repository, branch and release SHA
- reconciliation run, attempt and artifact identity
- exact current manifest bytes
- canonical current manifest hash
- deterministic current runtime, Wrangler and operations hashes
- generated-set hash
- the content-only operational boundary

A future deployment workflow must obtain the expected attestation hash through a trusted review or release channel. A SHA-256 hash proves integrity, not signer identity or organizational approval.

## Workflow outputs

A successful reusable call exposes:

```text
release_content_gate_passed = true
attestation_hash
attestation_artifact_name
```

Even after success, the persisted evidence always states:

```text
remoteVerified: false
deploymentReady: false
authorizes: release-content-gate-only
```

## Permissions and boundaries

The workflow grants only:

```yaml
permissions:
  actions: read
  contents: read
```

It does not:

- update a branch or tag
- modify or comment on a pull request
- dispatch another workflow
- read repository secrets
- write the instance manifest
- run Wrangler
- contact Cloudflare
- verify live D1, R2, rate-limit or Worker resources
- migrate D1 data
- copy R2 objects
- deploy a Worker
- claim deployment readiness

All filesystem writes stay under:

```text
.generated/release-attestation/
```

## Deployment integration boundary

A deployment job may later require a successful reusable gate output before its remote preflight and deploy steps. That integration must still separately enforce:

1. live environment and secret presence
2. remote Cloudflare resource identity
3. deployment authorization and environment protection
4. exact deploy SHA
5. post-deploy smoke and observability checks

The release attestation removes content ambiguity; it does not remove operational approval or live infrastructure checks.
