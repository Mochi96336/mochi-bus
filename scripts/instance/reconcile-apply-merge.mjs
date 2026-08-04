import { constants } from 'node:fs'
import {
  appendFile,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { pathToFileURL } from 'node:url'
import {
  compileInstanceConfig,
  loadInstanceConfig,
  rebaseWranglerConfig,
} from './config.mjs'
import { diagnoseInstance } from './doctor.mjs'
import {
  hashCanonical,
  parseStrictJson,
  sha256,
} from './bundle-integrity.mjs'
import { prepareInstanceBundleApplyPrVerification } from './verify-apply-pr.mjs'

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
const DOWNLOAD_DIRECTORY = '.generated/reconcile-apply-merge/download'
const GITHUB_EVIDENCE_DIRECTORY = '.generated/reconcile-apply-merge/github'
const COMPILED_DIRECTORY = '.generated/reconcile-apply-merge/compiled'
const RESULT_DIRECTORY = '.generated/reconcile-apply-merge/result'
const GITHUB_EVIDENCE_FILES = Object.freeze([
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

export function parseInstanceBundleApplyMergeReconciliationInputs(env = process.env) {
  if (String(env.GITHUB_ACTIONS ?? '').toLowerCase() !== 'true') {
    throw new Error('The apply-merge reconciler is available only inside GitHub Actions')
  }
  const confirmation = requiredExact(env.INPUT_CONFIRMATION, 'confirmation')
  if (confirmation !== 'RECONCILE') {
    throw new Error('Apply-merge reconciliation requires confirmation RECONCILE')
  }

  const pullRequestNumber = requiredDigits(env.INPUT_PULL_REQUEST_NUMBER, 'pull_request_number')
  if (pullRequestNumber === '0') throw new Error('pull_request_number must be greater than zero')
  const applyRunId = requiredDigits(env.INPUT_APPLY_RUN_ID, 'apply_run_id')
  const artifactName = requiredSingleLine(env.INPUT_ARTIFACT_NAME, 'artifact_name', 256)
  const artifactIdentity = parseApplyArtifactName(artifactName)
  if (artifactIdentity.applyRunId !== applyRunId) {
    throw new Error('artifact_name apply run ID must match apply_run_id')
  }

  const repository = requiredSingleLine(env.GITHUB_REPOSITORY, 'GITHUB_REPOSITORY', 200)
  if (!REPOSITORY_PATTERN.test(repository)) throw new Error('GITHUB_REPOSITORY must use owner/name')
  const sourceRef = requiredSingleLine(env.GITHUB_REF, 'GITHUB_REF', 256)
  if (!sourceRef.startsWith('refs/heads/')) {
    throw new Error('Apply-merge reconciliation must be dispatched from a branch ref')
  }
  const currentBranch = safeRef(sourceRef.slice('refs/heads/'.length))
  if (!currentBranch) throw new Error('GITHUB_REF contains an unsafe branch name')

  return deepFreeze({
    confirmation,
    pullRequestNumber,
    applyRunId,
    applyRunAttempt: artifactIdentity.applyRunAttempt,
    artifactName,
    artifactInstanceId: artifactIdentity.instanceId,
    expectedBundleHash: requiredHash(env.INPUT_EXPECTED_BUNDLE_HASH, 'expected_bundle_hash'),
    expectedArtifactHash: requiredHash(env.INPUT_EXPECTED_ARTIFACT_HASH, 'expected_artifact_hash'),
    expectedTargetManifestHash: requiredHash(
      env.INPUT_EXPECTED_TARGET_MANIFEST_HASH,
      'expected_target_manifest_hash',
    ),
    repository,
    sourceRef,
    currentBranch,
    currentSha: requiredGitSha(env.GITHUB_SHA, 'GITHUB_SHA'),
    reconciliationRunId: requiredDigits(env.GITHUB_RUN_ID, 'GITHUB_RUN_ID'),
    reconciliationRunAttempt: requiredDigits(env.GITHUB_RUN_ATTEMPT, 'GITHUB_RUN_ATTEMPT'),
    summaryPath: requiredPath(env.GITHUB_STEP_SUMMARY, 'GITHUB_STEP_SUMMARY'),
    outputPath: requiredPath(env.GITHUB_OUTPUT, 'GITHUB_OUTPUT'),
    downloadDirectory: DOWNLOAD_DIRECTORY,
    githubEvidenceDirectory: GITHUB_EVIDENCE_DIRECTORY,
    compiledDirectory: COMPILED_DIRECTORY,
    resultDirectory: RESULT_DIRECTORY,
  })
}

export function parseInstanceBundleApplyMergeReconciliationMode(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === '--help') return 'help'
  if (argv.length !== 1 || !['--preflight', '--prepare', '--reconcile'].includes(argv[0])) {
    throw new Error('Usage: node scripts/instance/reconcile-apply-merge.mjs --preflight|--prepare|--reconcile|--help')
  }
  return argv[0].slice(2)
}

export async function runApplyMergeReconciliationPreflight(inputs, { stdout = process.stdout } = {}) {
  const outputs = Object.freeze({
    pull_request_number: inputs.pullRequestNumber,
    apply_run_id: inputs.applyRunId,
    artifact_name: inputs.artifactName,
    current_branch: inputs.currentBranch,
    current_sha: inputs.currentSha,
  })
  await appendWorkflowOutputs(inputs.outputPath, outputs)
  await appendFile(inputs.summaryPath, renderPreflightMarkdown(inputs), 'utf8')
  stdout.write(`${JSON.stringify({
    message: 'instance_bundle_apply_merge_reconciliation_preflight',
    pullRequestNumber: inputs.pullRequestNumber,
    applyRunId: inputs.applyRunId,
    currentBranch: inputs.currentBranch,
    currentSha: inputs.currentSha,
  })}\n`)
  return deepFreeze({ inputs, outputs })
}

export async function prepareInstanceBundleApplyMergeReconciliation(inputs, {
  cwd = process.cwd(),
  dependencies = {},
} = {}) {
  const prepareApply = dependencies.prepareApply ?? prepareInstanceBundleApplyPrVerification
  const applyInputs = deepFreeze({
    ...inputs,
    verificationRunId: inputs.reconciliationRunId,
    verificationRunAttempt: inputs.reconciliationRunAttempt,
    githubEvidenceDirectory: inputs.githubEvidenceDirectory,
    resultDirectory: inputs.resultDirectory,
  })
  const prepared = await prepareApply(applyInputs, { cwd })
  if (prepared.baseBranch !== inputs.currentBranch) {
    throw new Error(`Merged apply PR base ${prepared.baseBranch} does not match dispatch branch ${inputs.currentBranch}`)
  }
  return deepFreeze({ inputs, applyInputs, prepared })
}

export async function runApplyMergeReconciliationPrepare(inputs, {
  cwd = process.cwd(),
  stdout = process.stdout,
  dependencies = {},
} = {}) {
  const result = await prepareInstanceBundleApplyMergeReconciliation(inputs, { cwd, dependencies })
  const outputs = Object.freeze({
    pull_request_number: inputs.pullRequestNumber,
    apply_run_id: inputs.applyRunId,
    review_run_id: result.prepared.reviewRunId,
    config_path: result.prepared.configPath,
    base_branch: result.prepared.baseBranch,
    source_sha: result.prepared.sourceSha,
    apply_head_branch: result.prepared.headBranch,
    instance_id: result.prepared.instanceId,
    current_branch: inputs.currentBranch,
    current_sha: inputs.currentSha,
  })
  await appendWorkflowOutputs(inputs.outputPath, outputs)
  await appendFile(inputs.summaryPath, renderPrepareMarkdown(result), 'utf8')
  stdout.write(`${JSON.stringify({
    message: 'instance_bundle_apply_merge_evidence_prepared',
    pullRequestNumber: inputs.pullRequestNumber,
    instanceId: result.prepared.instanceId,
    configPath: result.prepared.configPath,
    currentBranch: inputs.currentBranch,
    currentSha: inputs.currentSha,
  })}\n`)
  return deepFreeze({ ...result, outputs })
}

export async function reconcileInstanceBundleApplyMerge(inputs, {
  cwd = process.cwd(),
  env = process.env,
  dependencies = {},
} = {}) {
  const preparation = await prepareInstanceBundleApplyMergeReconciliation(inputs, { cwd, dependencies })
  const prepared = preparation.prepared
  const githubEvidence = dependencies.githubEvidence
    ?? await readGithubEvidence(inputs, { cwd })
  const generated = dependencies.generated
    ?? await inspectGeneratedArtifacts(inputs, prepared, { cwd })
  const diagnose = dependencies.diagnose ?? diagnoseInstance
  const doctor = dependencies.doctor ?? await diagnose({
    cwd,
    env,
    configPath: prepared.configPath,
    outputDirectory: inputs.compiledDirectory,
    remote: false,
    fetchImpl: async () => {
      throw new Error('Remote access is disabled during apply-merge reconciliation')
    },
  })
  return evaluateInstanceBundleApplyMerge({
    inputs,
    prepared,
    githubEvidence,
    generated,
    doctor,
  })
}

export function evaluateInstanceBundleApplyMerge({
  inputs,
  prepared,
  githubEvidence,
  generated,
  doctor,
}) {
  const checks = []
  const errors = []
  const check = (id, ok, detail) => {
    const item = Object.freeze({ id, ok: Boolean(ok), detail: String(detail) })
    checks.push(item)
    if (!item.ok) errors.push(`${id}: ${item.detail}`)
  }

  const pr = githubEvidence.pullRequest
  check('pr-schema', pr?.schemaVersion === 1, 'pull-request.json must use schema version 1')
  check('pr-number', String(pr?.number) === inputs.pullRequestNumber, `expected ${inputs.pullRequestNumber}, received ${pr?.number ?? 'missing'}`)
  check('pr-repository', pr?.repository === inputs.repository, `expected ${inputs.repository}, received ${pr?.repository ?? 'missing'}`)
  check('pr-merged', pr?.state === 'closed' && pr?.merged === true && validGitSha(pr?.mergeCommitSha), `state=${pr?.state ?? 'missing'} merged=${String(pr?.merged)} merge=${pr?.mergeCommitSha ?? 'missing'}`)
  check('pr-not-draft', pr?.draft === false, `draft=${String(pr?.draft)}`)
  check('pr-same-repository', pr?.base?.repository === inputs.repository && pr?.head?.repository === inputs.repository, 'base and head repositories must match the workflow repository')
  check('base-branch', pr?.base?.ref === inputs.currentBranch && pr?.base?.ref === prepared.baseBranch, `expected ${inputs.currentBranch}, received ${pr?.base?.ref ?? 'missing'}`)
  check('head-branch', pr?.head?.ref === prepared.headBranch, `expected ${prepared.headBranch}, received ${pr?.head?.ref ?? 'missing'}`)
  check('head-sha', validGitSha(pr?.head?.sha), `received ${pr?.head?.sha ?? 'missing'}`)
  check('pr-title', pr?.title === prepared.expectedPrTitle, `expected ${prepared.expectedPrTitle}`)
  check('pr-body', pr?.body === prepared.evidence.prBody, 'merged PR body must match persisted deterministic PR body')
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
  check('single-head-commit', commits?.commits?.length === 1 && commits.commits[0]?.sha === pr?.head?.sha, 'merged PR must preserve exactly the reviewed head commit')
  check('head-commit-schema', headCommit?.schemaVersion === 1 && headCommit?.sha === pr?.head?.sha, 'head-commit.json must describe the reviewed PR head')
  check('head-parent', headCommit?.parents?.length === 1 && headCommit.parents[0] === prepared.sourceSha, `head must have exactly parent ${prepared.sourceSha}`)
  check('commit-message', headCommit?.message === prepared.expectedCommitMessage, `expected ${prepared.expectedCommitMessage}`)

  const mergeCommit = githubEvidence.mergeCommit
  check('merge-commit-schema', mergeCommit?.schemaVersion === 1 && mergeCommit?.sha === pr?.mergeCommitSha, 'merge-commit.json must describe the PR merge commit')
  check('merge-commit-tree', validGitSha(mergeCommit?.treeSha), `tree=${mergeCommit?.treeSha ?? 'missing'}`)
  check('merge-commit-parent', Array.isArray(mergeCommit?.parents) && mergeCommit.parents.length >= 1, `parents=${mergeCommit?.parents?.length ?? 'missing'}`)

  const branch = githubEvidence.branch
  check('branch-schema', branch?.schemaVersion === 1, 'branch.json must use schema version 1')
  check('branch-name', branch?.name === inputs.currentBranch, `expected ${inputs.currentBranch}, received ${branch?.name ?? 'missing'}`)
  check('branch-snapshot', branch?.sha === inputs.currentSha, `expected ${inputs.currentSha}, received ${branch?.sha ?? 'missing'}`)

  const comparison = githubEvidence.compare
  const ancestryOk = comparison?.schemaVersion === 1
    && comparison?.baseSha === pr?.mergeCommitSha
    && comparison?.headSha === inputs.currentSha
    && ['identical', 'ahead'].includes(comparison?.status)
    && comparison?.behindBy === 0
  check('merge-ancestry', ancestryOk, `status=${comparison?.status ?? 'missing'} ahead=${comparison?.aheadBy ?? 'missing'} behind=${comparison?.behindBy ?? 'missing'}`)

  const headManifest = decodeManifestSnapshot(githubEvidence.headManifest, prepared.configPath, 'head manifest')
  const mergeManifest = decodeManifestSnapshot(githubEvidence.mergeManifest, prepared.configPath, 'merge manifest')
  const currentManifest = decodeManifestSnapshot(githubEvidence.currentManifest, prepared.configPath, 'current manifest')
  verifyTargetManifest(check, headManifest, prepared.instanceId, inputs.expectedTargetManifestHash, 'head')
  verifyTargetManifest(check, mergeManifest, prepared.instanceId, inputs.expectedTargetManifestHash, 'merge')
  verifyTargetManifest(check, currentManifest, prepared.instanceId, inputs.expectedTargetManifestHash, 'current')
  check('head-blob-identity', headManifest.ok
    && files?.files?.length === 1
    && files.files[0]?.sha === githubEvidence.headManifest?.sha,
  `list=${files?.files?.[0]?.sha ?? 'missing'} content=${githubEvidence.headManifest?.sha ?? 'missing'}`)
  check('merge-preserved-target-bytes', headManifest.ok && mergeManifest.ok && mergeManifest.source === headManifest.source, 'merge commit manifest bytes must equal the reviewed PR head')
  check('current-preserved-target-bytes', mergeManifest.ok && currentManifest.ok && currentManifest.source === mergeManifest.source, 'current branch manifest bytes must still equal the merged target')

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

  check('generated-schema', generated?.schemaVersion === 1, 'generated evidence must use schema version 1')
  check('generated-manifest-hash', generated?.manifestHash === inputs.expectedTargetManifestHash, `expected ${inputs.expectedTargetManifestHash}, received ${generated?.manifestHash ?? 'missing'}`)
  check('generated-runtime', generated?.artifacts?.runtime?.matched === true, generated?.artifacts?.runtime?.detail ?? 'runtime evidence missing')
  check('generated-wrangler', generated?.artifacts?.wrangler?.matched === true, generated?.artifacts?.wrangler?.detail ?? 'wrangler evidence missing')
  check('generated-operations', generated?.artifacts?.operations?.matched === true, generated?.artifacts?.operations?.detail ?? 'operations evidence missing')
  check('generated-set-hash', SHA256_PATTERN.test(generated?.generatedSetHash ?? ''), `received ${generated?.generatedSetHash ?? 'missing'}`)

  check('doctor-schema', doctor?.schemaVersion === 1, 'doctor report must use schema version 1')
  check('doctor-manifest', doctor?.manifest?.status === 'ready'
    && doctor.manifest.instanceId === prepared.instanceId
    && doctor.manifest.path === prepared.configPath,
  `status=${doctor?.manifest?.status ?? 'missing'} instance=${doctor?.manifest?.instanceId ?? 'missing'} path=${doctor?.manifest?.path ?? 'missing'}`)
  check('doctor-generated', Array.isArray(doctor?.generated)
    && doctor.generated.length === 3
    && doctor.generated.every((artifact) => artifact.status === 'ready'),
  `statuses=${(doctor?.generated ?? []).map((artifact) => artifact?.status ?? 'missing').join(',') || 'missing'}`)
  check('doctor-no-remote', doctor?.remote?.requested === false && doctor?.remote?.status === 'not_checked', `requested=${String(doctor?.remote?.requested)} status=${doctor?.remote?.status ?? 'missing'}`)

  const contentErrors = [...errors]
  const contentReconciled = contentErrors.length === 0
  const localDoctorReady = contentReconciled && doctor?.ok === true
  const status = !contentReconciled ? 'blocked' : localDoctorReady ? 'reconciled' : 'locally_blocked'
  const localBlockers = contentReconciled && !localDoctorReady
    ? collectDoctorBlockers(doctor)
    : []
  const nextAction = reconciliationNextAction({ status, localBlockers })

  return deepFreeze({
    schemaVersion: 1,
    kind: 'mochi-bus-instance-bundle-apply-merge-reconciliation',
    status,
    ok: status !== 'blocked',
    contentReconciled,
    localDoctorReady,
    remoteVerified: false,
    deploymentReady: false,
    repository: inputs.repository,
    pullRequestNumber: Number(inputs.pullRequestNumber),
    pullRequestUrl: pr?.htmlUrl ?? null,
    instanceId: prepared.instanceId,
    configPath: prepared.configPath,
    current: {
      branch: inputs.currentBranch,
      sha: inputs.currentSha,
      commitsAfterMerge: ancestryOk ? comparison.aheadBy : null,
    },
    merge: {
      sha: pr?.mergeCommitSha ?? null,
      mergedAt: pr?.mergedAt ?? null,
      mergedBy: pr?.mergedBy ?? null,
    },
    hashes: {
      bundleHash: inputs.expectedBundleHash,
      artifactHash: inputs.expectedArtifactHash,
      targetManifestHash: inputs.expectedTargetManifestHash,
      generatedSetHash: generated?.generatedSetHash ?? null,
      runtimeHash: generated?.artifacts?.runtime?.canonicalHash ?? null,
      wranglerHash: generated?.artifacts?.wrangler?.canonicalHash ?? null,
      operationsHash: generated?.artifacts?.operations?.canonicalHash ?? null,
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
    doctor: {
      ok: doctor?.ok === true,
      manifestStatus: doctor?.manifest?.status ?? null,
      generatedStatuses: (doctor?.generated ?? []).map((artifact) => ({
        key: artifact.key,
        status: artifact.status,
      })),
      environmentStatus: doctor?.environment?.status ?? null,
      operationStatuses: (doctor?.operations ?? []).map((operation) => ({
        name: operation.name,
        status: operation.status,
      })),
      remoteStatus: doctor?.remote?.status ?? null,
      blockers: localBlockers,
    },
    summary: {
      total: checks.length,
      passed: checks.filter((item) => item.ok).length,
      failed: checks.filter((item) => !item.ok).length,
    },
    checks,
    errors,
    nextAction,
  })
}

export async function runApplyMergeReconciliation(inputs, {
  cwd = process.cwd(),
  env = process.env,
  stdout = process.stdout,
  dependencies = {},
} = {}) {
  const report = await reconcileInstanceBundleApplyMerge(inputs, { cwd, env, dependencies })
  const resultPath = resolve(cwd, inputs.resultDirectory, 'reconciliation.json')
  await ensureGeneratedDirectory(cwd, dirname(resultPath))
  await writeExclusiveText(resultPath, `${JSON.stringify(report, null, 2)}\n`)
  await appendFile(inputs.summaryPath, renderApplyMergeReconciliationMarkdown(report), 'utf8')
  await appendWorkflowOutputs(inputs.outputPath, {
    reconciliation_status: report.status,
    content_reconciled: report.contentReconciled ? 'true' : 'false',
    local_doctor_ready: report.localDoctorReady ? 'true' : 'false',
    deployment_ready: 'false',
    reconciliation_path: displayPath(cwd, resultPath),
  })
  stdout.write(`${JSON.stringify({
    message: 'instance_bundle_apply_merge_reconciled',
    status: report.status,
    pullRequestNumber: report.pullRequestNumber,
    contentReconciled: report.contentReconciled,
    localDoctorReady: report.localDoctorReady,
    deploymentReady: false,
  })}\n`)
  if (report.status === 'blocked') {
    throw new Error(`instance:reconcile-apply-merge blocked with ${report.summary.failed} failed checks`)
  }
  return report
}

export function renderApplyMergeReconciliationMarkdown(report) {
  const lines = [
    '## Reviewed instance bundle merge reconciliation',
    '',
    `**${report.status.toUpperCase()}** · PR ${markdownCodeSpan(`#${report.pullRequestNumber}`)} · ${markdownCodeSpan(report.instanceId)}`,
    '',
    `- Manifest: ${markdownCodeSpan(report.configPath)}`,
    `- Current branch: ${markdownCodeSpan(`${report.current.branch}@${report.current.sha}`)}`,
    `- Merge commit: ${markdownCodeSpan(report.merge.sha ?? 'missing')}`,
    `- Commits after merge: ${markdownCodeSpan(report.current.commitsAfterMerge ?? 'unknown')}`,
    `- Target manifest SHA-256: ${markdownCodeSpan(report.hashes.targetManifestHash)}`,
    `- Generated set SHA-256: ${markdownCodeSpan(report.hashes.generatedSetHash ?? 'missing')}`,
    `- Local doctor ready: **${report.localDoctorReady ? 'yes' : 'no'}**`,
    '- Remote resources verified: **no**',
    '- Deployment ready: **no**',
    '',
    `Checks: **${report.summary.passed} passed**, **${report.summary.failed} failed**`,
  ]
  if (report.errors.length > 0) {
    lines.push('', '### Reconciliation blockers', '', ...indentedEvidence(report.errors))
  }
  if (report.doctor.blockers.length > 0) {
    lines.push('', '### Local doctor blockers', '', ...indentedEvidence(report.doctor.blockers))
  }
  lines.push('', '### Next action', '', indentedEvidence([report.nextAction])[0], '')
  return `${lines.join('\n')}\n`
}

export function instanceBundleApplyMergeReconciliationUsage() {
  return `Reconcile a merged reviewed-instance-bundle PR with the current branch, isolated generated files and the local instance doctor.\n\nUsage inside GitHub Actions:\n  npm run instance:reconcile-apply-merge -- --preflight\n  npm run instance:reconcile-apply-merge -- --prepare\n  npm run instance:reconcile-apply-merge -- --reconcile\n\nThe workflow is read-only for repository and remote resources. It writes only temporary .generated evidence, never changes the manifest, never runs Wrangler and never contacts Cloudflare.\n`
}

export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  cwd = process.cwd(),
  stdout = process.stdout,
} = {}) {
  const mode = parseInstanceBundleApplyMergeReconciliationMode(argv)
  if (mode === 'help') {
    stdout.write(instanceBundleApplyMergeReconciliationUsage())
    return null
  }
  const inputs = parseInstanceBundleApplyMergeReconciliationInputs(env)
  if (mode === 'preflight') return runApplyMergeReconciliationPreflight(inputs, { stdout })
  if (mode === 'prepare') return runApplyMergeReconciliationPrepare(inputs, { cwd, stdout })
  return runApplyMergeReconciliation(inputs, { cwd, env, stdout })
}

async function readGithubEvidence(inputs, { cwd }) {
  const root = resolve(cwd)
  const directory = resolve(root, inputs.githubEvidenceDirectory)
  await assertRealDirectoryWithin(root, directory, inputs.githubEvidenceDirectory)
  await assertExactEntries(directory, GITHUB_EVIDENCE_FILES)
  const values = await Promise.all(GITHUB_EVIDENCE_FILES.map((name) => readBoundedStrictJson(
    resolve(directory, name),
    name.includes('manifest') ? MAX_MANIFEST_BYTES * 2 : MAX_JSON_BYTES,
  )))
  return deepFreeze({
    applyRun: values[0],
    branch: values[1],
    commits: values[2],
    compare: values[3],
    currentManifest: values[4],
    files: values[5],
    headCommit: values[6],
    headManifest: values[7],
    mergeCommit: values[8],
    mergeManifest: values[9],
    pullRequest: values[10],
    reviewRun: values[11],
  })
}

async function inspectGeneratedArtifacts(inputs, prepared, { cwd }) {
  const root = resolve(cwd)
  const directory = resolve(root, inputs.compiledDirectory)
  await assertRealDirectoryWithin(root, directory, inputs.compiledDirectory)
  await assertExactEntries(directory, COMPILED_FILES)

  const configPath = resolve(root, prepared.configPath)
  const config = await loadInstanceConfig(configPath)
  const manifestHash = hashCanonical(config)
  const compiled = compileInstanceConfig(config)
  const expected = {
    runtime: compiled.runtime,
    operations: compiled.operations,
    wrangler: rebaseWranglerConfig(compiled.wrangler, directory, root),
  }
  const specifications = [
    ['runtime', 'instance-runtime.json'],
    ['operations', 'operations-plan.json'],
    ['wrangler', 'wrangler.instance.jsonc'],
  ]
  const artifacts = {}
  for (const [key, filename] of specifications) {
    const source = await readBoundedText(resolve(directory, filename), MAX_JSON_BYTES)
    const value = parseStrictJson(source)
    const matched = isDeepStrictEqual(value, expected[key])
    artifacts[key] = Object.freeze({
      path: `${inputs.compiledDirectory}/${filename}`,
      matched,
      sourceHash: sha256(source),
      canonicalHash: hashCanonical(value),
      detail: matched ? 'matches deterministic compiler output' : 'differs from deterministic compiler output',
    })
  }
  const generatedSetHash = hashCanonical({
    runtime: artifacts.runtime.canonicalHash,
    wrangler: artifacts.wrangler.canonicalHash,
    operations: artifacts.operations.canonicalHash,
  })
  return deepFreeze({ schemaVersion: 1, manifestHash, generatedSetHash, artifacts })
}

function verifyTargetManifest(check, snapshot, instanceId, targetHash, label) {
  check(`${label}-manifest-target`, snapshot.ok && hashCanonical(snapshot.manifest) === targetHash,
    snapshot.ok ? `canonical=${hashCanonical(snapshot.manifest)}` : snapshot.error)
  check(`${label}-manifest-instance`, snapshot.ok && snapshot.manifest?.instanceId === instanceId,
    `expected ${instanceId}, received ${snapshot.manifest?.instanceId ?? 'missing'}`)
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

function collectDoctorBlockers(doctor) {
  const values = [
    ...(doctor?.manifest?.blockers ?? []),
    ...(doctor?.generated ?? []).flatMap((artifact) => artifact?.blockers ?? []),
    ...(doctor?.environment?.blockers ?? []),
    ...(doctor?.operations ?? []).flatMap((operation) => operation?.blockers ?? []),
  ]
  return uniqueStrings(values)
}

function reconciliationNextAction({ status, localBlockers }) {
  if (status === 'blocked') {
    return 'Do not deploy. Repair or regenerate the reviewed merge so the artifact, merged PR, branch snapshot, manifest bytes and generated outputs agree, then reconcile again.'
  }
  if (status === 'locally_blocked') {
    return localBlockers.length > 0
      ? 'The reviewed content is reconciled. Resolve the listed local environment or operation blockers, then run doctor and reconciliation again before any deployment decision.'
      : 'The reviewed content is reconciled, but the local doctor is not ready. Run the doctor with the required local environment before any deployment decision.'
  }
  return 'The reviewed manifest, merge ancestry and isolated generated outputs are reconciled. Remote resources remain unverified; continue through the separate live doctor and deployment process.'
}

function renderPreflightMarkdown(inputs) {
  return `${[
    '## Apply-merge reconciliation preflight',
    '',
    `- Pull request: ${markdownCodeSpan(`#${inputs.pullRequestNumber}`)}`,
    `- Apply run: ${markdownCodeSpan(inputs.applyRunId)}`,
    `- Current branch: ${markdownCodeSpan(`${inputs.currentBranch}@${inputs.currentSha}`)}`,
    '',
    'Immutable input syntax passed. No artifact was downloaded, no manifest was changed and no remote resource was contacted by this step.',
    '',
  ].join('\n')}\n`
}

function renderPrepareMarkdown(result) {
  return `${[
    '## Persisted apply evidence prepared for merge reconciliation',
    '',
    `- Instance: ${markdownCodeSpan(result.prepared.instanceId)}`,
    `- Manifest: ${markdownCodeSpan(result.prepared.configPath)}`,
    `- Original base: ${markdownCodeSpan(`${result.prepared.baseBranch}@${result.prepared.sourceSha}`)}`,
    `- Current branch snapshot: ${markdownCodeSpan(`${result.inputs.currentBranch}@${result.inputs.currentSha}`)}`,
    '',
    'The complete apply artifact and original review evidence are internally consistent. The merged PR, branch ancestry, current manifest, generated outputs and doctor have not yet been trusted.',
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
  if (!shown || shown === '..' || shown.startsWith(`..${sep}`) || isAbsolute(shown)) throw new Error('Reconciliation output must stay inside .generated')
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
