# End-to-end testing for reviewed instance bundles

The trusted instance-bundle path spans several independent workflows:

```text
REVIEW -> APPLY -> Draft PR -> CI -> VERIFY -> merge -> RECONCILE -> ATTEST
```

A full exercise needs a real branch, commit, PR and merge. Temporary test content must never enter the repository default branch.

## Machine-enforced E2E identity

The supported E2E purpose is derived from two immutable values already carried through apply provenance and later verification:

```text
base branch: e2e/instance-bundle-<lowercase-id>
manifest:    instances/starter-chiayi.example.json
```

This is not a free-form operator label. APPLY recomputes the identity from the reviewed manifest path and dispatch branch before writing, then persists:

```json
{
  "purpose": "e2e",
  "testOnly": true,
  "e2eFixture": "instances/starter-chiayi.example.json"
}
```

VERIFY recomputes the same classification and rejects mismatched provenance. RECONCILE carries the verified fields into merge evidence.

The policy fails closed when:

- an example manifest targets the default branch
- an example manifest uses an ordinary feature branch
- an E2E branch targets `instance.json`, `instances/mochi-production.json` or any other path
- an E2E branch targets an alternate example fixture
- the branch or path is unsafe

Normal human-authored PRs may still intentionally update example files. These restrictions apply to generated reviewed-bundle apply PRs.

## Retarget protection

The dedicated **Instance apply target policy** workflow runs only on PR open, synchronize, Ready transition and `edited` events. It has no manual-dispatch path, uses only read-only GitHub API data and never checks out or executes PR code. Keeping this context outside the general `CI` workflow prevents a manually dispatched CI run from producing a same-named skipped check.

For generated `agent/instance-bundle-apply-*` PRs it requires one existing, non-renamed manifest file from the same repository and repeats the branch/path policy. Therefore changing a verified E2E PR base to the default branch, renaming the fixture or substituting a non-manifest path produces a failed check.

After this workflow lands, add `Instance apply target policy` to the default-branch ruleset's required status checks. The code check and the ruleset requirement are both necessary: without the required context, a maintainer could still merge after a failed or missing observation.

## Disposable base branch procedure

1. Resolve the current default-branch SHA.
2. Create `e2e/instance-bundle-<lowercase-id>` from that exact SHA.
3. Dispatch **Review instance change bundle** on that branch for `instances/starter-chiayi.example.json`.
4. Dispatch **Apply reviewed instance bundle to Draft PR** on the same branch with the exact review run, artifact name and trusted hashes.
5. Create the generated Draft PR against the disposable branch. When repository policy blocks `GITHUB_TOKEN`, use a maintainer identity with the exact generated title and body.
6. Run formal `CI` on the generated apply branch.
7. Dispatch **Verify reviewed instance bundle Draft PR** and require success before Ready or merge.
8. Confirm the live PR base is still the disposable branch, then merge there.
9. Dispatch **Reconcile merged reviewed instance bundle PR** from the disposable branch.
10. Dispatch **Gate reconciled instance release** from the same branch.
11. Require ATTEST to fail closed because the starter fixture is intentionally incomplete.
12. Delete or reset the disposable base and generated apply branches. Never merge the disposable branch into the default branch.

## Supported expected result

The only supported E2E fixture intentionally lacks live resource IDs, operator credentials and a fixed smoke-test origin:

```text
content reconciliation: success
release attestation: blocked
```

ATTEST independently re-derives purpose from the reconciliation branch and manifest path, requires the persisted fields to match that derivation, and then requires `change`, `testOnly: false` and no E2E fixture. Therefore E2E reconciliation is rejected even if its purpose fields are forged or a future fixture accidentally becomes local-doctor-ready. A successful E2E release attestation remains out of scope; do not create a release-ready E2E fixture under the current attestation kind.

## What this exercise proves

Without changing the default branch, the exercise proves:

- review artifact integrity and source freshness
- exact apply evidence and single-manifest Git boundary
- formal CI observation and PR-retarget rejection
- live PR, commit-parent, title, body and hash verification
- merge ancestry and current-manifest reconciliation
- deterministic generated artifact reconstruction
- intentional fail-closed release gating for an incomplete example
