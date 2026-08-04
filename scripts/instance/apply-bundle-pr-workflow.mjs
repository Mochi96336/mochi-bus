import { constants } from 'node:fs'
import {
  appendFile,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
} from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  buildInstanceBundleApply,
  parseInstanceBundleApplyArguments,
  renderInstanceBundleApplyJson,
  writeInstanceBundleApply,
} from './apply-bundle.mjs'
import { hashCanonical, parseStrictJson } from './bundle-integrity.mjs'
import { readCurrentInstanceManifest } from './check-bundle-freshness.mjs'

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const GIT_COMMIT_PATTERN = /^[a-f0-9]{40}$/
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const INSTANCE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62})$/
const SAFE_REF_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,198}[A-Za-z0-9_-])?$/
const UNSAFE_TEXT_PATTERN = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u
const UNSAFE_EVIDENCE_TEXT_GLOBAL_PATTERN = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu
const MAX_REPORT_BYTES = 1024 * 1024
const MAX_ARTIFACT_NAME_BYTES = 256
const MAX_REPOSITORY_BYTES = 200
const MAX_REF_BYTES = 256
const MAX_PATH_INPUT_BYTES = 4096
const MAX_DIGIT_INPUT_BYTES = 20
const EVIDENCE_DIRECTORY = '.generated/apply-input'
const EVIDENCE_FILENAMES = Object.freeze(['bundle.json', 'freshness.json', 'verification.json'])

export function parseInstanceBundleApplyPrWorkflowInputs(env = process.env) {
  if (String(env.GITHUB_ACTIONS ?? '').toLowerCase() !== 'true') {
    throw new Error('The instance bundle apply-PR runner is available only inside GitHub Actions')
  }

  const confirmation = requiredExactInput(env.INPUT_CONFIRMATION, 'confirmation')
  if (confirmation !== 'APPLY') {
    throw new Error('Instance bundle apply-PR requires confirmation APPLY')
  }

  const reviewRunId = requiredDigits(env.INPUT_REVIEW_RUN_ID, 'review_run_id')
  const artifactName = requiredSingleLine(env.INPUT_ARTIFACT_NAME, 'artifact_name', MAX_ARTIFACT_NAME_BYTES)
  const artifactIdentity = parseReviewArtifactName(artifactName)
  if (artifactIdentity.reviewRunId !== reviewRunId) {
    throw new Error('artifact_name review run ID must match review_run_id')
  }

  const expectedBundleHash = requiredHash(env.INPUT_EXPECTED_BUNDLE_HASH, 'expected_bundle_hash')
  const expectedArtifactHash = requiredHash(env.INPUT_EXPECTED_ARTIFACT_HASH, 'expected_artifact_hash')
  const repository = requiredSingleLine(env.GITHUB_REPOSITORY, 'GITHUB_REPOSITORY', MAX_REPOSITORY_BYTES)
  if (!REPOSITORY_PATTERN.test(repository)) throw new Error('GITHUB_REPOSITORY must be owner/name')

  const sourceRef = requiredSingleLine(env.GITHUB_REF, 'GITHUB_REF', MAX_REF_BYTES)
  if (!sourceRef.startsWith('refs/heads/')) {
    throw new Error('Apply-to-PR must be dispatched from a branch ref')
  }
  const baseBranch = validateRefName(sourceRef.slice('refs/heads/'.length), 'base branch')
  const sourceSha = requiredGitCommit(env.GITHUB_SHA, 'GITHUB_SHA')
  const applyRunId = requiredDigits(env.GITHUB_RUN_ID, 'GITHUB_RUN_ID')
  const runAttempt = requiredDigits(env.GITHUB_RUN_ATTEMPT, 'GITHUB_RUN_ATTEMPT')
  const summaryPath = requiredPathInput(env.GITHUB_STEP_SUMMARY, 'GITHUB_STEP_SUMMARY')
  const outputPath = requiredPathInput(env.GITHUB_OUTPUT, 'GITHUB_OUTPUT')
  const branchName = validateRefName(
    `agent/instance-bundle-apply-${applyRunId}-${runAttempt}`,
    'apply branch',
  )

  return deepFreeze({
    confirmation,
    reviewRunId,
    artifactName,
    artifactInstanceId: artifactIdentity.instanceId,
    reviewRunAttempt: artifactIdentity.reviewRunAttempt,
    expectedBundleHash,
    expectedArtifactHash,
    repository,
    sourceRef,
    sourceSha,
    baseBranch,
    applyRunId,
    runAttempt,
    branchName,
    summaryPath,
    outputPath,
    evidenceDirectory: EVIDENCE_DIRECTORY,
    bundlePath: `${EVIDENCE_DIRECTORY}/bundle.json`,
    resultDirectory: `.generated/apply-pr/workflow-${applyRunId}-${runAttempt}`,
  })
}

export function parseInstanceBundleApplyPrWorkflowMode(argv = process.argv.slice(2)) {
  if (argv.length !== 1 || !['--preflight', '--apply'].includes(argv[0])) {
    throw new Error('Usage: node scripts/instance/apply-bundle-pr-workflow.mjs --preflight|--apply')
  }
  return argv[0].slice(2)
}

export async function runInstanceBundleApplyPrPreflight(inputs, {
  stdout = process.stdout,
} = {}) {
  const outputs = preflightOutputs(inputs)
  await appendWorkflowOutputs(inputs.outputPath, outputs)
  await appendFile(inputs.summaryPath, renderPreflightSummary(inputs), 'utf8')
  stdout.write(`${JSON.stringify({
    message: 'instance_bundle_apply_pr_preflight',
    reviewRunId: inputs.reviewRunId,
    artifactName: inputs.artifactName,
    baseBranch: inputs.baseBranch,
    branchName: inputs.branchName,
  })}\n`)
  return deepFreeze({ inputs, outputs })
}

export async function runInstanceBundleApplyPrWorkflow(inputs, {
  cwd = process.cwd(),
  dependencies = {},
} = {}) {
  const buildApply = dependencies.buildApply ?? buildInstanceBundleApply
  const writeApply = dependencies.writeApply ?? writeInstanceBundleApply
  const readManifest = dependencies.readManifest ?? readCurrentInstanceManifest

  const evidence = await readDownloadedReviewEvidence(inputs, { cwd })
  verifyPersistedReviewReports(inputs, evidence)

  const applyOptions = parseInstanceBundleApplyArguments([
    '--input', inputs.bundlePath,
    '--expect-hash', inputs.expectedBundleHash,
    '--expect-artifact-hash', inputs.expectedArtifactHash,
  ])
  const plan = await buildApply(applyOptions, { cwd })
  if (!plan?.ready) {
    throw new Error(`Reviewed bundle cannot be applied: ${plan?.reason ?? 'unknown blocker'}`)
  }
  verifyPlanIdentity(inputs, evidence, plan)

  const written = await writeApply(plan)
  if (written !== true) throw new Error('Atomic bundle apply did not confirm a manifest write')
  const current = await readManifest(plan.configPath, { cwd })
  verifyWrittenManifest(plan, current)

  const resultDirectoryPath = resolve(cwd, inputs.resultDirectory)
  await ensureGeneratedResultDirectory(cwd, resultDirectoryPath)
  const resultPath = resolve(resultDirectoryPath, 'apply-result.json')
  const provenancePath = resolve(resultDirectoryPath, 'provenance.json')
  const prBodyPath = resolve(resultDirectoryPath, 'pr-body.md')
  const applyResult = renderInstanceBundleApplyJson(plan, { written: true })
  const provenance = buildProvenance(inputs, plan)
  const prBody = renderApplyPullRequestBody(inputs, plan, provenance)

  await writeExclusiveJson(resultPath, applyResult)
  await writeExclusiveJson(provenancePath, provenance)
  await writeExclusiveText(prBodyPath, prBody)

  const outputs = finalOutputs(inputs, plan, {
    resultPath: displayPath(cwd, resultPath),
    provenancePath: displayPath(cwd, provenancePath),
    prBodyPath: displayPath(cwd, prBodyPath),
  })
  await appendWorkflowOutputs(inputs.outputPath, outputs)
  await appendFile(inputs.summaryPath, renderApplySummary(inputs, plan, outputs), 'utf8')

  return deepFreeze({
    inputs,
    evidence,
    plan,
    current,
    applyResult,
    provenance,
    prBody,
    outputs,
  })
}

export function renderApplyPullRequestBody(inputs, plan, provenance) {
  const lines = [
    '## Reviewed instance bundle apply',
    '',
    'This Draft PR was created from a persisted review artifact. The workflow changed only the reviewed instance manifest.',
    '',
    '### Review identity',
    '',
    `- Review run: ${markdownLink(`GitHub Actions run ${inputs.reviewRunId}`, provenance.reviewRunUrl)}`,
    `- Review artifact: ${markdownCodeSpan(inputs.artifactName)}`,
    `- Bundle SHA-256: ${markdownCodeSpan(plan.bundleHash)}`,
    `- Artifact SHA-256: ${markdownCodeSpan(plan.artifactHash)}`,
    `- Target manifest SHA-256: ${markdownCodeSpan(plan.targetManifestHash)}`,
    '',
    '### Repository identity',
    '',
    `- Base branch: ${markdownCodeSpan(inputs.baseBranch)}`,
    `- Source commit: ${markdownCodeSpan(inputs.sourceSha)}`,
    `- Manifest: ${markdownCodeSpan(plan.configPath)}`,
    `- Instance: ${markdownCodeSpan(plan.instanceId)}`,
    '',
    '### Reviewed change paths',
    '',
    ...indentedEvidence(plan.changes.map((change) => change.path)),
  ]

  if (plan.warnings.length > 0) {
    lines.push('', '### Proposal warnings', '', ...indentedEvidence(plan.warnings))
  }

  lines.push(
    '',
    '### Boundaries',
    '',
    '- The workflow did not compile generated instance files.',
    '- The workflow did not run Wrangler, contact Cloudflare, provision resources, migrate D1, copy R2 objects or deploy a Worker.',
    '- The workflow did not execute commands stored inside the artifact.',
    '- A manifest write is not a deployment-readiness claim.',
    `- Projected deployment readiness: **${plan.deploymentReady ? 'yes' : 'no'}**.`,
    '',
    'Formal repository CI is separate. PRs created with the workflow token may not automatically trigger `pull_request` workflows; dispatch the existing `CI` workflow on this branch when required.',
    '',
  )
  return `${lines.join('\n')}\n`
}

export function renderPreflightSummary(inputs) {
  return `${[
    '## Instance bundle apply-to-PR preflight',
    '',
    `- Review run: ${markdownCodeSpan(inputs.reviewRunId)}`,
    `- Artifact: ${markdownCodeSpan(inputs.artifactName)}`,
    `- Base branch: ${markdownCodeSpan(inputs.baseBranch)}`,
    `- Isolated branch: ${markdownCodeSpan(inputs.branchName)}`,
    '',
    'Input syntax and immutable workflow identity passed preflight. No artifact was downloaded and no file was changed by this step.',
    '',
  ].join('\n')}\n`
}

export function renderApplySummary(inputs, plan, outputs) {
  return `${[
    '## Reviewed instance bundle applied in workflow workspace',
    '',
    `- Instance: ${markdownCodeSpan(plan.instanceId)}`,
    `- Manifest: ${markdownCodeSpan(plan.configPath)}`,
    `- Bundle SHA-256: ${markdownCodeSpan(plan.bundleHash)}`,
    `- Artifact SHA-256: ${markdownCodeSpan(plan.artifactHash)}`,
    `- Target manifest SHA-256: ${markdownCodeSpan(plan.targetManifestHash)}`,
    `- Isolated branch to create: ${markdownCodeSpan(inputs.branchName)}`,
    `- PR body: ${markdownCodeSpan(outputs.pr_body_path)}`,
    '',
    'The atomic apply and post-write target verification succeeded. No compile or deployment operation ran.',
    '',
  ].join('\n')}\n`
}

export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  cwd = process.cwd(),
  stdout = process.stdout,
} = {}) {
  const mode = parseInstanceBundleApplyPrWorkflowMode(argv)
  const inputs = parseInstanceBundleApplyPrWorkflowInputs(env)
  if (mode === 'preflight') return runInstanceBundleApplyPrPreflight(inputs, { stdout })

  const result = await runInstanceBundleApplyPrWorkflow(inputs, { cwd })
  stdout.write(`${JSON.stringify({
    message: 'instance_bundle_apply_pr_prepared',
    instanceId: result.plan.instanceId,
    configPath: result.plan.configPath,
    branchName: inputs.branchName,
    targetManifestHash: result.plan.targetManifestHash,
  })}\n`)
  return result
}

async function readDownloadedReviewEvidence(inputs, { cwd }) {
  const rootPath = resolve(cwd)
  const directoryPath = resolve(rootPath, inputs.evidenceDirectory)
  const shown = displayPath(rootPath, directoryPath)
  if (shown !== EVIDENCE_DIRECTORY) throw new Error('Review evidence directory must use the fixed generated path')

  const directoryStat = await lstat(directoryPath)
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error('Downloaded review evidence must be a real directory')
  }
  const [rootRealPath, directoryRealPath] = await Promise.all([realpath(rootPath), realpath(directoryPath)])
  const realDisplay = relative(rootRealPath, directoryRealPath)
  if (realDisplay === '..' || realDisplay.startsWith(`..${sep}`)) {
    throw new Error('Downloaded review evidence resolves outside the repository')
  }

  const entries = await readdir(directoryPath, { withFileTypes: true })
  const names = entries.map((entry) => entry.name).sort()
  if (JSON.stringify(names) !== JSON.stringify([...EVIDENCE_FILENAMES].sort())) {
    throw new Error(`Downloaded review evidence must contain exactly ${EVIDENCE_FILENAMES.join(', ')}`)
  }
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`Downloaded review evidence ${entry.name} must be a regular file`)
    }
  }

  const verification = await readBoundedStrictJson(resolve(directoryPath, 'verification.json'), MAX_REPORT_BYTES)
  const freshness = await readBoundedStrictJson(resolve(directoryPath, 'freshness.json'), MAX_REPORT_BYTES)
  return deepFreeze({
    directoryPath,
    bundlePath: resolve(directoryPath, 'bundle.json'),
    verification,
    freshness,
  })
}

function verifyPersistedReviewReports(inputs, evidence) {
  const { verification, freshness } = evidence
  const failures = []
  if (verification?.schemaVersion !== 1 || verification?.ok !== true) failures.push('verification.json is not a successful schema version 1 report')
  if (verification?.summary?.failed !== 0) failures.push('verification.json contains failed checks')
  if ((verification?.errors ?? []).length !== 0) failures.push('verification.json contains errors')
  if (verification?.bundleHash !== inputs.expectedBundleHash) failures.push('verification.json bundle hash does not match the trusted input')
  if (verification?.artifactHash !== inputs.expectedArtifactHash) failures.push('verification.json artifact hash does not match the trusted input')
  if (verification?.expectedBundleHash !== inputs.expectedBundleHash) failures.push('verification.json was not pinned to the trusted bundle hash')
  if (verification?.expectedArtifactHash !== inputs.expectedArtifactHash) failures.push('verification.json was not pinned to the trusted artifact hash')
  if (verification?.instanceId !== inputs.artifactInstanceId) failures.push('verification.json instance identity does not match artifact_name')

  if (freshness?.schemaVersion !== 1 || freshness?.status !== 'fresh' || freshness?.ok !== true) failures.push('freshness.json is not a successful fresh schema version 1 report')
  if (freshness?.currentState !== 'baseline' || freshness?.staleKind !== null) failures.push('freshness.json did not verify the reviewed baseline state')
  if (freshness?.applyAllowed !== true || freshness?.proposal?.changed !== true) failures.push('freshness.json does not permit an effective apply')
  if (freshness?.source?.matched !== true || freshness?.baseline?.matched !== true) failures.push('freshness.json source or baseline evidence did not match')
  if (freshness?.target?.currentMatched !== false) failures.push('freshness.json indicates the target was already present')
  if (freshness?.summary?.failed !== 0 || (freshness?.errors ?? []).length !== 0) failures.push('freshness.json contains failed checks or errors')
  if (freshness?.bundleHash !== inputs.expectedBundleHash || freshness?.expectedBundleHash !== inputs.expectedBundleHash) failures.push('freshness.json bundle hash does not match the trusted input')
  if (freshness?.artifactHash !== inputs.expectedArtifactHash || freshness?.expectedArtifactHash !== inputs.expectedArtifactHash) failures.push('freshness.json artifact hash does not match the trusted input')
  if (freshness?.instanceId !== inputs.artifactInstanceId) failures.push('freshness.json instance identity does not match artifact_name')

  if (failures.length > 0) throw new Error(`Persisted review evidence is inconsistent: ${failures.join('; ')}`)
}

function verifyPlanIdentity(inputs, evidence, plan) {
  const failures = []
  if (plan.bundleHash !== inputs.expectedBundleHash) failures.push('apply plan bundle hash changed')
  if (plan.artifactHash !== inputs.expectedArtifactHash) failures.push('apply plan artifact hash changed')
  if (plan.instanceId !== inputs.artifactInstanceId) failures.push('apply plan instance identity changed')
  if (plan.configPath !== evidence.freshness.configPath) failures.push('apply plan config path differs from review freshness evidence')
  if (plan.targetManifestHash !== evidence.freshness.target.hash) failures.push('apply plan target hash differs from review freshness evidence')
  if (plan.changeCount < 1 || plan.changed !== true) failures.push('apply plan has no effective reviewed change')
  if (failures.length > 0) throw new Error(`Apply plan identity mismatch: ${failures.join('; ')}`)
}

function verifyWrittenManifest(plan, current) {
  const failures = []
  if (current.displayPath !== plan.configPath) failures.push('written manifest path changed')
  if (current.manifest?.instanceId !== plan.instanceId) failures.push('written manifest instance identity changed')
  if (current.source !== plan.write.targetSource) failures.push('written manifest bytes differ from the prepared reviewed target')
  if (hashCanonical(current.manifest) !== plan.targetManifestHash) failures.push('written manifest canonical hash differs from the reviewed target')
  if (failures.length > 0) throw new Error(`Post-write manifest verification failed: ${failures.join('; ')}`)
}

function buildProvenance(inputs, plan) {
  return deepFreeze({
    schemaVersion: 1,
    kind: 'mochi-bus-instance-bundle-apply-pr-provenance',
    repository: inputs.repository,
    reviewRunId: inputs.reviewRunId,
    reviewRunAttempt: inputs.reviewRunAttempt,
    reviewRunUrl: `https://github.com/${inputs.repository}/actions/runs/${inputs.reviewRunId}`,
    artifactName: inputs.artifactName,
    bundleHash: plan.bundleHash,
    artifactHash: plan.artifactHash,
    targetManifestHash: plan.targetManifestHash,
    sourceRef: inputs.sourceRef,
    sourceSha: inputs.sourceSha,
    baseBranch: inputs.baseBranch,
    branchName: inputs.branchName,
    applyRunId: inputs.applyRunId,
    applyRunAttempt: inputs.runAttempt,
    configPath: plan.configPath,
    instanceId: plan.instanceId,
    changePaths: plan.changes.map((change) => change.path),
    provisioningDraft: plan.provisioningDraft,
    cutoverReady: plan.cutoverReady,
    deploymentReady: plan.deploymentReady,
  })
}

function preflightOutputs(inputs) {
  return Object.freeze({
    review_run_id: inputs.reviewRunId,
    artifact_name: inputs.artifactName,
    base_branch: inputs.baseBranch,
    branch_name: inputs.branchName,
  })
}

function finalOutputs(inputs, plan, paths) {
  return Object.freeze({
    branch_name: inputs.branchName,
    base_branch: inputs.baseBranch,
    config_path: plan.configPath,
    instance_id: plan.instanceId,
    commit_message: `chore(instance): apply reviewed bundle for ${plan.instanceId}`,
    pr_title: `chore(instance): apply reviewed bundle for ${plan.instanceId}`,
    pr_body_path: paths.prBodyPath,
    result_path: paths.resultPath,
    provenance_path: paths.provenancePath,
    evidence_directory: inputs.resultDirectory,
    bundle_hash: plan.bundleHash,
    artifact_hash: plan.artifactHash,
    target_manifest_hash: plan.targetManifestHash,
  })
}

async function ensureGeneratedResultDirectory(cwd, path) {
  const rootPath = resolve(cwd)
  const generatedRoot = resolve(rootPath, '.generated')
  const shown = relative(generatedRoot, path)
  if (!shown || shown === '..' || shown.startsWith(`..${sep}`)) {
    throw new Error('Apply PR result directory must stay inside .generated')
  }
  await mkdir(dirname(path), { recursive: true })
  await mkdir(path, { recursive: false, mode: 0o700 })
}

async function readBoundedStrictJson(path, maxBytes) {
  let handle
  try {
    const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
    handle = await open(path, constants.O_RDONLY | noFollow)
    const before = await handle.stat()
    if (!before.isFile()) throw new Error(`${path} must be a regular file`)
    if (before.size === 0) throw new Error(`${path} is empty`)
    if (before.size > maxBytes) throw new Error(`${path} exceeds the ${maxBytes}-byte read limit`)
    const source = await handle.readFile('utf8')
    const after = await handle.stat()
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || Buffer.byteLength(source, 'utf8') !== before.size) {
      throw new Error(`${path} changed while it was being read`)
    }
    return parseStrictJson(source)
  } finally {
    await handle?.close()
  }
}

async function writeExclusiveJson(path, value) {
  await writeExclusiveText(path, `${JSON.stringify(value, null, 2)}\n`)
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
    if (typeof value !== 'string' || UNSAFE_TEXT_PATTERN.test(value)) {
      throw new Error(`Invalid workflow output value for ${key}`)
    }
    lines.push(`${key}=${value}`)
  }
  await appendFile(path, `${lines.join('\n')}\n`, 'utf8')
}

function parseReviewArtifactName(value) {
  const match = /^instance-bundle-review-([a-z0-9](?:[a-z0-9-]{0,62}))-(\d+)-(\d+)$/.exec(value)
  if (!match) {
    throw new Error('artifact_name must use instance-bundle-review-<instance-id>-<run-id>-<attempt>')
  }
  if (!INSTANCE_ID_PATTERN.test(match[1])) throw new Error('artifact_name contains an invalid instance ID')
  return Object.freeze({ instanceId: match[1], reviewRunId: match[2], reviewRunAttempt: match[3] })
}

function validateRefName(value, label) {
  if (!SAFE_REF_PATTERN.test(value)
    || value.includes('..')
    || value.includes('@{')
    || value.includes('//')
    || value.endsWith('.')
    || value.endsWith('/')
    || value.includes('\\')) {
    throw new Error(`${label} is not a safe Git ref name`)
  }
  return value
}

function requiredExactInput(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} is required`)
  return value
}

function requiredSingleLine(value, name, maxBytes = MAX_PATH_INPUT_BYTES) {
  const normalized = requiredExactInput(value, name).trim()
  if (Buffer.byteLength(normalized, 'utf8') > maxBytes) {
    throw new Error(`${name} exceeds the ${maxBytes}-byte limit`)
  }
  if (!normalized || UNSAFE_TEXT_PATTERN.test(normalized)) {
    throw new Error(`${name} cannot contain control or bidirectional formatting characters`)
  }
  return normalized
}

function requiredPathInput(value, name) {
  const path = requiredExactInput(value, name)
  if (Buffer.byteLength(path, 'utf8') > MAX_PATH_INPUT_BYTES) {
    throw new Error(`${name} exceeds the ${MAX_PATH_INPUT_BYTES}-byte limit`)
  }
  if (UNSAFE_TEXT_PATTERN.test(path)) throw new Error(`${name} contains unsafe characters`)
  return path
}

function requiredDigits(value, name) {
  const normalized = requiredSingleLine(value, name, MAX_DIGIT_INPUT_BYTES)
  if (!/^\d+$/.test(normalized)) throw new Error(`${name} must contain only decimal digits`)
  return normalized
}

function requiredHash(value, name) {
  const normalized = requiredSingleLine(value, name).toLowerCase()
  if (!SHA256_PATTERN.test(normalized)) throw new Error(`${name} must be a 64-character SHA-256 hex digest`)
  return normalized
}

function requiredGitCommit(value, name) {
  const normalized = requiredSingleLine(value, name).toLowerCase()
  if (!GIT_COMMIT_PATTERN.test(normalized)) throw new Error(`${name} must be a 40-character Git commit SHA`)
  return normalized
}

function indentedEvidence(values) {
  if (values.length === 0) return ['    (none)']
  return values.flatMap((value) => safeEvidenceText(value).split('\n').map((line) => `    ${line}`))
}

function safeEvidenceText(value) {
  return String(value)
    .replace(/\r\n?/g, '\n')
    .replace(UNSAFE_EVIDENCE_TEXT_GLOBAL_PATTERN, '\uFFFD')
}

function markdownCodeSpan(value) {
  const text = safeEvidenceText(value).replaceAll('\n', ' ')
  const runs = text.match(/`+/g) ?? []
  const fence = '`'.repeat(Math.max(0, ...runs.map((run) => run.length)) + 1)
  const padded = text.startsWith('`') || text.endsWith('`') || text.startsWith(' ') || text.endsWith(' ')
  return `${fence}${padded ? ` ${text} ` : text}${fence}`
}

function markdownLink(label, url) {
  const safeLabel = safeEvidenceText(label).replace(/[\[\]]/g, '')
  const safeUrl = String(url).replace(/[()\s]/g, '')
  return `[${safeLabel}](${safeUrl})`
}

function displayPath(cwd, path) {
  return relative(resolve(cwd), path).split(sep).join('/') || '.'
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value)) deepFreeze(child)
  return value
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`${errorMessage(error)}\n`)
    process.exitCode = 1
  })
}
