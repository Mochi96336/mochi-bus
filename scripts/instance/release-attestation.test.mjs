import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { hashCanonical, sha256 } from './bundle-integrity.mjs'
import {
  buildInstanceReleaseAttestation,
  evaluateInstanceReleaseAttestationEvidence,
  parseInstanceReleaseAttestationInputs,
  parseInstanceReleaseAttestationMode,
  renderAttestationMarkdown,
  renderVerificationMarkdown,
  runInstanceReleaseAttestation,
  runInstanceReleaseAttestationPreflight,
  runInstanceReleaseAttestationVerification,
  verifyInstanceReleaseAttestation,
} from './release-attestation.mjs'

const RELEASE_SHA = 'c'.repeat(40)
const MERGE_SHA = 'd'.repeat(40)
const BUNDLE_HASH = 'a'.repeat(64)
const ARTIFACT_HASH = 'b'.repeat(64)
const MANIFEST = Object.freeze({
  $schema: '../config/instance.schema.json',
  schemaVersion: 1,
  instanceId: 'island-test',
  site: { name: 'Island Transit', canonicalOrigin: 'https://bus.example.com' },
  transit: { enabledCities: ['Taipei'], defaultCity: 'Taipei', demoQuery: null },
  cloudflare: {
    workerName: 'island-bus',
    workersDev: false,
    d1: { databaseName: 'island-transit', databaseId: '123e4567-e89b-42d3-a456-426614174000' },
    r2: { bucketName: 'island-shapes' },
    rateLimits: { standardNamespaceId: '42001', expensiveNamespaceId: '42002' },
  },
  operations: {
    profile: 'operator',
    snapshotSchedule: 'daily',
    releaseSmoke: true,
    publicProbe: true,
    windowWatchdog: true,
  },
})
const MANIFEST_SOURCE = `${JSON.stringify(MANIFEST, null, 2)}\n`
const TARGET_HASH = hashCanonical(MANIFEST)
const RUNTIME = Object.freeze({ schemaVersion: 1, instanceId: 'island-test' })
const WRANGLER = Object.freeze({ name: 'island-bus', main: '../../../src/index.ts' })
const OPERATIONS = Object.freeze({ schemaVersion: 1, profile: 'operator' })
const RUNTIME_HASH = hashCanonical(RUNTIME)
const WRANGLER_HASH = hashCanonical(WRANGLER)
const OPERATIONS_HASH = hashCanonical(OPERATIONS)
const GENERATED_SET_HASH = hashCanonical({
  runtime: RUNTIME_HASH,
  wrangler: WRANGLER_HASH,
  operations: OPERATIONS_HASH,
})

async function withWorkspace(run) {
  const cwd = await mkdtemp(join(tmpdir(), 'mochi-release-attestation-'))
  const summaryPath = join(cwd, 'summary.md')
  const outputPath = join(cwd, 'outputs.txt')
  await writeFile(summaryPath, '', 'utf8')
  await writeFile(outputPath, '', 'utf8')
  try {
    return await run({ cwd, summaryPath, outputPath })
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

function workflowEnv({ summaryPath = '/tmp/summary', outputPath = '/tmp/output', overrides = {} } = {}) {
  return {
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'Mochi96336/mochi-bus',
    GITHUB_REF: 'refs/heads/integration/instance-rollout',
    GITHUB_SHA: RELEASE_SHA,
    GITHUB_RUN_ID: '888',
    GITHUB_RUN_ATTEMPT: '3',
    GITHUB_STEP_SUMMARY: summaryPath,
    GITHUB_OUTPUT: outputPath,
    INPUT_CONFIRMATION: 'ATTEST',
    INPUT_RECONCILIATION_RUN_ID: '777',
    INPUT_RECONCILIATION_ARTIFACT_NAME: 'instance-bundle-merge-reconciliation-island-test-777-2',
    INPUT_EXPECTED_RELEASE_SHA: RELEASE_SHA,
    INPUT_EXPECTED_BUNDLE_HASH: BUNDLE_HASH,
    INPUT_EXPECTED_ARTIFACT_HASH: ARTIFACT_HASH,
    INPUT_EXPECTED_TARGET_MANIFEST_HASH: TARGET_HASH,
    INPUT_EXPECTED_GENERATED_SET_HASH: GENERATED_SET_HASH,
    ...overrides,
  }
}

function inputsFixture(overrides = {}, { requireAttestationHash = false } = {}) {
  return Object.freeze({
    ...parseInstanceReleaseAttestationInputs(workflowEnv({
      overrides: requireAttestationHash
        ? { INPUT_EXPECTED_ATTESTATION_HASH: overrides.expectedAttestationHash ?? 'f'.repeat(64) }
        : {},
    }), { requireAttestationHash }),
    ...overrides,
  })
}

function reconciliationFixture(overrides = {}) {
  return structuredClone({
    schemaVersion: 1,
    kind: 'mochi-bus-instance-bundle-apply-merge-reconciliation',
    status: 'reconciled',
    ok: true,
    contentReconciled: true,
    localDoctorReady: true,
    remoteVerified: false,
    deploymentReady: false,
    repository: 'Mochi96336/mochi-bus',
    pullRequestNumber: 321,
    pullRequestUrl: 'https://github.com/Mochi96336/mochi-bus/pull/321',
    instanceId: 'island-test',
    configPath: 'instances/island-test.json',
    current: { branch: 'integration/instance-rollout', sha: RELEASE_SHA, commitsAfterMerge: 2 },
    merge: { sha: MERGE_SHA, mergedAt: '2026-08-03T00:00:00Z', mergedBy: 'Mochi96336' },
    hashes: {
      bundleHash: BUNDLE_HASH,
      artifactHash: ARTIFACT_HASH,
      targetManifestHash: TARGET_HASH,
      generatedSetHash: GENERATED_SET_HASH,
      runtimeHash: RUNTIME_HASH,
      wranglerHash: WRANGLER_HASH,
      operationsHash: OPERATIONS_HASH,
    },
    review: { runId: '555', runAttempt: '1', artifactName: 'instance-bundle-review-island-test-555-1' },
    apply: { runId: '666', runAttempt: '1', artifactName: 'instance-bundle-apply-island-test-666-1' },
    doctor: {
      ok: true,
      manifestStatus: 'ready',
      generatedStatuses: [
        { key: 'runtime', status: 'ready' },
        { key: 'wrangler', status: 'ready' },
        { key: 'operations', status: 'ready' },
      ],
      environmentStatus: 'ready',
      operationStatuses: [{ name: 'deploy', status: 'ready' }],
      remoteStatus: 'not_checked',
      blockers: [],
    },
    summary: { total: 1, passed: 1, failed: 0 },
    checks: [{ id: 'all-authority', ok: true, detail: 'all authority checks passed' }],
    errors: [],
    nextAction: 'continue through separate live deployment checks',
    ...overrides,
  })
}

function runEvidenceFixture(overrides = {}) {
  return structuredClone({
    branch: {
      schemaVersion: 1,
      repository: 'Mochi96336/mochi-bus',
      name: 'integration/instance-rollout',
      sha: RELEASE_SHA,
      protected: false,
    },
    reconciliationRun: {
      schemaVersion: 1,
      repository: 'Mochi96336/mochi-bus',
      id: 777,
      runAttempt: 2,
      name: 'Reconcile merged reviewed instance bundle PR',
      event: 'workflow_dispatch',
      status: 'completed',
      conclusion: 'success',
      headBranch: 'integration/instance-rollout',
      headSha: RELEASE_SHA,
      htmlUrl: 'https://github.com/Mochi96336/mochi-bus/actions/runs/777',
    },
    ...overrides,
  })
}

function currentFixture(overrides = {}) {
  return structuredClone({
    configPath: 'instances/island-test.json',
    source: MANIFEST_SOURCE,
    snapshotSource: MANIFEST_SOURCE,
    manifest: MANIFEST,
    manifestHash: TARGET_HASH,
    sourceHash: sha256(MANIFEST_SOURCE),
    generatedSetHash: GENERATED_SET_HASH,
    artifacts: {
      runtime: { matched: true, canonicalHash: RUNTIME_HASH, detail: 'matches deterministic compiler output' },
      wrangler: { matched: true, canonicalHash: WRANGLER_HASH, detail: 'matches deterministic compiler output' },
      operations: { matched: true, canonicalHash: OPERATIONS_HASH, detail: 'matches deterministic compiler output' },
    },
    ...overrides,
  })
}

async function evaluate({
  inputs = inputsFixture(),
  reconciliation = reconciliationFixture(),
  runEvidence = runEvidenceFixture(),
  current = currentFixture(),
} = {}) {
  return evaluateInstanceReleaseAttestationEvidence({ inputs, reconciliation, runEvidence, current })
}

describe('reconciled instance release attestation', () => {
  test('requires GitHub Actions, exact ATTEST and the exact workflow release SHA', () => {
    expect(() => parseInstanceReleaseAttestationInputs(workflowEnv({
      overrides: { GITHUB_ACTIONS: 'false' },
    }))).toThrow('only inside GitHub Actions')
    expect(() => parseInstanceReleaseAttestationInputs(workflowEnv({
      overrides: { INPUT_CONFIRMATION: 'attest' },
    }))).toThrow('confirmation ATTEST')
    expect(() => parseInstanceReleaseAttestationInputs(workflowEnv({
      overrides: { INPUT_EXPECTED_RELEASE_SHA: 'e'.repeat(40) },
    }))).toThrow('must equal the exact workflow release SHA')
    expect(() => parseInstanceReleaseAttestationInputs(workflowEnv({
      overrides: { GITHUB_REF: 'refs/tags/v1' },
    }))).toThrow('branch ref')
  })

  test('binds the reconciliation artifact instance, run and attempt', () => {
    const parsed = parseInstanceReleaseAttestationInputs(workflowEnv())
    expect(parsed.artifactInstanceId).toBe('island-test')
    expect(parsed.reconciliationRunId).toBe('777')
    expect(parsed.reconciliationRunAttempt).toBe('2')
    expect(() => parseInstanceReleaseAttestationInputs(workflowEnv({
      overrides: { INPUT_RECONCILIATION_RUN_ID: '778' },
    }))).toThrow('must match reconciliation_run_id')
    expect(() => parseInstanceReleaseAttestationInputs(workflowEnv({
      overrides: { INPUT_RECONCILIATION_ARTIFACT_NAME: 'bad-name' },
    }))).toThrow('must use instance-bundle-merge-reconciliation')
  })

  test('accepts only preflight, attest, verify and help modes', () => {
    expect(parseInstanceReleaseAttestationMode(['--preflight'])).toBe('preflight')
    expect(parseInstanceReleaseAttestationMode(['--attest'])).toBe('attest')
    expect(parseInstanceReleaseAttestationMode(['--verify'])).toBe('verify')
    expect(parseInstanceReleaseAttestationMode(['--help'])).toBe('help')
    expect(() => parseInstanceReleaseAttestationMode(['--deploy'])).toThrow('Usage')
  })

  test('preflight writes only validated artifact and release identity', async () => {
    await withWorkspace(async ({ summaryPath, outputPath }) => {
      const inputs = parseInstanceReleaseAttestationInputs(workflowEnv({ summaryPath, outputPath }))
      let stdout = ''
      await runInstanceReleaseAttestationPreflight(inputs, { stdout: { write(value) { stdout += value } } })
      expect(JSON.parse(stdout).releaseSha).toBe(RELEASE_SHA)
      const outputs = await readFile(outputPath, 'utf8')
      expect(outputs).toContain('reconciliation_run_id=777')
      expect(outputs).toContain(`release_sha=${RELEASE_SHA}`)
      expect(await readFile(summaryPath, 'utf8')).toContain('No artifact was downloaded')
    })
  })

  test('creates a deterministic content-only attestation for reconciled local-doctor-ready evidence', async () => {
    const evaluation = await evaluate()
    expect(evaluation.gatePassed).toBe(true)
    expect(evaluation.summary.failed).toBe(0)
    expect(evaluation.attestation.kind).toBe('mochi-bus-instance-release-attestation')
    expect(evaluation.attestation.release.sha).toBe(RELEASE_SHA)
    expect(evaluation.attestation.instance.manifestSourceHash).toBe(sha256(MANIFEST_SOURCE))
    expect(evaluation.attestation.boundary.releaseContentGatePassed).toBe(true)
    expect(evaluation.attestation.boundary.remoteVerified).toBe(false)
    expect(evaluation.attestation.boundary.deploymentReady).toBe(false)
    expect(evaluation.attestation.integrity.attestationHash).toMatch(/^[a-f0-9]{64}$/)
  })

  test('rejects locally_blocked reconciliation instead of treating content reconciliation as release readiness', async () => {
    const reconciliation = reconciliationFixture({
      status: 'locally_blocked',
      localDoctorReady: false,
      doctor: {
        ...reconciliationFixture().doctor,
        ok: false,
        environmentStatus: 'blocked',
        blockers: ['TDX_CLIENT_SECRET is missing'],
      },
    })
    const evaluation = await evaluate({ reconciliation })
    expect(evaluation.gatePassed).toBe(false)
    expect(evaluation.attestation).toBe(null)
    expect(evaluation.errors.join('\n')).toContain('reconciliation-ready')
  })

  test('rejects reconciliation failed checks and trusted hash drift', async () => {
    const reconciliation = reconciliationFixture()
    reconciliation.summary.failed = 1
    reconciliation.summary.passed = 0
    reconciliation.checks[0].ok = false
    reconciliation.errors.push('tampered')
    reconciliation.hashes.bundleHash = '9'.repeat(64)
    const evaluation = await evaluate({ reconciliation })
    expect(evaluation.gatePassed).toBe(false)
    expect(evaluation.errors.join('\n')).toContain('reconciliation-checks')
    expect(evaluation.errors.join('\n')).toContain('reconciliation-bundle-hash')
  })

  test('rejects a failed or differently sourced reconciliation workflow run', async () => {
    const runEvidence = runEvidenceFixture()
    runEvidence.reconciliationRun.conclusion = 'failure'
    runEvidence.reconciliationRun.headSha = 'e'.repeat(40)
    const evaluation = await evaluate({ runEvidence })
    expect(evaluation.gatePassed).toBe(false)
    expect(evaluation.errors.join('\n')).toContain('run-success')
    expect(evaluation.errors.join('\n')).toContain('run-release')
  })

  test('rejects a branch snapshot that no longer matches the release SHA', async () => {
    const runEvidence = runEvidenceFixture()
    runEvidence.branch.sha = 'e'.repeat(40)
    const evaluation = await evaluate({ runEvidence })
    expect(evaluation.gatePassed).toBe(false)
    expect(evaluation.errors.join('\n')).toContain('branch-release')
  })

  test('rejects exact manifest byte drift despite canonical equivalence', async () => {
    const current = currentFixture({
      source: `${JSON.stringify(MANIFEST)}\n`,
      sourceHash: sha256(`${JSON.stringify(MANIFEST)}\n`),
    })
    const evaluation = await evaluate({ current })
    expect(evaluation.gatePassed).toBe(false)
    expect(evaluation.errors.join('\n')).toContain('current-manifest-bytes')
    expect(evaluation.errors.join('\n')).not.toContain('current-manifest-hash')
  })

  test('rejects generated-set or individual deterministic output drift', async () => {
    const current = currentFixture()
    current.generatedSetHash = '9'.repeat(64)
    current.artifacts.wrangler.matched = false
    current.artifacts.wrangler.detail = 'Wrangler output drifted'
    const evaluation = await evaluate({ current })
    expect(evaluation.gatePassed).toBe(false)
    expect(evaluation.errors.join('\n')).toContain('current-generated-set')
    expect(evaluation.errors.join('\n')).toContain('current-wrangler')
  })

  test('builds the same attestation for the same evidence', () => {
    const inputs = inputsFixture()
    const reconciliation = reconciliationFixture()
    const current = currentFixture()
    const first = buildInstanceReleaseAttestation({ inputs, reconciliation, current })
    const second = buildInstanceReleaseAttestation({ inputs, reconciliation, current })
    expect(second).toEqual(first)
    expect(first.integrity.attestationHash).toBe(second.integrity.attestationHash)
  })

  test('verifies a trusted attestation against the exact release checkout', async () => {
    const evaluation = await evaluate()
    const inputs = inputsFixture({
      expectedAttestationHash: evaluation.attestation.integrity.attestationHash,
    }, { requireAttestationHash: true })
    const verification = verifyInstanceReleaseAttestation({
      inputs,
      attestation: evaluation.attestation,
      current: currentFixture(),
    })
    expect(verification.gatePassed).toBe(true)
    expect(verification.releaseContentGatePassed).toBe(true)
    expect(verification.remoteVerified).toBe(false)
    expect(verification.deploymentReady).toBe(false)
  })

  test('rejects attestation payload tampering and unknown keys', async () => {
    const evaluation = await evaluate()
    const tampered = structuredClone(evaluation.attestation)
    tampered.release.sha = 'e'.repeat(40)
    tampered.extra = true
    const inputs = inputsFixture({
      expectedAttestationHash: evaluation.attestation.integrity.attestationHash,
    }, { requireAttestationHash: true })
    const verification = verifyInstanceReleaseAttestation({ inputs, attestation: tampered, current: currentFixture() })
    expect(verification.gatePassed).toBe(false)
    expect(verification.errors.join('\n')).toContain('attestation-shape')
    expect(verification.errors.join('\n')).toContain('attestation-integrity')
  })

  test('rejects an untrusted attestation hash or different release SHA', async () => {
    const evaluation = await evaluate()
    const inputs = inputsFixture({
      expectedAttestationHash: 'e'.repeat(64),
      releaseSha: 'f'.repeat(40),
      expectedReleaseSha: 'f'.repeat(40),
    }, { requireAttestationHash: true })
    const verification = verifyInstanceReleaseAttestation({
      inputs,
      attestation: evaluation.attestation,
      current: currentFixture(),
    })
    expect(verification.gatePassed).toBe(false)
    expect(verification.errors.join('\n')).toContain('trusted-attestation-hash')
    expect(verification.errors.join('\n')).toContain('release-identity')
  })

  test('rejects current manifest and deterministic compiler drift during verification', async () => {
    const evaluation = await evaluate()
    const inputs = inputsFixture({
      expectedAttestationHash: evaluation.attestation.integrity.attestationHash,
    }, { requireAttestationHash: true })
    const current = currentFixture()
    current.source = `${MANIFEST_SOURCE}\n`
    current.sourceHash = sha256(current.source)
    current.artifacts.runtime.canonicalHash = '9'.repeat(64)
    current.artifacts.runtime.matched = false
    current.generatedSetHash = '8'.repeat(64)
    const verification = verifyInstanceReleaseAttestation({ inputs, attestation: evaluation.attestation, current })
    expect(verification.gatePassed).toBe(false)
    expect(verification.errors.join('\n')).toContain('current-manifest-source')
    expect(verification.errors.join('\n')).toContain('current-generated-set')
    expect(verification.errors.join('\n')).toContain('current-runtime')
  })

  test('renders multiline blockers as inert indented evidence', async () => {
    const evaluation = await evaluate()
    const blocked = {
      ...evaluation,
      gatePassed: false,
      releaseContentGatePassed: false,
      errors: ['bad value\n## injected heading\n- fake instruction'],
      summary: { ...evaluation.summary, failed: 1 },
      attestation: null,
    }
    const markdown = renderAttestationMarkdown(blocked)
    expect(markdown).toContain('    ## injected heading')
    expect(markdown).not.toMatch(/^## injected heading$/m)
    const verificationMarkdown = renderVerificationMarkdown({
      schemaVersion: 1,
      gatePassed: false,
      releaseContentGatePassed: false,
      remoteVerified: false,
      deploymentReady: false,
      release: evaluation.release,
      instanceId: 'island-test',
      attestationHash: null,
      summary: { total: 1, passed: 0, failed: 1 },
      errors: ['bad\n## injected'],
    })
    expect(verificationMarkdown).toContain('    ## injected')
  })

  test('persists evaluation, attestation and verification while keeping deploymentReady false', async () => {
    await withWorkspace(async ({ cwd, summaryPath, outputPath }) => {
      const resultDirectory = '.generated/release-attestation/test-result'
      const inputs = Object.freeze({
        ...parseInstanceReleaseAttestationInputs(workflowEnv({ summaryPath, outputPath })),
        resultDirectory,
        attestationPath: `${resultDirectory}/release-attestation.json`,
      })
      const created = await runInstanceReleaseAttestation(inputs, {
        cwd,
        dependencies: {
          reconciliation: reconciliationFixture(),
          runEvidence: runEvidenceFixture(),
          current: currentFixture(),
        },
      })
      expect(created.outputs.deployment_ready).toBe('false')
      expect(JSON.parse(await readFile(join(cwd, resultDirectory, 'gate-evaluation.json'), 'utf8')).gatePassed).toBe(true)
      expect(JSON.parse(await readFile(join(cwd, resultDirectory, 'release-attestation.json'), 'utf8')).integrity.attestationHash).toBe(created.attestation.integrity.attestationHash)

      const verifyInputs = Object.freeze({
        ...inputs,
        expectedAttestationHash: created.attestation.integrity.attestationHash,
      })
      const verified = await runInstanceReleaseAttestationVerification(verifyInputs, {
        cwd,
        dependencies: { attestation: created.attestation, current: currentFixture() },
      })
      expect(verified.gatePassed).toBe(true)
      expect(JSON.parse(await readFile(join(cwd, resultDirectory, 'release-verification.json'), 'utf8')).deploymentReady).toBe(false)
      expect(await readFile(outputPath, 'utf8')).toContain('release_content_gate_verified=true')
    })
  })

  test('writes blocked evaluation but never writes an attestation for failed authority checks', async () => {
    await withWorkspace(async ({ cwd, summaryPath, outputPath }) => {
      const resultDirectory = '.generated/release-attestation/blocked-result'
      const inputs = Object.freeze({
        ...parseInstanceReleaseAttestationInputs(workflowEnv({ summaryPath, outputPath })),
        resultDirectory,
        attestationPath: `${resultDirectory}/release-attestation.json`,
      })
      const reconciliation = reconciliationFixture({ status: 'locally_blocked', localDoctorReady: false })
      await expect(runInstanceReleaseAttestation(inputs, {
        cwd,
        dependencies: { reconciliation, runEvidence: runEvidenceFixture(), current: currentFixture() },
      })).rejects.toThrow('blocked with')
      expect(JSON.parse(await readFile(join(cwd, resultDirectory, 'gate-evaluation.json'), 'utf8')).gatePassed).toBe(false)
      await expect(readFile(join(cwd, resultDirectory, 'release-attestation.json'), 'utf8')).rejects.toThrow()
    })
  })
})
