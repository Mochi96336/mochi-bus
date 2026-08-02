import { appendFile, lstat, mkdir, open, realpath } from 'node:fs/promises'
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  buildInstanceBundleArtifact,
  parseInstanceBundleArtifactArguments,
  resolveBundleArtifactOutputPath,
  writeInstanceBundleArtifact,
} from './bundle-artifact.mjs'
import { parseStrictJson } from './bundle-integrity.mjs'
import { renderInstanceChangeBundleMarkdown } from './change-bundle.mjs'
import {
  parseInstanceBundleVerificationArguments,
  renderInstanceBundleVerificationMarkdown,
  verifyInstanceBundleFile,
} from './verify-bundle.mjs'

const MAX_CHANGES_JSON_BYTES = 16 * 1024
const MAX_CHANGE_ARGUMENTS = 64
const MAX_CHANGE_ARGUMENT_BYTES = 2048
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const GIT_COMMIT_PATTERN = /^[a-f0-9]{40}$/
const FORBIDDEN_CONFIG_DIRECTORIES = new Set(['.git', '.generated', 'node_modules'])
const FORBIDDEN_CHANGE_OPTIONS = new Set([
  '--config',
  '--write',
  '--output',
  '--dry-run',
  '--json',
  '--github-summary',
  '--help',
  '--expect-hash',
  '--expect-artifact-hash',
  '--out-dir',
])

export function parseInstanceBundleReviewWorkflowInputs(env = process.env) {
  if (String(env.GITHUB_ACTIONS ?? '').toLowerCase() !== 'true') {
    throw new Error('The instance bundle review runner is available only inside GitHub Actions')
  }

  const confirmation = requiredInput(env.INPUT_CONFIRMATION, 'confirmation')
  if (confirmation !== 'REVIEW') {
    throw new Error('Instance bundle review requires confirmation REVIEW')
  }

  const configPath = requiredSingleLine(env.INPUT_CONFIG_PATH, 'config_path')
  const changesSource = String(env.INPUT_CHANGES_JSON ?? '[]').trim() || '[]'
  if (Buffer.byteLength(changesSource, 'utf8') > MAX_CHANGES_JSON_BYTES) {
    throw new Error(`changes_json exceeds the ${MAX_CHANGES_JSON_BYTES}-byte limit`)
  }

  const changes = parseStrictJson(changesSource)
  if (!Array.isArray(changes)) {
    throw new Error('changes_json must be a JSON array of command arguments')
  }
  if (changes.length > MAX_CHANGE_ARGUMENTS) {
    throw new Error(`changes_json may contain at most ${MAX_CHANGE_ARGUMENTS} arguments`)
  }

  for (const [index, argument] of changes.entries()) {
    if (typeof argument !== 'string' || argument.length === 0) {
      throw new Error(`changes_json argument ${index + 1} must be a non-empty string`)
    }
    if (/[\0\r\n]/.test(argument)) {
      throw new Error(`changes_json argument ${index + 1} cannot contain NUL or line breaks`)
    }
    if (Buffer.byteLength(argument, 'utf8') > MAX_CHANGE_ARGUMENT_BYTES) {
      throw new Error(`changes_json argument ${index + 1} exceeds the ${MAX_CHANGE_ARGUMENT_BYTES}-byte limit`)
    }
    const optionName = argument.includes('=') ? argument.slice(0, argument.indexOf('=')) : argument
    if (FORBIDDEN_CHANGE_OPTIONS.has(optionName)) {
      throw new Error(`changes_json cannot control workflow option ${optionName}`)
    }
  }

  const expectedBundleHash = optionalHash(env.INPUT_EXPECTED_BUNDLE_HASH)
  const runId = requiredDigits(env.GITHUB_RUN_ID, 'GITHUB_RUN_ID')
  const runAttempt = requiredDigits(env.GITHUB_RUN_ATTEMPT, 'GITHUB_RUN_ATTEMPT')
  const sourceSha = requiredGitCommit(env.GITHUB_SHA, 'GITHUB_SHA')
  const sourceRef = requiredSingleLine(env.GITHUB_REF ?? env.GITHUB_REF_NAME, 'GITHUB_REF')
  const summaryPath = requiredInput(env.GITHUB_STEP_SUMMARY, 'GITHUB_STEP_SUMMARY')
  const outputPath = requiredInput(env.GITHUB_OUTPUT, 'GITHUB_OUTPUT')

  return deepFreeze({
    confirmation,
    configPath,
    changes: [...changes],
    expectedBundleHash,
    runId,
    runAttempt,
    sourceSha,
    sourceRef,
    summaryPath,
    outputPath,
  })
}

export async function resolveInstanceBundleReviewConfig(cwd, value) {
  const rootPath = resolve(cwd)
  if (isAbsolute(value)) throw new Error('config_path must be repository-relative')
  const configPath = resolve(rootPath, value)
  const shown = displayPath(rootPath, configPath)
  if (shown === '..' || shown.startsWith('../')) {
    throw new Error('config_path must stay inside the repository working directory')
  }
  if (extname(configPath).toLowerCase() !== '.json') {
    throw new Error('config_path must use a .json extension')
  }
  if (shown !== 'instance.json' && !shown.startsWith('instances/')) {
    throw new Error('config_path must be instance.json or a JSON file inside instances/')
  }
  const segments = shown.split('/')
  if (segments.some((segment) => FORBIDDEN_CONFIG_DIRECTORIES.has(segment))) {
    throw new Error('config_path cannot read from .git, .generated or node_modules')
  }

  const stat = await lstat(configPath)
  if (stat.isSymbolicLink()) throw new Error('config_path cannot be a symbolic link')
  if (!stat.isFile()) throw new Error('config_path must identify a regular file')

  const [rootRealPath, configRealPath] = await Promise.all([
    realpath(rootPath),
    realpath(configPath),
  ])
  const resolvedDisplay = relative(rootRealPath, configRealPath)
  if (resolvedDisplay === '..' || resolvedDisplay.startsWith(`..${sep}`)) {
    throw new Error('config_path resolves outside the repository working directory')
  }

  return Object.freeze({ rootPath, configPath, displayPath: shown })
}

export async function runInstanceBundleReviewWorkflow(inputs, {
  cwd = process.cwd(),
  env = process.env,
} = {}) {
  const config = await resolveInstanceBundleReviewConfig(cwd, inputs.configPath)
  const artifactDirectory = `.generated/review/workflow-${inputs.runId}-${inputs.runAttempt}`
  const artifactPath = `${artifactDirectory}/bundle.json`
  const verificationPath = `${artifactDirectory}/verification.json`
  const argv = [
    '--config', config.displayPath,
    ...inputs.changes,
  ]
  if (inputs.expectedBundleHash) argv.push('--expect-hash', inputs.expectedBundleHash)
  argv.push('--output', artifactPath)

  const artifactOptions = parseInstanceBundleArtifactArguments(argv)
  const artifact = await buildInstanceBundleArtifact(artifactOptions, { cwd, env: {} })
  const target = resolveBundleArtifactOutputPath(
    cwd,
    artifactPath,
    artifact.bundle.instance.configPath,
  )
  await writeInstanceBundleArtifact(artifact, target)

  const verificationOptions = parseInstanceBundleVerificationArguments([
    '--input', artifactPath,
    '--expect-hash', artifact.bundle.hashes.bundleHash,
    '--expect-artifact-hash', artifact.integrity.artifactHash,
  ])
  const verification = await verifyInstanceBundleFile(verificationOptions, { cwd })
  if (!verification.ok) {
    throw new Error(`Saved bundle artifact failed offline verification with ${verification.summary.failed} failed checks`)
  }
  await writeExclusiveJson(resolve(cwd, verificationPath), verification)

  const artifactName = `instance-bundle-review-${artifact.bundle.instance.id}-${inputs.runId}-${inputs.runAttempt}`
  const outputs = Object.freeze({
    artifact_directory: artifactDirectory,
    artifact_path: artifactPath,
    verification_path: verificationPath,
    artifact_name: artifactName,
    instance_id: artifact.bundle.instance.id,
    bundle_hash: artifact.bundle.hashes.bundleHash,
    artifact_hash: artifact.integrity.artifactHash,
  })
  await appendWorkflowOutputs(inputs.outputPath, outputs)
  await appendFile(inputs.summaryPath, renderWorkflowSummary({
    inputs,
    config,
    artifact,
    verification,
    outputs,
  }), 'utf8')

  return deepFreeze({ artifact, verification, outputs })
}

export function renderWorkflowSummary({ inputs, config, artifact, verification, outputs }) {
  const expected = inputs.expectedBundleHash
    ? `\`${inputs.expectedBundleHash}\` (matched before artifact creation)`
    : 'not supplied'
  return `${[
    '## Manual instance bundle review',
    '',
    `- Source commit: \`${inputs.sourceSha}\``,
    `- Source ref: \`${escapeInline(inputs.sourceRef)}\``,
    `- Config: \`${escapeInline(config.displayPath)}\``,
    `- Artifact upload name: \`${escapeInline(outputs.artifact_name)}\``,
    `- Expected bundle hash: ${expected}`,
    `- Parsed change arguments: ${inputs.changes.length}`,
    '',
    '> This workflow is review-only. It did not write the manifest, compile generated instance files, read repository secrets, invoke Wrangler or contact Cloudflare.',
    '',
    renderInstanceChangeBundleMarkdown(artifact.bundle).trimEnd(),
    '',
    renderInstanceBundleVerificationMarkdown(verification).trimEnd(),
    '',
    'The uploaded `bundle.json` and `verification.json` are the complete review evidence for this run.',
    '',
  ].join('\n')}\n`
}

export async function main({
  env = process.env,
  cwd = process.cwd(),
  stdout = process.stdout,
} = {}) {
  const inputs = parseInstanceBundleReviewWorkflowInputs(env)
  const result = await runInstanceBundleReviewWorkflow(inputs, { cwd, env })
  stdout.write(`${JSON.stringify({
    message: 'instance_bundle_review_verified',
    instanceId: result.outputs.instance_id,
    artifactDirectory: result.outputs.artifact_directory,
    bundleHash: result.outputs.bundle_hash,
    artifactHash: result.outputs.artifact_hash,
  })}\n`)
  return result
}

async function writeExclusiveJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
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
    if (typeof value !== 'string' || value.includes('\n') || value.includes('\r')) {
      throw new Error(`Invalid workflow output value for ${key}`)
    }
    lines.push(`${key}=${value}`)
  }
  await appendFile(path, `${lines.join('\n')}\n`, 'utf8')
}

function requiredInput(value, name) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized) throw new Error(`${name} is required`)
  return normalized
}

function requiredSingleLine(value, name) {
  const normalized = requiredInput(value, name)
  if (/[\0\r\n]/.test(normalized)) throw new Error(`${name} cannot contain NUL or line breaks`)
  return normalized
}

function requiredDigits(value, name) {
  const normalized = requiredInput(value, name)
  if (!/^\d+$/.test(normalized)) throw new Error(`${name} must contain only decimal digits`)
  return normalized
}

function requiredGitCommit(value, name) {
  const normalized = requiredInput(value, name).toLowerCase()
  if (!GIT_COMMIT_PATTERN.test(normalized)) throw new Error(`${name} must be a 40-character Git commit SHA`)
  return normalized
}

function optionalHash(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!normalized) return null
  if (!SHA256_PATTERN.test(normalized)) {
    throw new Error('expected_bundle_hash must be a 64-character SHA-256 hex digest')
  }
  return normalized
}

function displayPath(cwd, path) {
  return relative(resolve(cwd), path).split(sep).join('/') || '.'
}

function escapeInline(value) {
  return String(value).replaceAll('`', '\\`').replaceAll('|', '\\|')
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
