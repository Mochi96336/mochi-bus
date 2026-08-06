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
import { pathToFileURL } from 'node:url'
import {
  hashCanonical,
  parseStrictJson,
  sha256,
  verifyInstanceBundleArtifact,
} from './bundle-integrity.mjs'
import { renderApplyPullRequestBody } from './apply-bundle-pr-workflow.mjs'
import { classifyReviewedBundleApplyPurpose } from './check-apply-target-policy.mjs'

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const GIT_SHA_PATTERN = /^[a-f0-9]{40}$/
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const INSTANCE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62})$/
const SAFE_REF_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,198}[A-Za-z0-9_-])?$/
const UNSAFE_INPUT_PATTERN = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u
const MAX_JSON_BYTES = 1024 * 1024
const MAX_BODY_BYTES = 1024 * 1024
const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_INPUT_BYTES = 4096
const MAX_DIGIT_BYTES = 20
const DOWNLOAD_DIRECTORY = '.generated/verify-apply-pr/download'
const GITHUB_EVIDENCE_DIRECTORY = '.generated/verify-apply-pr/github'
const RESULT_DIRECTORY = '.generated/verify-apply-pr/result'
const APPLY_INPUT_FILES = Object.freeze(['bundle.json', 'freshness.json', 'verification.json'])
const APPLY_RESULT_FILES = Object.freeze(['apply-result.json', 'pr-body.md', 'provenance.json'])
const GITHUB_EVIDENCE_FILES = Object.freeze([
  'apply-run.json',
  'base-manifest.json',
  'checks.json',
  'commits.json',
  'files.json',
  'head-commit.json',
  'head-manifest.json',
  'pull-request.json',
  'review-run.json',
])

export function parseInstanceBundleApplyPrVerificationInputs(env = process.env) {
  if (String(env.GITHUB_ACTIONS ?? '').toLowerCase() !== 'true') {
    throw new Error('The apply-PR verifier is available only inside GitHub Actions')
  }

  const confirmation = requiredExact(env.INPUT_CONFIRMATION, 'confirmation')
  if (confirmation !== 'VERIFY') throw new Error('Apply-PR verification requires confirmation VERIFY')

  const pullRequestNumber = requiredDigits(env.INPUT_PULL_REQUEST_NUMBER, 'pull_request_number')
  if (pullRequestNumber === '0') throw new Error('pull_request_number must be greater than zero')
  const applyRunId = requiredDigits(env.INPUT_APPLY_RUN_ID, 'apply_run_id')
  const artifactName = requiredSingleLine(env.INPUT_ARTIFACT_NAME, 'artifact_name', 256)
  const artifactIdentity = parseApplyArtifactName(artifactName)
  if (artifactIdentity.applyRunId !== applyRunId) {
    throw new Error('artifact_name apply run ID must match apply_run_id')
  }

  const expectedBundleHash = requiredHash(env.INPUT_EXPECTED_BUNDLE_HASH, 'expected_bundle_hash')
  const expectedArtifactHash = requiredHash(env.INPUT_EXPECTED_ARTIFACT_HASH, 'expected_artifact_hash')
  const expectedTargetManifestHash = requiredHash(
    env.INPUT_EXPECTED_TARGET_MANIFEST_HASH,
    'expected_target_manifest_hash',
  )
  const repository = requiredSingleLine(env.GITHUB_REPOSITORY, 'GITHUB_REPOSITORY', 200)
  if (!REPOSITORY_PATTERN.test(repository)) throw new Error('GITHUB_REPOSITORY must use owner/name')

  return deepFreeze({
    confirmation,
    pullRequestNumber,
    applyRunId,
    applyRunAttempt: artifactIdentity.applyRunAttempt,
    artifactName,
    artifactInstanceId: artifactIdentity.instanceId,
    expectedBundleHash,
    expectedArtifactHash,
    expectedTargetManifestHash,
    repository,
    verificationRunId: requiredDigits(env.GITHUB_RUN_ID, 'GITHUB_RUN_ID'),
    verificationRunAttempt: requiredDigits(env.GITHUB_RUN_ATTEMPT, 'GITHUB_RUN_ATTEMPT'),
    summaryPath: requiredPath(env.GITHUB_STEP_SUMMARY, 'GITHUB_STEP_SUMMARY'),
    outputPath: requiredPath(env.GITHUB_OUTPUT, 'GITHUB_OUTPUT'),
    downloadDirectory: DOWNLOAD_DIRECTORY,
    githubEvidenceDirectory: GITHUB_EVIDENCE_DIRECTORY,
    resultDirectory: RESULT_DIRECTORY,
  })
}

export function parseInstanceBundleApplyPrVerificationMode(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === '--help') return 'help'
  if (argv.length !== 1 || !['--preflight', '--prepare', '--verify'].includes(argv[0])) {
    throw new Error('Usage: node scripts/instance/verify-apply-pr.mjs --preflight|--prepare|--verify|--help')
  }
  return argv[0].slice(2)
}

export async function runApplyPrVerificationPreflight(inputs, { stdout = process.stdout } = {}) {
  const outputs = Object.freeze({
    pull_request_number: inputs.pullRequestNumber,
    apply_run_id: inputs.applyRunId,
    artifact_name: inputs.artifactName,
  })
  await appendWorkflowOutputs(inputs.outputPath, outputs)
  await appendFile(inputs.summaryPath, renderPreflightMarkdown(inputs), 'utf8')
  stdout.write(`${JSON.stringify({
    message: 'instance_bundle_apply_pr_verification_preflight',
    pullRequestNumber: inputs.pullRequestNumber,
    applyRunId: inputs.applyRunId,
    artifactName: inputs.artifactName,
  })}\n`)
  return deepFreeze({ inputs, outputs })
}

export async function prepareInstanceBundleApplyPrVerification(inputs, {
  cwd = process.cwd(),
} = {}) {
  const evidence = await readApplyEvidence(inputs, { cwd })
  const failures = []
  const integrity = verifyInstanceBundleArtifact(evidence.bundle)
  if (!integrity.ok) failures.push(...integrity.errors.map((error) => `bundle:${error}`))
  if (integrity.bundleHash !== inputs.expectedBundleHash) failures.push('bundle hash does not match trusted input')
  if (integrity.artifactHash !== inputs.expectedArtifactHash) failures.push('artifact hash does not match trusted input')

  const bundle = evidence.bundle?.bundle
  const verification = evidence.verification
  const freshness = evidence.freshness
  const applyResult = evidence.applyResult
  const provenance = evidence.provenance

  if (verification?.schemaVersion !== 1 || verification?.ok !== true) failures.push('verification.json is not successful schema version 1 evidence')
  if (verification?.summary?.failed !== 0 || (verification?.errors ?? []).length !== 0) failures.push('verification.json contains failed checks or errors')
  if (verification?.bundleHash !== inputs.expectedBundleHash || verification?.expectedBundleHash !== inputs.expectedBundleHash) failures.push('verification.json bundle hash is not pinned to the trusted input')
  if (verification?.artifactHash !== inputs.expectedArtifactHash || verification?.expectedArtifactHash !== inputs.expectedArtifactHash) failures.push('verification.json artifact hash is not pinned to the trusted input')

  if (freshness?.schemaVersion !== 1 || freshness?.status !== 'fresh' || freshness?.ok !== true) failures.push('freshness.json is not successful fresh evidence')
  if (freshness?.currentState !== 'baseline' || freshness?.staleKind !== null) failures.push('freshness.json did not verify the baseline state')
  if (freshness?.applyAllowed !== true || freshness?.proposal?.changed !== true) failures.push('freshness.json does not permit an effective apply')
  if (freshness?.source?.matched !== true || freshness?.baseline?.matched !== true) failures.push('freshness.json source or baseline evidence did not match')
  if (freshness?.target?.currentMatched !== false) failures.push('freshness.json says the target was already present')
  if (freshness?.summary?.failed !== 0 || (freshness?.errors ?? []).length !== 0) failures.push('freshness.json contains failed checks or errors')
  if (freshness?.bundleHash !== inputs.expectedBundleHash || freshness?.expectedBundleHash !== inputs.expectedBundleHash) failures.push('freshness.json bundle hash is not pinned to the trusted input')
  if (freshness?.artifactHash !== inputs.expectedArtifactHash || freshness?.expectedArtifactHash !== inputs.expectedArtifactHash) failures.push('freshness.json artifact hash is not pinned to the trusted input')

  if (applyResult?.schemaVersion !== 1 || applyResult?.ready !== true || applyResult?.written !== true || applyResult?.reason !== null) failures.push('apply-result.json is not a successful atomic write result')
  if (applyResult?.bundleHash !== inputs.expectedBundleHash) failures.push('apply-result.json bundle hash does not match trusted input')
  if (applyResult?.artifactHash !== inputs.expectedArtifactHash) failures.push('apply-result.json artifact hash does not match trusted input')
  if (applyResult?.targetManifestHash !== inputs.expectedTargetManifestHash) failures.push('apply-result.json target hash does not match trusted input')
  if (applyResult?.changeCount < 1 || applyResult?.changes?.length !== applyResult?.changeCount) failures.push('apply-result.json does not contain an effective reviewed change set')

  if (provenance?.schemaVersion !== 1 || provenance?.kind !== 'mochi-bus-instance-bundle-apply-pr-provenance') failures.push('provenance.json has an unexpected schema or kind')
  if (provenance?.repository !== inputs.repository) failures.push('provenance repository does not match the workflow repository')
  if (String(provenance?.applyRunId) !== inputs.applyRunId) failures.push('provenance apply run ID does not match trusted input')
  if (String(provenance?.applyRunAttempt) !== inputs.applyRunAttempt) failures.push('provenance apply run attempt does not match artifact_name')
  if (provenance?.instanceId !== inputs.artifactInstanceId) failures.push('provenance instance ID does not match artifact_name')
  if (provenance?.bundleHash !== inputs.expectedBundleHash) failures.push('provenance bundle hash does not match trusted input')
  if (provenance?.artifactHash !== inputs.expectedArtifactHash) failures.push('provenance artifact hash does not match trusted input')
  if (provenance?.targetManifestHash !== inputs.expectedTargetManifestHash) failures.push('provenance target hash does not match trusted input')

  const configPath = safeManifestPath(provenance?.configPath)
  if (!configPath) failures.push('provenance config path is unsafe')
  const baseBranch = safeRef(provenance?.baseBranch)
  if (!baseBranch) failures.push('provenance base branch is unsafe')
  const sourceSha = validGitSha(provenance?.sourceSha)
  if (!sourceSha) failures.push('provenance source SHA is invalid')
  const expectedBranch = `agent/instance-bundle-apply-${inputs.applyRunId}-${inputs.applyRunAttempt}`
  if (provenance?.branchName !== expectedBranch) failures.push('provenance branch name is not the deterministic apply branch')
  if (baseBranch && provenance?.sourceRef !== `refs/heads/${baseBranch}`) failures.push('provenance source ref does not match base branch')

  let targetPolicy = null
  if (baseBranch && configPath) {
    try {
      targetPolicy = classifyReviewedBundleApplyPurpose({ baseBranch, configPath })
    } catch (error) {
      failures.push(`apply target policy: ${errorMessage(error)}`)
    }
  }
  if (targetPolicy) {
    if (provenance?.purpose !== targetPolicy.purpose) failures.push('provenance purpose differs from the derived apply target policy')
    if (provenance?.testOnly !== targetPolicy.testOnly) failures.push('provenance testOnly differs from the derived apply target policy')
    if (provenance?.e2eFixture !== targetPolicy.e2eFixture) failures.push('provenance E2E fixture differs from the derived apply target policy')
  }

  let reviewArtifactIdentity = null
  try {
    reviewArtifactIdentity = parseReviewArtifactName(provenance?.artifactName)
  } catch (error) {
    failures.push(errorMessage(error))
  }
  if (reviewArtifactIdentity) {
    if (String(provenance?.reviewRunId) !== reviewArtifactIdentity.reviewRunId) failures.push('provenance review run ID does not match review artifact name')
    if (String(provenance?.reviewRunAttempt) !== reviewArtifactIdentity.reviewRunAttempt) failures.push('provenance review run attempt does not match review artifact name')
    if (provenance?.instanceId !== reviewArtifactIdentity.instanceId) failures.push('review artifact and apply artifact instance IDs differ')
  }

  if (applyResult?.instanceId !== provenance?.instanceId || applyResult?.instanceId !== inputs.artifactInstanceId) failures.push('apply result and provenance instance identities differ')
  if (applyResult?.configPath !== configPath || freshness?.configPath !== configPath || bundle?.instance?.configPath !== configPath) failures.push('config path differs across bundle, freshness, apply result and provenance')
  if (verification?.instanceId !== provenance?.instanceId || freshness?.instanceId !== provenance?.instanceId || bundle?.instance?.id !== provenance?.instanceId) failures.push('instance ID differs across review and apply evidence')
  if (bundle?.hashes?.bundleHash !== inputs.expectedBundleHash) failures.push('bundle index hash does not match trusted input')
  if (bundle?.hashes?.targetManifestHash !== inputs.expectedTargetManifestHash) failures.push('bundle target hash does not match trusted input')
  if (freshness?.target?.hash !== inputs.expectedTargetManifestHash && freshness?.target?.expectedHash !== inputs.expectedTargetManifestHash) failures.push('freshness target hash does not match trusted input')
  if (hashCanonical(bundle?.proposal?.manifest) !== inputs.expectedTargetManifestHash) failures.push('bundle proposal manifest does not produce the trusted target hash')

  const changePaths = (applyResult?.changes ?? []).map((change) => change?.path)
  if (!sameJson(changePaths, provenance?.changePaths ?? [])) failures.push('provenance change paths differ from apply-result.json')
  if (changePaths.some((path) => typeof path !== 'string' || !path || UNSAFE_INPUT_PATTERN.test(path))) failures.push('reviewed change paths contain unsafe values')

  const expectedPrBody = failures.length === 0
    ? renderApplyPullRequestBody({
      reviewRunId: String(provenance.reviewRunId),
      artifactName: provenance.artifactName,
      baseBranch,
      sourceSha,
    }, {
      bundleHash: applyResult.bundleHash,
      artifactHash: applyResult.artifactHash,
      targetManifestHash: applyResult.targetManifestHash,
      configPath,
      instanceId: applyResult.instanceId,
      changes: applyResult.changes,
      warnings: applyResult.warnings ?? [],
      deploymentReady: applyResult.deploymentReady === true,
    }, provenance)
    : null
  if (expectedPrBody !== null && evidence.prBody !== expectedPrBody) failures.push('persisted PR body does not match the deterministic renderer')

  if (failures.length > 0) {
    throw new Error(`Apply artifact verification failed: ${uniqueStrings(failures).join('; ')}`)
  }

  return deepFreeze({
    inputs,
    evidence,
    integrity,
    configPath,
    baseBranch,
    sourceSha,
    headBranch: expectedBranch,
    instanceId: provenance.instanceId,
    purpose: targetPolicy.purpose,
    testOnly: targetPolicy.testOnly,
    e2eFixture: targetPolicy.e2eFixture,
    reviewRunId: String(provenance.reviewRunId),
    reviewRunAttempt: String(provenance.reviewRunAttempt),
    expectedPrTitle: `chore(instance): apply reviewed bundle for ${provenance.instanceId}`,
    expectedCommitMessage: `chore(instance): apply reviewed bundle for ${provenance.instanceId}`,
  })
}

export async function runApplyPrVerificationPrepare(inputs, {
  cwd = process.cwd(),
  stdout = process.stdout,
} = {}) {
  const prepared = await prepareInstanceBundleApplyPrVerification(inputs, { cwd })
  const outputs = Object.freeze({
    pull_request_number: inputs.pullRequestNumber,
    apply_run_id: inputs.applyRunId,
    review_run_id: prepared.reviewRunId,
    config_path: prepared.configPath,
    base_branch: prepared.baseBranch,
    source_sha: prepared.sourceSha,
    head_branch: prepared.headBranch,
    instance_id: prepared.instanceId,
    apply_purpose: prepared.purpose,
    test_only: prepared.testOnly ? 'true' : 'false',
  })
  await appendWorkflowOutputs(inputs.outputPath, outputs)
  await appendFile(inputs.summaryPath, renderPrepareMarkdown(prepared), 'utf8')
  stdout.write(`${JSON.stringify({
    message: 'instance_bundle_apply_pr_evidence_prepared',
    pullRequestNumber: inputs.pullRequestNumber,
    instanceId: prepared.instanceId,
    configPath: prepared.configPath,
    baseBranch: prepared.baseBranch,
    sourceSha: prepared.sourceSha,
    headBranch: prepared.headBranch,
  })}\n`)
  return deepFreeze({ prepared, outputs })
}

export async function verifyInstanceBundleApplyPullRequest(inputs, {
  cwd = process.cwd(),
} = {}) {
  const prepared = await prepareInstanceBundleApplyPrVerification(inputs, { cwd })
  const githubEvidence = await readGithubEvidence(inputs, { cwd })
  const checks = []
  const errors = []
  const check = (id, ok, detail) => {
    checks.push(Object.freeze({ id, ok: Boolean(ok), detail: String(detail) }))
    if (!ok) errors.push(`${id}: ${detail}`)
  }

  const pr = githubEvidence.pullRequest
  check('pr-schema', pr?.schemaVersion === 1, 'pull-request.json must use schema version 1')
  check('pr-number', String(pr?.number) === inputs.pullRequestNumber, `expected ${inputs.pullRequestNumber}, received ${pr?.number ?? 'missing'}`)
  check('pr-repository', pr?.repository === inputs.repository, `expected ${inputs.repository}, received ${pr?.repository ?? 'missing'}`)
  check('pr-open', pr?.state === 'open' && pr?.merged === false, `state=${pr?.state ?? 'missing'} merged=${String(pr?.merged)}`)
  check('pr-draft', pr?.draft === true, `draft=${String(pr?.draft)}`)
  check('pr-same-repository', pr?.base?.repository === inputs.repository && pr?.head?.repository === inputs.repository, 'base and head repositories must match the workflow repository')
  check('base-branch', pr?.base?.ref === prepared.baseBranch, `expected ${prepared.baseBranch}, received ${pr?.base?.ref ?? 'missing'}`)
  check('base-sha', pr?.base?.sha === prepared.sourceSha, `expected ${prepared.sourceSha}, received ${pr?.base?.sha ?? 'missing'}`)
  check('head-branch', pr?.head?.ref === prepared.headBranch, `expected ${prepared.headBranch}, received ${pr?.head?.ref ?? 'missing'}`)
  check('head-sha', validGitSha(pr?.head?.sha), `received ${pr?.head?.sha ?? 'missing'}`)
  check('pr-title', pr?.title === prepared.expectedPrTitle, `expected ${prepared.expectedPrTitle}`)
  check('pr-body', pr?.body === prepared.evidence.prBody, 'live PR body must match persisted deterministic PR body')
  check('single-changed-file-count', pr?.changedFiles === 1, `reported changed files=${pr?.changedFiles ?? 'missing'}`)
  check('single-commit-count', pr?.commits === 1, `reported commits=${pr?.commits ?? 'missing'}`)

  const files = githubEvidence.files
  check('files-schema', files?.schemaVersion === 1 && Array.isArray(files?.files), 'files.json must use schema version 1')
  check('single-modified-manifest', files?.files?.length === 1
    && files.files[0]?.filename === prepared.configPath
    && files.files[0]?.status === 'modified'
    && !files.files[0]?.previousFilename,
  files?.files?.length === 1
    ? `${files.files[0]?.status ?? 'missing'} ${files.files[0]?.filename ?? 'missing'}`
    : `received ${files?.files?.length ?? 'missing'} files`)

  const commits = githubEvidence.commits
  const headCommit = githubEvidence.headCommit
  check('commits-schema', commits?.schemaVersion === 1 && Array.isArray(commits?.commits), 'commits.json must use schema version 1')
  check('single-head-commit', commits?.commits?.length === 1 && commits.commits[0]?.sha === pr?.head?.sha, 'PR must contain exactly the current head commit')
  check('head-commit-schema', headCommit?.schemaVersion === 1 && headCommit?.sha === pr?.head?.sha, 'head-commit.json must describe the current PR head')
  check('head-parent', headCommit?.parents?.length === 1 && headCommit.parents[0] === prepared.sourceSha, `head must have exactly parent ${prepared.sourceSha}`)
  check('commit-message', headCommit?.message === prepared.expectedCommitMessage, `expected ${prepared.expectedCommitMessage}`)

  const baseManifest = decodeManifestSnapshot(githubEvidence.baseManifest, prepared.configPath, 'base manifest')
  const headManifest = decodeManifestSnapshot(githubEvidence.headManifest, prepared.configPath, 'head manifest')
  check('base-manifest-source-bytes', baseManifest.ok
    && baseManifest.source === prepared.evidence.bundle.evidence.sourceManifest
    && sha256(baseManifest.source) === prepared.evidence.applyResult.sourceManifestHash,
  baseManifest.ok ? `sha256=${sha256(baseManifest.source)}` : baseManifest.error)
  check('base-manifest-canonical', baseManifest.ok
    && hashCanonical(baseManifest.manifest) === prepared.evidence.applyResult.baselineManifestHash,
  baseManifest.ok ? `canonical=${hashCanonical(baseManifest.manifest)}` : baseManifest.error)
  check('base-manifest-instance', baseManifest.ok && baseManifest.manifest?.instanceId === prepared.instanceId, `expected ${prepared.instanceId}`)
  check('head-manifest-target', headManifest.ok
    && hashCanonical(headManifest.manifest) === inputs.expectedTargetManifestHash,
  headManifest.ok ? `canonical=${hashCanonical(headManifest.manifest)}` : headManifest.error)
  check('head-manifest-instance', headManifest.ok && headManifest.manifest?.instanceId === prepared.instanceId, `expected ${prepared.instanceId}`)
  check('head-blob-identity', headManifest.ok
    && files?.files?.length === 1
    && files.files[0]?.sha === githubEvidence.headManifest?.sha,
  `list=${files?.files?.[0]?.sha ?? 'missing'} content=${githubEvidence.headManifest?.sha ?? 'missing'}`)

  verifyWorkflowRun(check, githubEvidence.applyRun, {
    id: inputs.applyRunId,
    attempt: inputs.applyRunAttempt,
    name: 'Apply reviewed instance bundle to Draft PR',
    branch: prepared.baseBranch,
    sha: prepared.sourceSha,
    label: 'apply',
    repository: inputs.repository,
  })
  verifyWorkflowRun(check, githubEvidence.reviewRun, {
    id: prepared.reviewRunId,
    attempt: prepared.reviewRunAttempt,
    name: 'Review instance change bundle',
    branch: null,
    sha: prepared.sourceSha,
    label: 'review',
    repository: inputs.repository,
  })

  const ci = summarizeCi(githubEvidence.checks)
  const mergeability = pr?.mergeable === true ? 'mergeable' : pr?.mergeable === false ? 'conflicting' : 'unknown'
  const ok = errors.length === 0
  const readyForReviewTransition = ok && mergeability === 'mergeable' && ci.state === 'success'
  const nextAction = nextActionFor({ ok, mergeability, ciState: ci.state, draft: pr?.draft === true })

  return deepFreeze({
    schemaVersion: 1,
    kind: 'mochi-bus-instance-bundle-apply-pr-verification',
    status: ok ? 'verified' : 'blocked',
    ok,
    repository: inputs.repository,
    pullRequestNumber: Number(inputs.pullRequestNumber),
    pullRequestUrl: pr?.htmlUrl ?? null,
    instanceId: prepared.instanceId,
    configPath: prepared.configPath,
    purpose: prepared.purpose,
    testOnly: prepared.testOnly,
    e2eFixture: prepared.e2eFixture,
    base: { branch: prepared.baseBranch, sha: prepared.sourceSha },
    head: { branch: prepared.headBranch, sha: pr?.head?.sha ?? null },
    hashes: {
      bundleHash: inputs.expectedBundleHash,
      artifactHash: inputs.expectedArtifactHash,
      targetManifestHash: inputs.expectedTargetManifestHash,
    },
    review: {
      runId: prepared.reviewRunId,
      runAttempt: prepared.reviewRunAttempt,
      artifactName: prepared.evidence.provenance.artifactName,
    },
    apply: {
      runId: inputs.applyRunId,
      runAttempt: inputs.applyRunAttempt,
      artifactName: inputs.artifactName,
    },
    pullRequest: {
      state: pr?.state ?? null,
      draft: pr?.draft ?? null,
      mergeability,
      changedFiles: pr?.changedFiles ?? null,
      commits: pr?.commits ?? null,
    },
    ci,
    readyForReviewTransition,
    nextAction,
    summary: {
      total: checks.length,
      passed: checks.filter((item) => item.ok).length,
      failed: checks.filter((item) => !item.ok).length,
    },
    checks,
    errors,
  })
}

export async function runApplyPrVerification(inputs, {
  cwd = process.cwd(),
  stdout = process.stdout,
} = {}) {
  const report = await verifyInstanceBundleApplyPullRequest(inputs, { cwd })
  const resultPath = resolve(cwd, inputs.resultDirectory, 'verification.json')
  await ensureGeneratedDirectory(cwd, dirname(resultPath))
  await writeExclusiveText(resultPath, `${JSON.stringify(report, null, 2)}\n`)
  await appendFile(inputs.summaryPath, renderApplyPrVerificationMarkdown(report), 'utf8')
  await appendWorkflowOutputs(inputs.outputPath, {
    verification_status: report.status,
    ready_for_review_transition: report.readyForReviewTransition ? 'true' : 'false',
    ci_state: report.ci.state,
    verification_path: displayPath(cwd, resultPath),
  })
  stdout.write(`${JSON.stringify({
    message: 'instance_bundle_apply_pr_verified',
    status: report.status,
    pullRequestNumber: report.pullRequestNumber,
    readyForReviewTransition: report.readyForReviewTransition,
    ciState: report.ci.state,
  })}\n`)
  if (!report.ok) throw new Error(`instance:verify-apply-pr blocked with ${report.summary.failed} failed checks`)
  return report
}

export function renderApplyPrVerificationMarkdown(report) {
  const lines = [
    '## Reviewed instance bundle Draft PR verification',
    '',
    `**${report.status.toUpperCase()}** · PR ${markdownCodeSpan(`#${report.pullRequestNumber}`)} · ${markdownCodeSpan(report.instanceId)}`,
    '',
    `- Manifest: ${markdownCodeSpan(report.configPath)}`,
    `- Base: ${markdownCodeSpan(`${report.base.branch}@${report.base.sha}`)}`,
    `- Head: ${markdownCodeSpan(`${report.head.branch}@${report.head.sha ?? 'missing'}`)}`,
    `- Bundle SHA-256: ${markdownCodeSpan(report.hashes.bundleHash)}`,
    `- Artifact SHA-256: ${markdownCodeSpan(report.hashes.artifactHash)}`,
    `- Target manifest SHA-256: ${markdownCodeSpan(report.hashes.targetManifestHash)}`,
    `- Mergeability: ${markdownCodeSpan(report.pullRequest.mergeability)}`,
    `- Formal CI: ${markdownCodeSpan(report.ci.state)} (${report.ci.total} observations)`,
    `- Ready for human Ready-for-review transition: **${report.readyForReviewTransition ? 'yes' : 'no'}**`,
    '',
    `Checks: **${report.summary.passed} passed**, **${report.summary.failed} failed**`,
  ]
  if (report.errors.length > 0) {
    lines.push('', '### Blockers', '', ...indentedEvidence(report.errors))
  }
  lines.push('', '### Next action', '', indentedEvidence([report.nextAction])[0], '')
  return `${lines.join('\n')}\n`
}

export function instanceBundleApplyPrVerificationUsage() {
  return `Verify a generated reviewed-instance-bundle Draft PR without modifying the PR or repository.\n\nUsage inside GitHub Actions:\n  npm run instance:verify-apply-pr -- --preflight\n  npm run instance:verify-apply-pr -- --prepare\n  npm run instance:verify-apply-pr -- --verify\n\nThe workflow downloads persisted apply evidence, collects immutable GitHub metadata through read-only API calls, then performs an offline cross-check. It never writes a manifest, pushes a branch, edits a PR, compiles, deploys, runs Wrangler or contacts Cloudflare.\n`
}

export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  cwd = process.cwd(),
  stdout = process.stdout,
} = {}) {
  const mode = parseInstanceBundleApplyPrVerificationMode(argv)
  if (mode === 'help') {
    stdout.write(instanceBundleApplyPrVerificationUsage())
    return null
  }
  const inputs = parseInstanceBundleApplyPrVerificationInputs(env)
  if (mode === 'preflight') return runApplyPrVerificationPreflight(inputs, { stdout })
  if (mode === 'prepare') return runApplyPrVerificationPrepare(inputs, { cwd, stdout })
  return runApplyPrVerification(inputs, { cwd, stdout })
}

async function readApplyEvidence(inputs, { cwd }) {
  const root = resolve(cwd)
  const download = resolve(root, inputs.downloadDirectory)
  await assertRealDirectoryWithin(root, download, inputs.downloadDirectory)
  await assertExactEntries(download, ['apply-input', 'apply-pr'])

  const applyInput = resolve(download, 'apply-input')
  await assertRealDirectoryWithin(root, applyInput, 'downloaded apply-input')
  await assertExactEntries(applyInput, APPLY_INPUT_FILES)

  const applyPr = resolve(download, 'apply-pr')
  await assertRealDirectoryWithin(root, applyPr, 'downloaded apply-pr')
  const workflowDirectoryName = `workflow-${inputs.applyRunId}-${inputs.applyRunAttempt}`
  await assertExactEntries(applyPr, [workflowDirectoryName])
  const workflowDirectory = resolve(applyPr, workflowDirectoryName)
  await assertRealDirectoryWithin(root, workflowDirectory, 'downloaded apply result directory')
  await assertExactEntries(workflowDirectory, APPLY_RESULT_FILES)

  const [bundle, verification, freshness, applyResult, provenance, prBody] = await Promise.all([
    readBoundedStrictJson(resolve(applyInput, 'bundle.json'), 8 * 1024 * 1024),
    readBoundedStrictJson(resolve(applyInput, 'verification.json'), MAX_JSON_BYTES),
    readBoundedStrictJson(resolve(applyInput, 'freshness.json'), MAX_JSON_BYTES),
    readBoundedStrictJson(resolve(workflowDirectory, 'apply-result.json'), MAX_JSON_BYTES),
    readBoundedStrictJson(resolve(workflowDirectory, 'provenance.json'), MAX_JSON_BYTES),
    readBoundedText(resolve(workflowDirectory, 'pr-body.md'), MAX_BODY_BYTES),
  ])
  return deepFreeze({ bundle, verification, freshness, applyResult, provenance, prBody })
}

async function readGithubEvidence(inputs, { cwd }) {
  const root = resolve(cwd)
  const directory = resolve(root, inputs.githubEvidenceDirectory)
  await assertRealDirectoryWithin(root, directory, inputs.githubEvidenceDirectory)
  await assertExactEntries(directory, GITHUB_EVIDENCE_FILES)
  const values = await Promise.all(GITHUB_EVIDENCE_FILES.map((name) => readBoundedStrictJson(resolve(directory, name), name.includes('manifest') ? MAX_MANIFEST_BYTES * 2 : MAX_JSON_BYTES)))
  return deepFreeze({
    applyRun: values[0],
    baseManifest: values[1],
    checks: values[2],
    commits: values[3],
    files: values[4],
    headCommit: values[5],
    headManifest: values[6],
    pullRequest: values[7],
    reviewRun: values[8],
  })
}

function decodeManifestSnapshot(snapshot, expectedPath, label) {
  try {
    if (snapshot?.schemaVersion !== 1 || snapshot?.type !== 'file') throw new Error(`${label} is not a file snapshot`)
    if (snapshot?.path !== expectedPath) throw new Error(`${label} path differs from reviewed manifest`)
    if (snapshot?.encoding !== 'base64' || typeof snapshot?.content !== 'string') throw new Error(`${label} does not contain base64 content`)
    if (!validGitSha(snapshot?.sha)) throw new Error(`${label} blob SHA is invalid`)
    const compact = snapshot.content.replace(/\s+/g, '')
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) throw new Error(`${label} contains invalid base64`)
    const bytes = Buffer.from(compact, 'base64')
    if (bytes.length === 0 || bytes.length > MAX_MANIFEST_BYTES) throw new Error(`${label} size is outside the allowed range`)
    if (snapshot.size !== bytes.length) throw new Error(`${label} size metadata does not match decoded bytes`)
    const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    if (Buffer.byteLength(source, 'utf8') !== bytes.length) throw new Error(`${label} UTF-8 bytes did not round-trip exactly`)
    const manifest = parseStrictJson(source)
    if (!isPlainObject(manifest)) throw new Error(`${label} must parse to a JSON object`)
    return { ok: true, source, manifest }
  } catch (error) {
    return { ok: false, error: errorMessage(error), source: null, manifest: null }
  }
}

function verifyWorkflowRun(check, run, expected) {
  check(`${expected.label}-run-schema`, run?.schemaVersion === 1, `${expected.label}-run.json must use schema version 1`)
  check(`${expected.label}-run-id`, String(run?.id) === expected.id, `expected ${expected.id}, received ${run?.id ?? 'missing'}`)
  check(`${expected.label}-run-attempt`, String(run?.runAttempt) === expected.attempt, `expected ${expected.attempt}, received ${run?.runAttempt ?? 'missing'}`)
  check(`${expected.label}-run-repository`, run?.repository === expected.repository, `expected ${expected.repository}`)
  check(`${expected.label}-run-workflow`, run?.name === expected.name && run?.event === 'workflow_dispatch', `name=${run?.name ?? 'missing'} event=${run?.event ?? 'missing'}`)
  check(`${expected.label}-run-success`, run?.status === 'completed' && run?.conclusion === 'success', `status=${run?.status ?? 'missing'} conclusion=${run?.conclusion ?? 'missing'}`)
  const branchMatches = expected.branch === null || run?.headBranch === expected.branch
  check(`${expected.label}-run-source`, branchMatches && run?.headSha === expected.sha, expected.branch === null ? `expected SHA ${expected.sha}` : `expected ${expected.branch}@${expected.sha}`)
}

function summarizeCi(value) {
  const checkRuns = latestByKey(
    (Array.isArray(value?.checkRuns) ? value.checkRuns : []).filter((item) => item?.name !== 'verify-apply-pr'),
    (item) => `${item?.appSlug ?? 'unknown'}:${item?.name ?? 'unknown'}`,
  )
  const statuses = latestByKey(
    Array.isArray(value?.statuses) ? value.statuses : [],
    (item) => item?.context ?? 'unknown',
  )
  const failures = []
  const pending = []
  for (const item of checkRuns) {
    if (item.status !== 'completed') pending.push(`check:${item.name}`)
    else if (!['success', 'neutral', 'skipped'].includes(item.conclusion)) failures.push(`check:${item.name}:${item.conclusion ?? 'missing'}`)
  }
  for (const item of statuses) {
    if (item.state === 'pending') pending.push(`status:${item.context}`)
    else if (!['success'].includes(item.state)) failures.push(`status:${item.context}:${item.state ?? 'missing'}`)
  }
  if (statuses.length > 0) {
    if (value?.combinedState === 'failure' || value?.combinedState === 'error') failures.push(`combined:${value.combinedState}`)
    else if (value?.combinedState === 'pending') pending.push('combined:pending')
  }
  const total = checkRuns.length + statuses.length
  const state = failures.length > 0 ? 'failed' : pending.length > 0 ? 'pending' : total === 0 ? 'missing' : 'success'
  return deepFreeze({ state, total, checkRuns: checkRuns.length, statuses: statuses.length, failures, pending })
}

function latestByKey(values, keyFor) {
  const seen = new Set()
  const result = []
  for (const value of values) {
    const key = keyFor(value)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(value)
  }
  return result
}

function nextActionFor({ ok, mergeability, ciState, draft }) {
  if (!ok) return 'Regenerate or repair the Draft PR so every persisted identity, SHA, diff and manifest check matches, then verify again.'
  if (mergeability === 'conflicting') return 'Rebase or regenerate the apply PR from the current base branch; do not mark it ready.'
  if (mergeability === 'unknown') return 'Wait for GitHub to calculate mergeability, then run the verifier again.'
  if (ciState === 'missing') return 'Dispatch the existing CI workflow on the isolated apply branch, then run this verification again.'
  if (ciState === 'pending') return 'Wait for formal CI to finish, then run this verification again.'
  if (ciState === 'failed') return 'Inspect and fix formal CI on the isolated apply branch before any Ready-for-review transition.'
  if (draft) return 'The evidence, single-manifest diff and formal CI are consistent; a human may review the summary and decide whether to mark the PR ready.'
  return 'The PR is no longer Draft; confirm that this state change was intentional before merging.'
}

function renderPreflightMarkdown(inputs) {
  return `${[
    '## Apply-PR verification preflight',
    '',
    `- Pull request: ${markdownCodeSpan(`#${inputs.pullRequestNumber}`)}`,
    `- Apply run: ${markdownCodeSpan(inputs.applyRunId)}`,
    `- Apply artifact: ${markdownCodeSpan(inputs.artifactName)}`,
    '',
    'Immutable input syntax passed. No artifact was downloaded and no PR or repository content was changed by this step.',
    '',
  ].join('\n')}\n`
}

function renderPrepareMarkdown(prepared) {
  return `${[
    '## Persisted apply evidence verified',
    '',
    `- Instance: ${markdownCodeSpan(prepared.instanceId)}`,
    `- Manifest: ${markdownCodeSpan(prepared.configPath)}`,
    `- Base: ${markdownCodeSpan(`${prepared.baseBranch}@${prepared.sourceSha}`)}`,
    `- Expected head branch: ${markdownCodeSpan(prepared.headBranch)}`,
    '',
    'The complete apply artifact, original review evidence, atomic apply result, provenance and deterministic PR body are internally consistent. GitHub metadata has not yet been trusted.',
    '',
  ].join('\n')}\n`
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
  if (!sameJson(names, wanted)) throw new Error(`${displayPath(process.cwd(), path)} must contain exactly ${wanted.join(', ')}`)
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
  if (!shown || shown === '..' || shown.startsWith(`..${sep}`) || isAbsolute(shown)) throw new Error('Verification output must stay inside .generated')
  await mkdir(path, { recursive: true, mode: 0o700 })
}

async function writeExclusiveText(path, value) {
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile(value, 'utf8')
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

function parseApplyArtifactName(value) {
  const match = /^instance-bundle-apply-([a-z0-9](?:[a-z0-9-]{0,62}))-(\d+)-(\d+)$/.exec(value)
  if (!match || !INSTANCE_ID_PATTERN.test(match[1])) throw new Error('artifact_name must use instance-bundle-apply-<instance-id>-<run-id>-<attempt>')
  return Object.freeze({ instanceId: match[1], applyRunId: match[2], applyRunAttempt: match[3] })
}

function parseReviewArtifactName(value) {
  const match = /^instance-bundle-review-([a-z0-9](?:[a-z0-9-]{0,62}))-(\d+)-(\d+)$/.exec(String(value ?? ''))
  if (!match || !INSTANCE_ID_PATTERN.test(match[1])) throw new Error('provenance review artifact name is invalid')
  return Object.freeze({ instanceId: match[1], reviewRunId: match[2], reviewRunAttempt: match[3] })
}

function safeManifestPath(value) {
  if (typeof value !== 'string' || !value || isAbsolute(value) || UNSAFE_INPUT_PATTERN.test(value)) return null
  const normalized = value.replaceAll('\\', '/')
  if (normalized.split('/').some((segment) => segment === '.' || segment === '..')) return null
  if (normalized !== 'instance.json' && !(normalized.startsWith('instances/') && normalized.endsWith('.json'))) return null
  return normalized
}

function safeRef(value) {
  if (typeof value !== 'string' || !SAFE_REF_PATTERN.test(value) || value.includes('..') || value.includes('@{') || value.includes('//') || value.includes('\\') || value.endsWith('.') || value.endsWith('/')) return null
  return value
}

function validGitSha(value) {
  return typeof value === 'string' && GIT_SHA_PATTERN.test(value) ? value : null
}

function requiredHash(value, name) {
  const normalized = requiredSingleLine(value, name, 64).toLowerCase()
  if (!SHA256_PATTERN.test(normalized)) throw new Error(`${name} must be a lowercase SHA-256 digest`)
  return normalized
}

function requiredDigits(value, name) {
  const normalized = requiredSingleLine(value, name, MAX_DIGIT_BYTES)
  if (!/^\d+$/.test(normalized)) throw new Error(`${name} must contain only decimal digits`)
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
  return values.flatMap((value) => String(value).replace(/\r\n?/g, '\n').split('\n')).map((line) => `    ${line.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu, '\ufffd')}`)
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean).map(String))]
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
