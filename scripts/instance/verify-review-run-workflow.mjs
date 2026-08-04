import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseStrictJson } from './bundle-integrity.mjs'

const MAX_RUN_METADATA_BYTES = 1024 * 1024
const MAX_ARTIFACT_NAME_BYTES = 256
const MAX_REPOSITORY_BYTES = 200
const MAX_DIGIT_INPUT_BYTES = 20
const RUN_METADATA_PATH = '.generated/apply-review-run.json'
const REVIEW_WORKFLOW_PATH = '.github/workflows/review-instance-bundle.yml'
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const INSTANCE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62})$/
const GIT_COMMIT_PATTERN = /^[a-f0-9]{40}$/
const UNSAFE_TEXT_PATTERN = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u

export function parseInstanceBundleReviewRunVerificationInputs(env = process.env) {
  if (String(env.GITHUB_ACTIONS ?? '').toLowerCase() !== 'true') {
    throw new Error('The review-run verifier is available only inside GitHub Actions')
  }

  const confirmation = requiredExactInput(env.INPUT_CONFIRMATION, 'confirmation')
  if (confirmation !== 'APPLY') {
    throw new Error('Review-run verification requires confirmation APPLY')
  }

  const reviewRunId = requiredDigits(env.INPUT_REVIEW_RUN_ID, 'review_run_id')
  const artifactName = requiredSingleLine(
    env.INPUT_ARTIFACT_NAME,
    'artifact_name',
    MAX_ARTIFACT_NAME_BYTES,
  )
  const artifactIdentity = parseReviewArtifactName(artifactName)
  if (artifactIdentity.reviewRunId !== reviewRunId) {
    throw new Error('artifact_name review run ID must match review_run_id')
  }

  const repository = requiredSingleLine(
    env.GITHUB_REPOSITORY,
    'GITHUB_REPOSITORY',
    MAX_REPOSITORY_BYTES,
  )
  if (!REPOSITORY_PATTERN.test(repository)) {
    throw new Error('GITHUB_REPOSITORY must be owner/name')
  }

  return deepFreeze({
    confirmation,
    reviewRunId,
    reviewRunAttempt: artifactIdentity.reviewRunAttempt,
    artifactName,
    artifactInstanceId: artifactIdentity.instanceId,
    repository,
    metadataPath: RUN_METADATA_PATH,
  })
}

export async function verifyInstanceBundleReviewRunMetadata(inputs, {
  cwd = process.cwd(),
} = {}) {
  const metadata = await readBoundedStrictJson(
    resolve(cwd, inputs.metadataPath),
    MAX_RUN_METADATA_BYTES,
  )
  const failures = []

  if (!isPlainObject(metadata)) failures.push('review run metadata root must be an object')
  if (String(metadata?.id ?? '') !== inputs.reviewRunId) {
    failures.push('review run metadata ID does not match review_run_id')
  }
  if (String(metadata?.run_attempt ?? '') !== inputs.reviewRunAttempt) {
    failures.push('review run attempt does not match artifact_name')
  }
  if (metadata?.event !== 'workflow_dispatch') {
    failures.push('review run event must be workflow_dispatch')
  }
  if (metadata?.status !== 'completed' || metadata?.conclusion !== 'success') {
    failures.push('review run must be completed successfully')
  }
  if (metadata?.path !== REVIEW_WORKFLOW_PATH) {
    failures.push(`review run must use ${REVIEW_WORKFLOW_PATH}`)
  }
  if (metadata?.repository?.full_name !== inputs.repository) {
    failures.push('review run repository does not match GITHUB_REPOSITORY')
  }
  if (metadata?.head_repository?.full_name !== inputs.repository) {
    failures.push('review run head repository does not match GITHUB_REPOSITORY')
  }
  if (!GIT_COMMIT_PATTERN.test(String(metadata?.head_sha ?? '').toLowerCase())) {
    failures.push('review run head_sha must be a full Git commit SHA')
  }
  if (typeof metadata?.head_branch !== 'string' || !metadata.head_branch) {
    failures.push('review run head_branch is missing')
  }

  if (failures.length > 0) {
    throw new Error(`Review workflow run identity is invalid: ${failures.join('; ')}`)
  }

  return deepFreeze({
    schemaVersion: 1,
    ok: true,
    repository: inputs.repository,
    workflowPath: REVIEW_WORKFLOW_PATH,
    reviewRunId: inputs.reviewRunId,
    reviewRunAttempt: inputs.reviewRunAttempt,
    artifactName: inputs.artifactName,
    instanceId: inputs.artifactInstanceId,
    headBranch: metadata.head_branch,
    headSha: String(metadata.head_sha).toLowerCase(),
  })
}

export async function main({
  env = process.env,
  cwd = process.cwd(),
  stdout = process.stdout,
} = {}) {
  const inputs = parseInstanceBundleReviewRunVerificationInputs(env)
  const result = await verifyInstanceBundleReviewRunMetadata(inputs, { cwd })
  stdout.write(`${JSON.stringify({
    message: 'instance_bundle_review_run_verified',
    reviewRunId: result.reviewRunId,
    reviewRunAttempt: result.reviewRunAttempt,
    workflowPath: result.workflowPath,
    headSha: result.headSha,
  })}\n`)
  return result
}

async function readBoundedStrictJson(path, maxBytes) {
  const pathBefore = await lstat(path)
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink()) {
    throw new Error('Review run metadata must be a regular file')
  }

  let handle
  try {
    const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
    handle = await open(path, constants.O_RDONLY | noFollow)
    const before = await handle.stat()
    if (!before.isFile()) throw new Error('Review run metadata must be a regular file')
    if (!sameFileIdentity(pathBefore, before)) {
      throw new Error('Review run metadata path changed before it was opened')
    }
    if (before.size === 0) throw new Error('Review run metadata is empty')
    if (before.size > maxBytes) {
      throw new Error(`Review run metadata exceeds the ${maxBytes}-byte read limit`)
    }

    const bytes = await handle.readFile()
    const after = await handle.stat()
    const pathAfter = await lstat(path)
    if (!pathAfter.isFile() || pathAfter.isSymbolicLink()
      || !sameFileIdentity(before, after)
      || !sameFileIdentity(after, pathAfter)
      || before.size !== after.size
      || after.size !== pathAfter.size
      || bytes.length !== before.size) {
      throw new Error('Review run metadata changed while it was being read')
    }

    let source
    try {
      source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    } catch {
      throw new Error('Review run metadata must contain valid UTF-8')
    }
    if (Buffer.byteLength(source, 'utf8') !== bytes.length) {
      throw new Error('Review run metadata UTF-8 bytes did not round-trip exactly')
    }
    return parseStrictJson(source)
  } finally {
    await handle?.close()
  }
}

function parseReviewArtifactName(value) {
  const match = /^instance-bundle-review-([a-z0-9](?:[a-z0-9-]{0,62}))-(\d+)-(\d+)$/.exec(value)
  if (!match) {
    throw new Error('artifact_name must use instance-bundle-review-<instance-id>-<run-id>-<attempt>')
  }
  if (!INSTANCE_ID_PATTERN.test(match[1])) {
    throw new Error('artifact_name contains an invalid instance ID')
  }
  return Object.freeze({
    instanceId: match[1],
    reviewRunId: match[2],
    reviewRunAttempt: match[3],
  })
}

function requiredExactInput(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} is required`)
  return value
}

function requiredSingleLine(value, name, maxBytes) {
  const normalized = requiredExactInput(value, name).trim()
  if (Buffer.byteLength(normalized, 'utf8') > maxBytes) {
    throw new Error(`${name} exceeds the ${maxBytes}-byte limit`)
  }
  if (!normalized || UNSAFE_TEXT_PATTERN.test(normalized)) {
    throw new Error(`${name} cannot contain control or bidirectional formatting characters`)
  }
  return normalized
}

function requiredDigits(value, name) {
  const normalized = requiredSingleLine(value, name, MAX_DIGIT_INPUT_BYTES)
  if (!/^\d+$/.test(normalized)) throw new Error(`${name} must contain only decimal digits`)
  return normalized
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino
}

function isPlainObject(value) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
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
