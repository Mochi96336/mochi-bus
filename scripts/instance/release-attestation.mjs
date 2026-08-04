import { constants } from 'node:fs'
import {
  appendFile,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
} from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { pathToFileURL } from 'node:url'
import {
  compileInstanceConfig,
  loadInstanceConfig,
  rebaseWranglerConfig,
} from './config.mjs'
import {
  hashCanonical,
  parseStrictJson,
  sha256,
} from './bundle-integrity.mjs'

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const GIT_SHA_PATTERN = /^[a-f0-9]{40}$/
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const INSTANCE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62})$/
const SAFE_REF_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,198}[A-Za-z0-9_-])?$/
const UNSAFE_INPUT_PATTERN = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u
const MAX_INPUT_BYTES = 4096
const MAX_DIGIT_BYTES = 20
const MAX_JSON_BYTES = 1024 * 1024
const MAX_MANIFEST_BYTES = 1024 * 1024
const RECONCILIATION_DIRECTORY = '.generated/release-attestation/reconciliation'
const RUN_EVIDENCE_DIRECTORY = '.generated/release-attestation/run'
const RESULT_DIRECTORY = '.generated/release-attestation/result'
const ATTESTATION_FILENAME = 'release-attestation.json'
const EVALUATION_FILENAME = 'gate-evaluation.json'
const VERIFICATION_FILENAME = 'release-verification.json'
const RECONCILIATION_ROOT_ENTRIES = Object.freeze(['compiled', 'github', 'result'])
const RECONCILIATION_GITHUB_FILES = Object.freeze([
  'apply-run.json',
  'branch.json',
  'commits.json',
  'compare.json',
  'current-manifest.json',
  'files.json',
  'head-commit.json',
  'head-manifest.json',
  'merge-commit.json',
  'merge-manifest.json',
  'pull-request.json',
  'review-run.json',
])
const COMPILED_FILES = Object.freeze([
  'instance-runtime.json',
  'operations-plan.json',
  'wrangler.instance.jsonc',
])
const RUN_EVIDENCE_FILES = Object.freeze(['branch.json', 'reconciliation-run.json'])
const VIRTUAL_RECONCILIATION_COMPILED_DIRECTORY = '.generated/reconcile-apply-merge/compiled'

export function parseInstanceReleaseAttestationInputs(env = process.env, { requireAttestationHash = false } = {}) {
  if (String(env.GITHUB_ACTIONS ?? '').toLowerCase() !== 'true') {
    throw new Error('The instance release attestation runner is available only inside GitHub Actions')
  }
  const confirmation = requiredExact(env.INPUT_CONFIRMATION, 'confirmation')
  if (confirmation !== 'ATTEST') {
    throw new Error('Instance release attestation requires confirmation ATTEST')
  }

  const reconciliationRunId = requiredDigits(env.INPUT_RECONCILIATION_RUN_ID, 'reconciliation_run_id')
  const reconciliationArtifactName = requiredSingleLine(
    env.INPUT_RECONCILIATION_ARTIFACT_NAME,
    'reconciliation_artifact_name',
    256,
  )
  const artifactIdentity = parseReconciliationArtifactName(reconciliationArtifactName)
  if (artifactIdentity.reconciliationRunId !== reconciliationRunId) {
    throw new Error('reconciliation_artifact_name run ID must match reconciliation_run_id')
  }

  const repository = requiredSingleLine(env.GITHUB_REPOSITORY, 'GITHUB_REPOSITORY', 200)
  if (!REPOSITORY_PATTERN.test(repository)) throw new Error('GITHUB_REPOSITORY must use owner/name')
  const sourceRef = requiredSingleLine(env.GITHUB_REF, 'GITHUB_REF', 256)
  if (!sourceRef.startsWith('refs/heads/')) {
    throw new Error('Release attestation must be dispatched or called from a branch ref')
  }
  const releaseBranch = safeRef(sourceRef.slice('refs/heads/'.length))
  if (!releaseBranch) throw new Error('GITHUB_REF contains an unsafe branch name')
  const releaseSha = requiredGitSha(env.GITHUB_SHA, 'GITHUB_SHA')
  const expectedReleaseSha = requiredGitSha(env.INPUT_EXPECTED_RELEASE_SHA, 'expected_release_sha')
  if (expectedReleaseSha !== releaseSha) {
    throw new Error(`expected_release_sha must equal the exact workflow release SHA ${releaseSha}`)
  }

  return deepFreeze({
    confirmation,
    reconciliationRunId,
    reconciliationRunAttempt: artifactIdentity.reconciliationRunAttempt,
    reconciliationArtifactName,
    artifactInstanceId: artifactIdentity.instanceId,
    expectedReleaseSha,
    expectedBundleHash: requiredHash(env.INPUT_EXPECTED_BUNDLE_HASH, 'expected_bundle_hash'),
    expectedArtifactHash: requiredHash(env.INPUT_EXPECTED_ARTIFACT_HASH, 'expected_artifact_hash'),
    expectedTargetManifestHash: requiredHash(
      env.INPUT_EXPECTED_TARGET_MANIFEST_HASH,
      'expected_target_manifest_hash',
    ),
    expectedGeneratedSetHash: requiredHash(
      env.INPUT_EXPECTED_GENERATED_SET_HASH,
      'expected_generated_set_hash',
    ),
    expectedAttestationHash: requireAttestationHash
      ? requiredHash(env.INPUT_EXPECTED_ATTESTATION_HASH, 'expected_attestation_hash')
      : optionalHash(env.INPUT_EXPECTED_ATTESTATION_HASH, 'expected_attestation_hash'),
    repository,
    sourceRef,
    releaseBranch,
    releaseSha,
    gateRunId: requiredDigits(env.GITHUB_RUN_ID, 'GITHUB_RUN_ID'),
    gateRunAttempt: requiredDigits(env.GITHUB_RUN_ATTEMPT, 'GITHUB_RUN_ATTEMPT'),
    summaryPath: requiredPath(env.GITHUB_STEP_SUMMARY, 'GITHUB_STEP_SUMMARY'),
    outputPath: requiredPath(env.GITHUB_OUTPUT, 'GITHUB_OUTPUT'),
    reconciliationDirectory: RECONCILIATION_DIRECTORY,
    runEvidenceDirectory: RUN_EVIDENCE_DIRECTORY,
    resultDirectory: RESULT_DIRECTORY,
    attestationPath: `${RESULT_DIRECTORY}/${ATTESTATION_FILENAME}`,
  })
}

export function parseInstanceReleaseAttestationMode(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === '--help') return 'help'
  if (argv.length !== 1 || !['--preflight', '--attest', '--verify'].includes(argv[0])) {
    throw new Error('Usage: node scripts/instance/release-attestation.mjs --preflight|--attest|--verify|--help')
  }
  return argv[0].slice(2)
}

export async function runInstanceReleaseAttestationPreflight(inputs, { stdout = process.stdout } = {}) {
  const outputs = Object.freeze({
    reconciliation_run_id: inputs.reconciliationRunId,
    reconciliation_artifact_name: inputs.reconciliationArtifactName,
    release_branch: inputs.releaseBranch,
    release_sha: inputs.releaseSha,
  })
  await appendWorkflowOutputs(inputs.outputPath, outputs)
  await appendFile(inputs.summaryPath, renderPreflightMarkdown(inputs), 'utf8')
  stdout.write(`${JSON.stringify({
    message: 'instance_release_attestation_preflight',
    reconciliationRunId: inputs.reconciliationRunId,
    releaseBranch: inputs.releaseBranch,
    releaseSha: inputs.releaseSha,
  })}\n`)
  return deepFreeze({ inputs, outputs })
}

export async function evaluateInstanceReleaseAttestationEvidence({
  inputs,
  reconciliation,
  runEvidence,
  current,
}) {
  const checks = []
  const errors = []
  const check = (id, ok, detail) => {
    const item = Object.freeze({ id, ok: Boolean(ok), detail: String(detail) })
    checks.push(item)
    if (!item.ok) errors.push(`${id}: ${item.detail}`)
  }

  check('reconciliation-schema', reconciliation?.schemaVersion === 1
    && reconciliation?.kind === 'mochi-bus-instance-bundle-apply-merge-reconciliation',
  `schema=${reconciliation?.schemaVersion ?? 'missing'} kind=${reconciliation?.kind ?? 'missing'}`)
  check('reconciliation-ready', reconciliation?.status === 'reconciled'
    && reconciliation?.ok === true
    && reconciliation?.contentReconciled === true
    && reconciliation?.localDoctorReady === true,
  `status=${reconciliation?.status ?? 'missing'} content=${String(reconciliation?.contentReconciled)} doctor=${String(reconciliation?.localDoctorReady)}`)
  check('reconciliation-boundary', reconciliation?.remoteVerified === false
    && reconciliation?.deploymentReady === false,
  `remoteVerified=${String(reconciliation?.remoteVerified)} deploymentReady=${String(reconciliation?.deploymentReady)}`)
  check('reconciliation-repository', reconciliation?.repository === inputs.repository,
    `expected ${inputs.repository}, received ${reconciliation?.repository ?? 'missing'}`)
  check('reconciliation-instance', reconciliation?.instanceId === inputs.artifactInstanceId,
    `expected ${inputs.artifactInstanceId}, received ${reconciliation?.instanceId ?? 'missing'}`)
  check('reconciliation-release', reconciliation?.current?.branch === inputs.releaseBranch
    && reconciliation?.current?.sha === inputs.releaseSha,
  `expected ${inputs.releaseBranch}@${inputs.releaseSha}, received ${reconciliation?.current?.branch ?? 'missing'}@${reconciliation?.current?.sha ?? 'missing'}`)
  check('reconciliation-bundle-hash', reconciliation?.hashes?.bundleHash === inputs.expectedBundleHash,
    `expected ${inputs.expectedBundleHash}, received ${reconciliation?.hashes?.bundleHash ?? 'missing'}`)
  check('reconciliation-artifact-hash', reconciliation?.hashes?.artifactHash === inputs.expectedArtifactHash,
    `expected ${inputs.expectedArtifactHash}, received ${reconciliation?.hashes?.artifactHash ?? 'missing'}`)
  check('reconciliation-manifest-hash', reconciliation?.hashes?.targetManifestHash === inputs.expectedTargetManifestHash,
    `expected ${inputs.expectedTargetManifestHash}, received ${reconciliation?.hashes?.targetManifestHash ?? 'missing'}`)
  check('reconciliation-generated-set-hash', reconciliation?.hashes?.generatedSetHash === inputs.expectedGeneratedSetHash,
    `expected ${inputs.expectedGeneratedSetHash}, received ${reconciliation?.hashes?.generatedSetHash ?? 'missing'}`)
  check('reconciliation-checks', Array.isArray(reconciliation?.checks)
    && reconciliation.checks.length > 0
    && reconciliation.checks.every((item) => item?.ok === true)
    && reconciliation?.summary?.failed === 0
    && reconciliation?.summary?.passed === reconciliation.checks.length
    && reconciliation?.summary?.total === reconciliation.checks.length
    && Array.isArray(reconciliation?.errors)
    && reconciliation.errors.length === 0,
  `passed=${reconciliation?.summary?.passed ?? 'missing'} failed=${reconciliation?.summary?.failed ?? 'missing'} total=${reconciliation?.summary?.total ?? 'missing'}`)
  check('reconciliation-doctor', reconciliation?.doctor?.ok === true
    && reconciliation?.doctor?.manifestStatus === 'ready'
    && Array.isArray(reconciliation?.doctor?.generatedStatuses)
    && reconciliation.doctor.generatedStatuses.length === 3
    && reconciliation.doctor.generatedStatuses.every((item) => item?.status === 'ready')
    && Array.isArray(reconciliation?.doctor?.blockers)
    && reconciliation.doctor.blockers.length === 0,
  `doctor=${String(reconciliation?.doctor?.ok)} manifest=${reconciliation?.doctor?.manifestStatus ?? 'missing'} blockers=${reconciliation?.doctor?.blockers?.length ?? 'missing'}`)

  const run = runEvidence.reconciliationRun
  check('run-schema', run?.schemaVersion === 1, 'reconciliation-run.json must use schema version 1')
  check('run-id', String(run?.id) === inputs.reconciliationRunId,
    `expected ${inputs.reconciliationRunId}, received ${run?.id ?? 'missing'}`)
  check('run-attempt', String(run?.runAttempt) === inputs.reconciliationRunAttempt,
    `expected ${inputs.reconciliationRunAttempt}, received ${run?.runAttempt ?? 'missing'}`)
  check('run-workflow', run?.name === 'Reconcile merged reviewed instance bundle PR'
    && run?.event === 'workflow_dispatch',
  `name=${run?.name ?? 'missing'} event=${run?.event ?? 'missing'}`)
  check('run-success', run?.status === 'completed' && run?.conclusion === 'success',
    `status=${run?.status ?? 'missing'} conclusion=${run?.conclusion ?? 'missing'}`)
  check('run-release', run?.repository === inputs.repository
    && run?.headBranch === inputs.releaseBranch
    && run?.headSha === inputs.releaseSha,
  `expected ${inputs.repository} ${inputs.releaseBranch}@${inputs.releaseSha}`)

  const branch = runEvidence.branch
  check('branch-schema', branch?.schemaVersion === 1, 'branch.json must use schema version 1')
  check('branch-release', branch?.repository === inputs.repository
    && branch?.name === inputs.releaseBranch
    && branch?.sha === inputs.releaseSha,
  `expected ${inputs.repository} ${inputs.releaseBranch}@${inputs.releaseSha}`)

  check('current-config-path', current?.configPath === reconciliation?.configPath,
    `expected ${reconciliation?.configPath ?? 'missing'}, received ${current?.configPath ?? 'missing'}`)
  check('current-instance', current?.manifest?.instanceId === inputs.artifactInstanceId,
    `expected ${inputs.artifactInstanceId}, received ${current?.manifest?.instanceId ?? 'missing'}`)
  check('current-manifest-hash', current?.manifestHash === inputs.expectedTargetManifestHash,
    `expected ${inputs.expectedTargetManifestHash}, received ${current?.manifestHash ?? 'missing'}`)
  check('current-manifest-bytes', current?.source === current?.snapshotSource,
    'current checkout manifest bytes must equal the reconciled current-manifest snapshot')
  check('current-generated-set', current?.generatedSetHash === inputs.expectedGeneratedSetHash,
    `expected ${inputs.expectedGeneratedSetHash}, received ${current?.generatedSetHash ?? 'missing'}`)
  check('current-runtime', current?.artifacts?.runtime?.matched === true
    && current.artifacts.runtime.canonicalHash === reconciliation?.hashes?.runtimeHash,
  current?.artifacts?.runtime?.detail ?? 'runtime evidence missing')
  check('current-wrangler', current?.artifacts?.wrangler?.matched === true
    && current.artifacts.wrangler.canonicalHash === reconciliation?.hashes?.wranglerHash,
  current?.artifacts?.wrangler?.detail ?? 'wrangler evidence missing')
  check('current-operations', current?.artifacts?.operations?.matched === true
    && current.artifacts.operations.canonicalHash === reconciliation?.hashes?.operationsHash,
  current?.artifacts?.operations?.detail ?? 'operations evidence missing')

  const gatePassed = errors.length === 0
  const reconciliationReportHash = hashCanonical(reconciliation)
  const attestation = gatePassed
    ? buildInstanceReleaseAttestation({
      inputs,
      reconciliation,
      current,
      reconciliationReportHash,
    })
    : null
  return deepFreeze({
    schemaVersion: 1,
    kind: 'mochi-bus-instance-release-attestation-evaluation',
    gatePassed,
    releaseContentGatePassed: gatePassed,
    remoteVerified: false,
    deploymentReady: false,
    repository: inputs.repository,
    release: { branch: inputs.releaseBranch, sha: inputs.releaseSha },
    instanceId: reconciliation?.instanceId ?? inputs.artifactInstanceId,
    reconciliationReportHash,
    summary: {
      total: checks.length,
      passed: checks.filter((item) => item.ok).length,
      failed: checks.filter((item) => !item.ok).length,
    },
    checks,
    errors,
    attestation,
  })
}

export function buildInstanceReleaseAttestation({
  inputs,
  reconciliation,
  current,
  reconciliationReportHash = hashCanonical(reconciliation),
}) {
  const payload = {
    schemaVersion: 1,
    kind: 'mochi-bus-instance-release-attestation',
    release: {
      repository: inputs.repository,
      branch: inputs.releaseBranch,
      sha: inputs.releaseSha,
    },
    instance: {
      instanceId: reconciliation.instanceId,
      configPath: reconciliation.configPath,
      manifestHash: current.manifestHash,
      manifestSourceHash: current.sourceHash,
      generatedSetHash: current.generatedSetHash,
      runtimeHash: current.artifacts.runtime.canonicalHash,
      wranglerHash: current.artifacts.wrangler.canonicalHash,
      operationsHash: current.artifacts.operations.canonicalHash,
    },
    provenance: {
      pullRequestNumber: reconciliation.pullRequestNumber,
      mergeSha: reconciliation.merge.sha,
      review: reconciliation.review,
      apply: reconciliation.apply,
      reconciliation: {
        runId: inputs.reconciliationRunId,
        runAttempt: inputs.reconciliationRunAttempt,
        artifactName: inputs.reconciliationArtifactName,
        reportHash: reconciliationReportHash,
      },
      gate: {
        runId: inputs.gateRunId,
        runAttempt: inputs.gateRunAttempt,
      },
    },
    trustedHashes: {
      bundleHash: inputs.expectedBundleHash,
      artifactHash: inputs.expectedArtifactHash,
      targetManifestHash: inputs.expectedTargetManifestHash,
      generatedSetHash: inputs.expectedGeneratedSetHash,
    },
    evidence: {
      manifestSource: current.source,
    },
    boundary: {
      contentReconciled: true,
      localDoctorReady: true,
      releaseContentGatePassed: true,
      remoteVerified: false,
      deploymentReady: false,
      authorizes: 'release-content-gate-only',
    },
  }
  return deepFreeze({
    ...payload,
    integrity: {
      algorithm: 'sha256',
      attestationHash: hashCanonical(payload),
    },
  })
}

export async function attestInstanceRelease(inputs, {
  cwd = process.cwd(),
  dependencies = {},
} = {}) {
  const reconciliation = dependencies.reconciliation
    ?? await readReconciliationReport(inputs, { cwd })
  const runEvidence = dependencies.runEvidence
    ?? await readRunEvidence(inputs, { cwd })
  const current = dependencies.current
    ?? await inspectCurrentRelease(inputs, reconciliation, { cwd })
  return evaluateInstanceReleaseAttestationEvidence({
    inputs,
    reconciliation,
    runEvidence,
    current,
  })
}

export async function runInstanceReleaseAttestation(inputs, {
  cwd = process.cwd(),
  stdout = process.stdout,
  dependencies = {},
} = {}) {
  const evaluation = await attestInstanceRelease(inputs, { cwd, dependencies })
  const resultDirectory = resolve(cwd, inputs.resultDirectory)
  await ensureGeneratedDirectory(cwd, resultDirectory)
  const evaluationPath = resolve(resultDirectory, EVALUATION_FILENAME)
  await writeExclusiveJson(evaluationPath, evaluation)
  await appendFile(inputs.summaryPath, renderAttestationMarkdown(evaluation), 'utf8')

  if (!evaluation.gatePassed || !evaluation.attestation) {
    await appendWorkflowOutputs(inputs.outputPath, {
      release_content_gate_passed: 'false',
      remote_verified: 'false',
      deployment_ready: 'false',
      evaluation_path: displayPath(cwd, evaluationPath),
    })
    throw new Error(`instance:release-attestation blocked with ${evaluation.summary.failed} failed checks`)
  }

  const attestationPath = resolve(cwd, inputs.attestationPath)
  await writeExclusiveJson(attestationPath, evaluation.attestation)
  const artifactName = `instance-release-attestation-${evaluation.attestation.instance.instanceId}-${inputs.gateRunId}-${inputs.gateRunAttempt}`
  const outputs = Object.freeze({
    release_content_gate_passed: 'true',
    remote_verified: 'false',
    deployment_ready: 'false',
    instance_id: evaluation.attestation.instance.instanceId,
    attestation_path: displayPath(cwd, attestationPath),
    attestation_hash: evaluation.attestation.integrity.attestationHash,
    attestation_artifact_name: artifactName,
    evaluation_path: displayPath(cwd, evaluationPath),
  })
  await appendWorkflowOutputs(inputs.outputPath, outputs)
  stdout.write(`${JSON.stringify({
    message: 'instance_release_attestation_created',
    instanceId: evaluation.attestation.instance.instanceId,
    releaseSha: inputs.releaseSha,
    attestationHash: evaluation.attestation.integrity.attestationHash,
    releaseContentGatePassed: true,
    deploymentReady: false,
  })}\n`)
  return deepFreeze({ evaluation, attestation: evaluation.attestation, outputs })
}

export function verifyInstanceReleaseAttestation({ inputs, attestation, current }) {
  const checks = []
  const errors = []
  const check = (id, ok, detail) => {
    const item = Object.freeze({ id, ok: Boolean(ok), detail: String(detail) })
    checks.push(item)
    if (!item.ok) errors.push(`${id}: ${item.detail}`)
  }

  const shape = validateAttestationShape(attestation)
  check('attestation-shape', shape.ok, shape.detail)
  const payload = shape.ok ? removeIntegrity(attestation) : null
  const computedHash = payload ? hashCanonical(payload) : null
  check('attestation-integrity', shape.ok
    && attestation.integrity.algorithm === 'sha256'
    && attestation.integrity.attestationHash === computedHash,
  `stored=${attestation?.integrity?.attestationHash ?? 'missing'} computed=${computedHash ?? 'unavailable'}`)
  check('trusted-attestation-hash', shape.ok
    && attestation.integrity.attestationHash === inputs.expectedAttestationHash,
  `expected ${inputs.expectedAttestationHash ?? 'missing'}, received ${attestation?.integrity?.attestationHash ?? 'missing'}`)
  check('release-identity', shape.ok
    && attestation.release.repository === inputs.repository
    && attestation.release.branch === inputs.releaseBranch
    && attestation.release.sha === inputs.releaseSha,
  `expected ${inputs.repository} ${inputs.releaseBranch}@${inputs.releaseSha}`)
  check('trusted-bundle-hash', shape.ok
    && attestation.trustedHashes.bundleHash === inputs.expectedBundleHash,
  `expected ${inputs.expectedBundleHash}`)
  check('trusted-artifact-hash', shape.ok
    && attestation.trustedHashes.artifactHash === inputs.expectedArtifactHash,
  `expected ${inputs.expectedArtifactHash}`)
  check('trusted-manifest-hash', shape.ok
    && attestation.trustedHashes.targetManifestHash === inputs.expectedTargetManifestHash,
  `expected ${inputs.expectedTargetManifestHash}`)
  check('trusted-generated-set-hash', shape.ok
    && attestation.trustedHashes.generatedSetHash === inputs.expectedGeneratedSetHash,
  `expected ${inputs.expectedGeneratedSetHash}`)
  check('reconciliation-identity', shape.ok
    && String(attestation.provenance.reconciliation.runId) === inputs.reconciliationRunId
    && String(attestation.provenance.reconciliation.runAttempt) === inputs.reconciliationRunAttempt
    && attestation.provenance.reconciliation.artifactName === inputs.reconciliationArtifactName,
  'attestation reconciliation provenance must match the selected reconciliation artifact')
  check('boundary', shape.ok
    && attestation.boundary.contentReconciled === true
    && attestation.boundary.localDoctorReady === true
    && attestation.boundary.releaseContentGatePassed === true
    && attestation.boundary.remoteVerified === false
    && attestation.boundary.deploymentReady === false
    && attestation.boundary.authorizes === 'release-content-gate-only',
  'attestation boundary must authorize only the release content gate')
  check('current-config-path', shape.ok && current.configPath === attestation.instance.configPath,
    `expected ${attestation?.instance?.configPath ?? 'missing'}, received ${current?.configPath ?? 'missing'}`)
  check('current-instance', shape.ok && current.manifest.instanceId === attestation.instance.instanceId,
    `expected ${attestation?.instance?.instanceId ?? 'missing'}, received ${current?.manifest?.instanceId ?? 'missing'}`)
  check('current-manifest-source', shape.ok
    && current.source === attestation.evidence.manifestSource
    && current.sourceHash === attestation.instance.manifestSourceHash,
  'current manifest bytes must exactly match the attested manifest source')
  check('current-manifest-hash', shape.ok
    && current.manifestHash === attestation.instance.manifestHash
    && current.manifestHash === inputs.expectedTargetManifestHash,
  `current=${current?.manifestHash ?? 'missing'} attested=${attestation?.instance?.manifestHash ?? 'missing'}`)
  check('current-generated-set', shape.ok
    && current.generatedSetHash === attestation.instance.generatedSetHash
    && current.generatedSetHash === inputs.expectedGeneratedSetHash,
  `current=${current?.generatedSetHash ?? 'missing'} attested=${attestation?.instance?.generatedSetHash ?? 'missing'}`)
  for (const key of ['runtime', 'wrangler', 'operations']) {
    const expectedHash = attestation?.instance?.[`${key}Hash`]
    check(`current-${key}`, shape.ok
      && current.artifacts[key].matched === true
      && current.artifacts[key].canonicalHash === expectedHash,
    current?.artifacts?.[key]?.detail ?? `${key} evidence missing`)
  }

  const gatePassed = errors.length === 0
  return deepFreeze({
    schemaVersion: 1,
    kind: 'mochi-bus-instance-release-attestation-verification',
    gatePassed,
    releaseContentGatePassed: gatePassed,
    remoteVerified: false,
    deploymentReady: false,
    repository: inputs.repository,
    release: { branch: inputs.releaseBranch, sha: inputs.releaseSha },
    instanceId: attestation?.instance?.instanceId ?? null,
    attestationHash: attestation?.integrity?.attestationHash ?? null,
    summary: {
      total: checks.length,
      passed: checks.filter((item) => item.ok).length,
      failed: checks.filter((item) => !item.ok).length,
    },
    checks,
    errors,
  })
}

export async function runInstanceReleaseAttestationVerification(inputs, {
  cwd = process.cwd(),
  stdout = process.stdout,
  dependencies = {},
} = {}) {
  const attestation = dependencies.attestation
    ?? await readBoundedStrictJson(resolve(cwd, inputs.attestationPath), MAX_JSON_BYTES)
  const current = dependencies.current
    ?? await inspectCurrentReleaseFromAttestation(inputs, attestation, { cwd })
  const verification = verifyInstanceReleaseAttestation({ inputs, attestation, current })
  const resultDirectory = resolve(cwd, inputs.resultDirectory)
  await ensureGeneratedDirectory(cwd, resultDirectory)
  const verificationPath = resolve(resultDirectory, VERIFICATION_FILENAME)
  await writeExclusiveJson(verificationPath, verification)
  await appendFile(inputs.summaryPath, renderVerificationMarkdown(verification), 'utf8')
  await appendWorkflowOutputs(inputs.outputPath, {
    release_content_gate_verified: verification.gatePassed ? 'true' : 'false',
    remote_verified: 'false',
    deployment_ready: 'false',
    verification_path: displayPath(cwd, verificationPath),
  })
  stdout.write(`${JSON.stringify({
    message: 'instance_release_attestation_verified',
    gatePassed: verification.gatePassed,
    releaseSha: inputs.releaseSha,
    attestationHash: verification.attestationHash,
    deploymentReady: false,
  })}\n`)
  if (!verification.gatePassed) {
    throw new Error(`instance:release-attestation verification blocked with ${verification.summary.failed} failed checks`)
  }
  return verification
}

function renderPreflightMarkdown(inputs) {
  return `${[
    '## Reconciled instance release gate preflight',
    '',
    `- Reconciliation run: ${markdownCodeSpan(inputs.reconciliationRunId)}`,
    `- Reconciliation artifact: ${markdownCodeSpan(inputs.reconciliationArtifactName)}`,
    `- Release snapshot: ${markdownCodeSpan(`${inputs.releaseBranch}@${inputs.releaseSha}`)}`,
    '',
    'Immutable input syntax passed. No artifact was downloaded, no manifest was changed and no remote resource was contacted by this step.',
    '',
  ].join('\n')}\n`
}

export function renderAttestationMarkdown(evaluation) {
  const lines = [
    '## Reconciled instance release content gate',
    '',
    `**${evaluation.gatePassed ? 'PASSED' : 'BLOCKED'}** · ${markdownCodeSpan(`${evaluation.release.branch}@${evaluation.release.sha}`)}`,
    '',
    `- Instance: ${markdownCodeSpan(evaluation.instanceId)}`,
    `- Reconciliation report SHA-256: ${markdownCodeSpan(evaluation.reconciliationReportHash)}`,
    `- Release content gate passed: **${evaluation.releaseContentGatePassed ? 'yes' : 'no'}**`,
    '- Remote resources verified: **no**',
    '- Deployment ready: **no**',
    '',
    `Checks: **${evaluation.summary.passed} passed**, **${evaluation.summary.failed} failed**`,
  ]
  if (evaluation.errors.length > 0) {
    lines.push('', '### Gate blockers', '', ...indentedEvidence(evaluation.errors))
  }
  if (evaluation.attestation) {
    lines.push(
      '',
      `- Attestation SHA-256: ${markdownCodeSpan(evaluation.attestation.integrity.attestationHash)}`,
      '',
      'The attestation proves only content identity for this exact release SHA. Live resources and deployment authorization remain separate.',
    )
  }
  lines.push('')
  return `${lines.join('\n')}\n`
}

export function renderVerificationMarkdown(verification) {
  const lines = [
    '## Instance release attestation verification',
    '',
    `**${verification.gatePassed ? 'PASSED' : 'BLOCKED'}** · ${markdownCodeSpan(`${verification.release.branch}@${verification.release.sha}`)}`,
    '',
    `- Instance: ${markdownCodeSpan(verification.instanceId ?? 'unknown')}`,
    `- Attestation SHA-256: ${markdownCodeSpan(verification.attestationHash ?? 'missing')}`,
    `- Release content gate passed: **${verification.releaseContentGatePassed ? 'yes' : 'no'}**`,
    '- Remote resources verified: **no**',
    '- Deployment ready: **no**',
    '',
    `Checks: **${verification.summary.passed} passed**, **${verification.summary.failed} failed**`,
  ]
  if (verification.errors.length > 0) {
    lines.push('', '### Verification blockers', '', ...indentedEvidence(verification.errors))
  }
  lines.push('')
  return `${lines.join('\n')}\n`
}

export function instanceReleaseAttestationUsage() {
  return `Create or verify a release-content attestation from one successful merged-bundle reconciliation.\n\nUsage inside GitHub Actions:\n  npm run instance:release-attestation -- --preflight\n  npm run instance:release-attestation -- --attest\n  npm run instance:release-attestation -- --verify\n\nThe gate binds one reconciliation run, exact branch SHA, manifest bytes and deterministic generated hashes. It never contacts Cloudflare and never claims deployment readiness.\n`
}

export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  cwd = process.cwd(),
  stdout = process.stdout,
} = {}) {
  const mode = parseInstanceReleaseAttestationMode(argv)
  if (mode === 'help') {
    stdout.write(instanceReleaseAttestationUsage())
    return null
  }
  const inputs = parseInstanceReleaseAttestationInputs(env, {
    requireAttestationHash: mode === 'verify',
  })
  if (mode === 'preflight') return runInstanceReleaseAttestationPreflight(inputs, { stdout })
  if (mode === 'attest') return runInstanceReleaseAttestation(inputs, { cwd, stdout })
  return runInstanceReleaseAttestationVerification(inputs, { cwd, stdout })
}

async function readReconciliationReport(inputs, { cwd }) {
  const root = resolve(cwd)
  const directory = resolve(root, inputs.reconciliationDirectory)
  await assertRealDirectoryWithin(root, directory, inputs.reconciliationDirectory)
  await assertExactEntries(directory, RECONCILIATION_ROOT_ENTRIES)
  const githubDirectory = resolve(directory, 'github')
  const compiledDirectory = resolve(directory, 'compiled')
  const resultDirectory = resolve(directory, 'result')
  await assertRealDirectoryWithin(root, githubDirectory, 'reconciliation github evidence')
  await assertRealDirectoryWithin(root, compiledDirectory, 'reconciliation compiled evidence')
  await assertRealDirectoryWithin(root, resultDirectory, 'reconciliation result evidence')
  await assertExactEntries(githubDirectory, RECONCILIATION_GITHUB_FILES)
  await assertExactEntries(compiledDirectory, COMPILED_FILES)
  await assertExactEntries(resultDirectory, ['reconciliation.json'])
  return readBoundedStrictJson(resolve(resultDirectory, 'reconciliation.json'), MAX_JSON_BYTES)
}

async function readRunEvidence(inputs, { cwd }) {
  const root = resolve(cwd)
  const directory = resolve(root, inputs.runEvidenceDirectory)
  await assertRealDirectoryWithin(root, directory, inputs.runEvidenceDirectory)
  await assertExactEntries(directory, RUN_EVIDENCE_FILES)
  const [branch, reconciliationRun] = await Promise.all([
    readBoundedStrictJson(resolve(directory, 'branch.json'), MAX_JSON_BYTES),
    readBoundedStrictJson(resolve(directory, 'reconciliation-run.json'), MAX_JSON_BYTES),
  ])
  return deepFreeze({ branch, reconciliationRun })
}

async function inspectCurrentRelease(inputs, reconciliation, { cwd }) {
  const root = resolve(cwd)
  const reconciliationRoot = resolve(root, inputs.reconciliationDirectory)
  const compiledDirectory = resolve(reconciliationRoot, 'compiled')
  const githubDirectory = resolve(reconciliationRoot, 'github')
  const snapshot = await readBoundedStrictJson(resolve(githubDirectory, 'current-manifest.json'), MAX_JSON_BYTES * 2)
  const snapshotDecoded = decodeManifestSnapshot(snapshot, reconciliation.configPath)
  const current = await inspectCurrentManifestAndGenerated({
    cwd,
    configPath: reconciliation.configPath,
    compiledDirectory,
  })
  return deepFreeze({ ...current, snapshotSource: snapshotDecoded.source })
}

async function inspectCurrentReleaseFromAttestation(inputs, attestation, { cwd }) {
  return inspectCurrentManifestAndGenerated({
    cwd,
    configPath: attestation?.instance?.configPath,
    compiledDirectory: null,
    expectedHashes: attestation?.instance,
  })
}

async function inspectCurrentManifestAndGenerated({
  cwd,
  configPath,
  compiledDirectory,
  expectedHashes = null,
}) {
  if (typeof configPath !== 'string' || !configPath) throw new Error('Attestation config path is missing')
  const root = resolve(cwd)
  const manifestPath = resolve(root, configPath)
  assertRepositoryPath(root, manifestPath, 'instance manifest')
  const source = await readBoundedText(manifestPath, MAX_MANIFEST_BYTES)
  const manifest = parseStrictJson(source)
  const validated = await loadInstanceConfig(manifestPath)
  if (!isDeepStrictEqual(manifest, validated)) throw new Error('Strict manifest parse differs from validated manifest')
  const manifestHash = hashCanonical(manifest)
  const sourceHash = sha256(source)
  const compiled = compileInstanceConfig(validated)
  const virtualCompiledDirectory = resolve(root, VIRTUAL_RECONCILIATION_COMPILED_DIRECTORY)
  const expectedValues = {
    runtime: compiled.runtime,
    operations: compiled.operations,
    wrangler: rebaseWranglerConfig(compiled.wrangler, virtualCompiledDirectory, root),
  }

  const artifacts = {}
  if (compiledDirectory) {
    const specifications = [
      ['runtime', 'instance-runtime.json'],
      ['operations', 'operations-plan.json'],
      ['wrangler', 'wrangler.instance.jsonc'],
    ]
    for (const [key, filename] of specifications) {
      const artifactSource = await readBoundedText(resolve(compiledDirectory, filename), MAX_JSON_BYTES)
      const value = parseStrictJson(artifactSource)
      const matched = isDeepStrictEqual(value, expectedValues[key])
      artifacts[key] = Object.freeze({
        matched,
        sourceHash: sha256(artifactSource),
        canonicalHash: hashCanonical(value),
        detail: matched ? 'matches deterministic compiler output' : 'differs from deterministic compiler output',
      })
    }
  } else {
    for (const key of ['runtime', 'operations', 'wrangler']) {
      const canonicalHash = hashCanonical(expectedValues[key])
      const expectedHash = expectedHashes?.[`${key}Hash`]
      artifacts[key] = Object.freeze({
        matched: canonicalHash === expectedHash,
        sourceHash: null,
        canonicalHash,
        detail: canonicalHash === expectedHash
          ? 'current deterministic compiler output matches attestation'
          : 'current deterministic compiler output differs from attestation',
      })
    }
  }
  const generatedSetHash = hashCanonical({
    runtime: artifacts.runtime.canonicalHash,
    wrangler: artifacts.wrangler.canonicalHash,
    operations: artifacts.operations.canonicalHash,
  })
  return deepFreeze({
    configPath,
    source,
    manifest,
    manifestHash,
    sourceHash,
    generatedSetHash,
    artifacts,
  })
}

function validateAttestationShape(value) {
  try {
    exactKeys(value, [
      'schemaVersion', 'kind', 'release', 'instance', 'provenance', 'trustedHashes', 'evidence', 'boundary', 'integrity',
    ], 'attestation')
    if (value.schemaVersion !== 1 || value.kind !== 'mochi-bus-instance-release-attestation') {
      throw new Error('attestation schema or kind is unsupported')
    }
    exactKeys(value.release, ['repository', 'branch', 'sha'], 'attestation.release')
    exactKeys(value.instance, [
      'instanceId', 'configPath', 'manifestHash', 'manifestSourceHash', 'generatedSetHash', 'runtimeHash', 'wranglerHash', 'operationsHash',
    ], 'attestation.instance')
    exactKeys(value.provenance, ['pullRequestNumber', 'mergeSha', 'review', 'apply', 'reconciliation', 'gate'], 'attestation.provenance')
    exactKeys(value.provenance.reconciliation, ['runId', 'runAttempt', 'artifactName', 'reportHash'], 'attestation.provenance.reconciliation')
    exactKeys(value.provenance.gate, ['runId', 'runAttempt'], 'attestation.provenance.gate')
    exactKeys(value.trustedHashes, ['bundleHash', 'artifactHash', 'targetManifestHash', 'generatedSetHash'], 'attestation.trustedHashes')
    exactKeys(value.evidence, ['manifestSource'], 'attestation.evidence')
    exactKeys(value.boundary, [
      'contentReconciled', 'localDoctorReady', 'releaseContentGatePassed', 'remoteVerified', 'deploymentReady', 'authorizes',
    ], 'attestation.boundary')
    exactKeys(value.integrity, ['algorithm', 'attestationHash'], 'attestation.integrity')
    for (const [path, hash] of [
      ['instance.manifestHash', value.instance.manifestHash],
      ['instance.manifestSourceHash', value.instance.manifestSourceHash],
      ['instance.generatedSetHash', value.instance.generatedSetHash],
      ['instance.runtimeHash', value.instance.runtimeHash],
      ['instance.wranglerHash', value.instance.wranglerHash],
      ['instance.operationsHash', value.instance.operationsHash],
      ['provenance.reconciliation.reportHash', value.provenance.reconciliation.reportHash],
      ['trustedHashes.bundleHash', value.trustedHashes.bundleHash],
      ['trustedHashes.artifactHash', value.trustedHashes.artifactHash],
      ['trustedHashes.targetManifestHash', value.trustedHashes.targetManifestHash],
      ['trustedHashes.generatedSetHash', value.trustedHashes.generatedSetHash],
      ['integrity.attestationHash', value.integrity.attestationHash],
    ]) {
      if (typeof hash !== 'string' || !SHA256_PATTERN.test(hash)) throw new Error(`${path} must be a SHA-256 digest`)
    }
    if (!validGitSha(value.release.sha) || !validGitSha(value.provenance.mergeSha)) throw new Error('attestation Git SHAs are invalid')
    if (!REPOSITORY_PATTERN.test(value.release.repository)) throw new Error('attestation repository is invalid')
    if (!safeRef(value.release.branch)) throw new Error('attestation branch is invalid')
    if (!INSTANCE_ID_PATTERN.test(value.instance.instanceId)) throw new Error('attestation instance ID is invalid')
    if (typeof value.evidence.manifestSource !== 'string' || value.evidence.manifestSource.length === 0) throw new Error('attestation manifest source is missing')
    return { ok: true, detail: 'attestation shape is valid' }
  } catch (error) {
    return { ok: false, detail: errorMessage(error) }
  }
}

function removeIntegrity(attestation) {
  const { integrity: _integrity, ...payload } = attestation
  return payload
}

function decodeManifestSnapshot(snapshot, expectedPath) {
  if (snapshot?.schemaVersion !== 1 || snapshot?.type !== 'file') throw new Error('current-manifest snapshot is not a file')
  if (snapshot.path !== expectedPath) throw new Error('current-manifest snapshot path differs from reconciliation report')
  if (snapshot.encoding !== 'base64' || typeof snapshot.content !== 'string') throw new Error('current-manifest snapshot has no base64 content')
  const compact = snapshot.content.replace(/\s+/g, '')
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) throw new Error('current-manifest snapshot contains invalid base64')
  const bytes = Buffer.from(compact, 'base64')
  if (bytes.length === 0 || bytes.length > MAX_MANIFEST_BYTES || snapshot.size !== bytes.length) throw new Error('current-manifest snapshot size is invalid')
  const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  if (Buffer.byteLength(source, 'utf8') !== bytes.length) throw new Error('current-manifest snapshot UTF-8 did not round-trip')
  parseStrictJson(source)
  return { source }
}

function exactKeys(value, expected, path) {
  if (!isPlainObject(value)) throw new Error(`${path} must be an object`)
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${path} must contain exactly ${wanted.join(', ')}`)
  }
}

async function assertRealDirectoryWithin(root, path, label) {
  const shown = displayPath(root, path)
  if (shown === '..' || shown.startsWith('../') || isAbsolute(shown)) throw new Error(`${label} must stay inside the repository`)
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory`)
  const [rootReal, pathReal] = await Promise.all([realpath(root), realpath(path)])
  const relativeReal = relative(rootReal, pathReal)
  if (relativeReal === '..' || relativeReal.startsWith(`..${sep}`)) throw new Error(`${label} resolves outside the repository`)
}

async function assertExactEntries(path, expected) {
  const entries = await readdir(path, { withFileTypes: true })
  const names = entries.map((entry) => entry.name).sort()
  const wanted = [...expected].sort()
  if (JSON.stringify(names) !== JSON.stringify(wanted)) throw new Error(`${path} must contain exactly ${wanted.join(', ')}`)
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error(`${entry.name} cannot be a symbolic link`)
  }
}

async function readBoundedStrictJson(path, maxBytes) {
  return parseStrictJson(await readBoundedText(path, maxBytes))
}

async function readBoundedText(path, maxBytes) {
  let handle
  try {
    const pathBefore = await lstat(path)
    if (!pathBefore.isFile() || pathBefore.isSymbolicLink()) throw new Error(`${path} must be a regular non-symlink file`)
    const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
    handle = await open(path, constants.O_RDONLY | noFollow)
    const before = await handle.stat()
    if (!before.isFile() || before.size === 0 || before.size > maxBytes) throw new Error(`${path} is empty, unsafe or exceeds the ${maxBytes}-byte limit`)
    if (!sameFileIdentity(pathBefore, before)) throw new Error(`${path} changed before it was opened`)
    const bytes = await handle.readFile()
    const after = await handle.stat()
    const pathAfter = await lstat(path)
    if (!sameFileIdentity(before, after) || !sameFileIdentity(after, pathAfter) || bytes.length !== before.size) throw new Error(`${path} changed while it was being read`)
    const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    if (Buffer.byteLength(source, 'utf8') !== bytes.length) throw new Error(`${path} UTF-8 bytes did not round-trip exactly`)
    return source
  } finally {
    await handle?.close()
  }
}

async function ensureGeneratedDirectory(cwd, path) {
  const root = resolve(cwd)
  const generated = resolve(root, '.generated')
  const shown = relative(generated, path)
  if (!shown || shown === '..' || shown.startsWith(`..${sep}`) || isAbsolute(shown)) {
    throw new Error('Release attestation output must stay inside .generated')
  }
  await mkdir(path, { recursive: true, mode: 0o700 })
}

async function writeExclusiveJson(path, value) {
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function appendWorkflowOutputs(path, outputs) {
  const lines = []
  for (const [key, value] of Object.entries(outputs)) {
    if (!/^[a-z0-9_]+$/.test(key)) throw new Error(`Invalid workflow output key: ${key}`)
    if (typeof value !== 'string' || UNSAFE_INPUT_PATTERN.test(value)) throw new Error(`Invalid workflow output value for ${key}`)
    lines.push(`${key}=${value}`)
  }
  await appendFile(path, `${lines.join('\n')}\n`, 'utf8')
}

function assertRepositoryPath(root, path, label) {
  const shown = relative(root, path)
  if (!shown || shown === '..' || shown.startsWith(`..${sep}`) || isAbsolute(shown)) throw new Error(`${label} must stay inside the repository`)
  if (shown.split(sep).some((part) => part === '.git' || part === 'node_modules')) throw new Error(`${label} cannot be inside .git or node_modules`)
}

function parseReconciliationArtifactName(value) {
  const match = /^instance-bundle-merge-reconciliation-([a-z0-9](?:[a-z0-9-]{0,62}))-(\d+)-(\d+)$/.exec(value)
  if (!match || !INSTANCE_ID_PATTERN.test(match[1])) {
    throw new Error('reconciliation_artifact_name must use instance-bundle-merge-reconciliation-<instance-id>-<run-id>-<attempt>')
  }
  return Object.freeze({
    instanceId: match[1],
    reconciliationRunId: match[2],
    reconciliationRunAttempt: match[3],
  })
}

function safeRef(value) {
  if (typeof value !== 'string' || !SAFE_REF_PATTERN.test(value) || value.includes('..') || value.includes('@{') || value.includes('//') || value.includes('\\') || value.endsWith('.') || value.endsWith('/')) return null
  return value
}

function validGitSha(value) {
  return typeof value === 'string' && GIT_SHA_PATTERN.test(value) ? value : null
}

function requiredGitSha(value, name) {
  const normalized = requiredSingleLine(value, name, 40).toLowerCase()
  if (!GIT_SHA_PATTERN.test(normalized)) throw new Error(`${name} must be a lowercase 40-character Git commit SHA`)
  return normalized
}

function requiredHash(value, name) {
  const normalized = requiredSingleLine(value, name, 64).toLowerCase()
  if (!SHA256_PATTERN.test(normalized)) throw new Error(`${name} must be a lowercase SHA-256 digest`)
  return normalized
}

function optionalHash(value, name) {
  if (value === undefined || value === null || String(value).trim() === '') return null
  return requiredHash(String(value), name)
}

function requiredDigits(value, name) {
  const normalized = requiredSingleLine(value, name, MAX_DIGIT_BYTES)
  if (!/^\d+$/.test(normalized) || normalized === '0') throw new Error(`${name} must contain a positive decimal integer`)
  return normalized
}

function requiredSingleLine(value, name, maxBytes = MAX_INPUT_BYTES) {
  const normalized = requiredExact(value, name).trim()
  if (!normalized || Buffer.byteLength(normalized, 'utf8') > maxBytes || UNSAFE_INPUT_PATTERN.test(normalized)) throw new Error(`${name} is empty, too long or contains unsafe characters`)
  return normalized
}

function requiredPath(value, name) {
  const path = requiredExact(value, name)
  if (Buffer.byteLength(path, 'utf8') > MAX_INPUT_BYTES || UNSAFE_INPUT_PATTERN.test(path)) throw new Error(`${name} is too long or contains unsafe characters`)
  return path
}

function requiredExact(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} is required`)
  return value
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.size === right.size
}

function displayPath(cwd, path) {
  return relative(resolve(cwd), path).split(sep).join('/') || '.'
}

function markdownCodeSpan(value) {
  const text = String(value).replace(/\r\n?|\n/g, ' ')
  const runs = text.match(/`+/g) ?? []
  const fence = '`'.repeat(Math.max(0, ...runs.map((run) => run.length)) + 1)
  const padded = text.startsWith('`') || text.endsWith('`') || text.startsWith(' ') || text.endsWith(' ')
  return `${fence}${padded ? ` ${text} ` : text}${fence}`
}

function indentedEvidence(values) {
  return values
    .flatMap((value) => String(value).replace(/\r\n?/g, '\n').split('\n'))
    .map((line) => `    ${line.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu, '\ufffd')}`)
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value)) deepFreeze(child)
  return value
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`${errorMessage(error)}\n`)
    process.exitCode = 1
  })
}
