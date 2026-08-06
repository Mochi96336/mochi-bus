import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseStrictJson } from './bundle-integrity.mjs'

const MAX_REPORT_BYTES = 1024 * 1024
const MAX_REF_BYTES = 256
const MAX_CONFIG_PATH_BYTES = 4096
const EVIDENCE_PATH = '.generated/apply-input/freshness.json'
const SAFE_REF_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,198}[A-Za-z0-9_-])?$/
const E2E_BRANCH_PATTERN = /^e2e\/instance-bundle-[a-z0-9](?:[a-z0-9._-]{0,80})$/
const UNSAFE_TEXT_PATTERN = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u

export const INSTANCE_BUNDLE_E2E_FIXTURE = 'instances/starter-chiayi.example.json'

export function parseApplyTargetPolicyInputs(env = process.env) {
  if (String(env.GITHUB_ACTIONS ?? '').toLowerCase() !== 'true') {
    throw new Error('The apply target policy is available only inside GitHub Actions')
  }

  const sourceRef = requiredSingleLine(env.GITHUB_REF, 'GITHUB_REF', MAX_REF_BYTES)
  if (!sourceRef.startsWith('refs/heads/')) {
    throw new Error('Apply target policy requires a branch ref')
  }

  const baseBranch = validateRefName(sourceRef.slice('refs/heads/'.length), 'base branch')
  const defaultBranch = validateRefName(
    requiredSingleLine(env.GITHUB_DEFAULT_BRANCH, 'GITHUB_DEFAULT_BRANCH', MAX_REF_BYTES),
    'default branch',
  )

  return Object.freeze({ sourceRef, baseBranch, defaultBranch })
}

export async function readApplyTargetPolicyEvidence({
  cwd = process.cwd(),
  evidencePath = EVIDENCE_PATH,
} = {}) {
  const path = resolve(cwd, evidencePath)
  let handle
  try {
    const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
    handle = await open(path, constants.O_RDONLY | noFollow)
    const before = await handle.stat()
    if (!before.isFile()) throw new Error(`${evidencePath} must be a regular file`)
    if (before.size === 0) throw new Error(`${evidencePath} is empty`)
    if (before.size > MAX_REPORT_BYTES) {
      throw new Error(`${evidencePath} exceeds the ${MAX_REPORT_BYTES}-byte read limit`)
    }

    const source = await handle.readFile('utf8')
    const after = await handle.stat()
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || Buffer.byteLength(source, 'utf8') !== before.size) {
      throw new Error(`${evidencePath} changed while it was being read`)
    }
    return parseStrictJson(source)
  } finally {
    await handle?.close()
  }
}

export function isExampleManifestPath(value) {
  const path = validateConfigPath(value)
  return path.startsWith('instances/') && path.toLowerCase().endsWith('.example.json')
}

export function classifyReviewedBundleApplyPurpose({ baseBranch, configPath }) {
  const branch = validateRefName(baseBranch, 'base branch')
  const path = validateConfigPath(configPath)
  const e2eBase = E2E_BRANCH_PATTERN.test(branch)
  const exampleManifest = path.startsWith('instances/') && path.toLowerCase().endsWith('.example.json')

  if (e2eBase && path !== INSTANCE_BUNDLE_E2E_FIXTURE) {
    throw new Error(
      `E2E base branch ${branch} may apply only ${INSTANCE_BUNDLE_E2E_FIXTURE}; received ${path}`,
    )
  }
  if (exampleManifest && !e2eBase) {
    throw new Error(
      `Example manifest ${path} requires a disposable e2e/instance-bundle-* base branch`,
    )
  }

  return Object.freeze({
    purpose: e2eBase ? 'e2e' : 'change',
    testOnly: e2eBase,
    e2eFixture: e2eBase ? INSTANCE_BUNDLE_E2E_FIXTURE : null,
    configPath: path,
    exampleManifest,
    baseBranch: branch,
  })
}

export function enforceApplyTargetPolicy(inputs, freshness) {
  if (freshness?.schemaVersion !== 1 || freshness?.ok !== true || freshness?.status !== 'fresh') {
    throw new Error('Apply target policy requires successful schema version 1 freshness evidence')
  }

  const configPath = validateConfigPath(freshness.configPath)
  if (isExampleManifestPath(configPath) && inputs.baseBranch === inputs.defaultBranch) {
    throw new Error(
      `Example manifest ${configPath} cannot be applied directly to default branch ${inputs.defaultBranch}; `
      + 'dispatch REVIEW and APPLY from a disposable e2e/instance-bundle-* branch',
    )
  }

  return Object.freeze({
    ...classifyReviewedBundleApplyPurpose({ baseBranch: inputs.baseBranch, configPath }),
    defaultBranch: inputs.defaultBranch,
  })
}

export async function main({
  env = process.env,
  cwd = process.cwd(),
  stdout = process.stdout,
} = {}) {
  const inputs = parseApplyTargetPolicyInputs(env)
  const freshness = await readApplyTargetPolicyEvidence({ cwd })
  const result = enforceApplyTargetPolicy(inputs, freshness)
  stdout.write(`${JSON.stringify({
    message: 'instance_bundle_apply_target_policy_passed',
    ...result,
  })}\n`)
  return result
}

function validateConfigPath(value) {
  const path = requiredSingleLine(value, 'freshness configPath', MAX_CONFIG_PATH_BYTES)
  if (path.includes('\\') || path.startsWith('/') || path.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new Error('freshness configPath must be a safe repository-relative path')
  }
  if (path !== 'instance.json' && !(path.startsWith('instances/') && path.endsWith('.json'))) {
    throw new Error('freshness configPath must be instance.json or a JSON file inside instances/')
  }
  return path
}

function validateRefName(value, label) {
  const normalized = requiredSingleLine(value, label, MAX_REF_BYTES)
  if (!SAFE_REF_PATTERN.test(normalized)
    || normalized.includes('..')
    || normalized.includes('@{')
    || normalized.includes('//')
    || normalized.endsWith('.')
    || normalized.endsWith('/')
    || normalized.includes('\\')) {
    throw new Error(`${label} is not a safe Git ref name`)
  }
  return normalized
}

function requiredSingleLine(value, name, maxBytes) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized) throw new Error(`${name} is required`)
  if (Buffer.byteLength(normalized, 'utf8') > maxBytes) {
    throw new Error(`${name} exceeds the ${maxBytes}-byte limit`)
  }
  if (UNSAFE_TEXT_PATTERN.test(normalized)) {
    throw new Error(`${name} cannot contain control or bidirectional formatting characters`)
  }
  return normalized
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
