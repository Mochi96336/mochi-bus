import { lstat } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import {
  hashCanonical,
  parseStrictJson,
  sha256,
  verifyInstanceBundleArtifact,
} from './bundle-integrity.mjs'
import {
  checkInstanceBundleFreshnessFile,
  readCurrentInstanceManifest,
} from './check-bundle-freshness.mjs'
import {
  ManifestReplacementError,
  MAX_ATOMIC_MANIFEST_BYTES,
  writeVerifiedManifestReplacement,
} from './atomic-manifest-write.mjs'
import { readInstanceBundleArtifact } from './verify-bundle.mjs'

const SHA256_PATTERN = /^[a-f0-9]{64}$/

export function parseInstanceBundleApplyArguments(argv = process.argv.slice(2)) {
  const options = {
    inputPath: null,
    configPath: null,
    expectedBundleHash: null,
    expectedArtifactHash: null,
    write: false,
    json: false,
    help: false,
  }
  const positional = []

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--write' || argument === '--json' || argument === '--help') {
      options[argument.slice(2)] = true
      continue
    }

    const equalsIndex = argument.indexOf('=')
    const optionName = equalsIndex >= 0 ? argument.slice(0, equalsIndex) : argument
    let value = equalsIndex >= 0 ? argument.slice(equalsIndex + 1) : null
    if (!optionName.startsWith('--')) {
      positional.push(argument)
      continue
    }
    if (!['--input', '--config', '--expect-hash', '--expect-artifact-hash'].includes(optionName)) {
      throw new Error(`Unknown bundle apply option: ${optionName}`)
    }
    if (value === null) {
      value = argv[index + 1]
      if (!value || value.startsWith('--')) throw new Error(`Missing value after ${optionName}`)
      index += 1
    }
    if (!value) throw new Error(`Missing value after ${optionName}=`)
    if (/[\u0000\r\n]/.test(value)) throw new Error(`${optionName} cannot contain NUL or line breaks`)

    if (optionName === '--input') options.inputPath = value
    else if (optionName === '--config') options.configPath = value
    else if (optionName === '--expect-hash') options.expectedBundleHash = normalizeHash(value, optionName)
    else options.expectedArtifactHash = normalizeHash(value, optionName)
  }

  if (!options.inputPath && positional.length > 0) options.inputPath = positional.shift()
  if (positional.length > 0) throw new Error(`Unexpected argument: ${positional[0]}`)
  if (!options.help) {
    if (!options.inputPath) {
      throw new Error('instance:apply-bundle requires --input <bundle.json> or one positional artifact path')
    }
    if (!options.expectedBundleHash || !options.expectedArtifactHash) {
      throw new Error('instance:apply-bundle requires both --expect-hash and --expect-artifact-hash')
    }
  }
  return Object.freeze(options)
}

export async function buildInstanceBundleApply(options, {
  cwd = process.cwd(),
} = {}) {
  if (!options || typeof options !== 'object') throw new Error('Bundle apply options are required')
  if (!options.expectedBundleHash || !options.expectedArtifactHash) {
    throw new Error('Bundle apply requires both expected review hashes')
  }

  const freshness = await checkInstanceBundleFreshnessFile(options, { cwd })
  if (freshness.status !== 'fresh') {
    return blockedPlan(freshness, freshness.staleKind ?? 'freshness_blocked')
  }
  if (!freshness.applyAllowed) {
    return blockedPlan(freshness, 'no_effective_change')
  }

  const input = await readInstanceBundleArtifact(options.inputPath, { cwd })
  const integrity = verifyInstanceBundleArtifact(input.artifact)
  if (!integrity.ok) return blockedPlan(freshness, 'artifact_reverification_failed', integrity.errors)
  if (integrity.bundleHash !== options.expectedBundleHash) {
    return blockedPlan(freshness, 'bundle_hash_changed_after_freshness')
  }
  if (integrity.artifactHash !== options.expectedArtifactHash) {
    return blockedPlan(freshness, 'artifact_hash_changed_after_freshness')
  }

  const artifact = input.artifact
  const artifactConfigPath = artifact.bundle.instance.configPath
  let current
  try {
    current = await readCurrentInstanceManifest(options.configPath ?? artifactConfigPath, { cwd })
  } catch (error) {
    return blockedPlan(freshness, 'current_manifest_unreadable_after_freshness', [errorMessage(error)])
  }

  const redundantErrors = []
  if (current.displayPath !== artifactConfigPath) {
    redundantErrors.push(`config path changed: expected ${artifactConfigPath}, received ${current.displayPath}`)
  }
  if (current.manifest.instanceId !== artifact.bundle.instance.id) {
    redundantErrors.push(`instanceId changed: expected ${artifact.bundle.instance.id}, received ${current.manifest.instanceId ?? 'missing'}`)
  }
  const sourceHash = sha256(current.source)
  if (
    sourceHash !== artifact.bundle.hashes.sourceManifestHash
    || current.source !== artifact.evidence.sourceManifest
  ) {
    redundantErrors.push('exact source bytes changed after freshness verification')
  }
  const baselineHash = hashCanonical(current.manifest)
  if (baselineHash !== artifact.bundle.hashes.baselineManifestHash) {
    redundantErrors.push('canonical baseline changed after freshness verification')
  }
  const targetHash = hashCanonical(artifact.bundle.proposal.manifest)
  if (targetHash !== artifact.bundle.hashes.targetManifestHash) {
    redundantErrors.push('artifact target hash changed after freshness verification')
  }
  if (redundantErrors.length > 0) {
    return blockedPlan(freshness, 'source_changed_after_freshness', redundantErrors)
  }

  let currentMetadata
  try {
    currentMetadata = await lstat(current.path)
  } catch (error) {
    return blockedPlan(freshness, 'current_manifest_identity_unavailable', [errorMessage(error)])
  }
  if (!currentMetadata.isFile() || currentMetadata.isSymbolicLink()) {
    return blockedPlan(freshness, 'current_manifest_identity_unsafe')
  }
  if (currentMetadata.size !== Buffer.byteLength(current.source, 'utf8')) {
    return blockedPlan(freshness, 'current_manifest_changed_after_read')
  }

  const format = detectJsonFormat(current.source)
  const targetSource = serializeManifest(artifact.bundle.proposal.manifest, format)
  if (Buffer.byteLength(targetSource, 'utf8') > MAX_ATOMIC_MANIFEST_BYTES) {
    return blockedPlan(freshness, 'prepared_target_exceeds_write_limit')
  }
  const parsedTarget = parseStrictJson(targetSource)
  if (hashCanonical(parsedTarget) !== artifact.bundle.hashes.targetManifestHash) {
    return blockedPlan(freshness, 'prepared_target_hash_mismatch')
  }
  if (targetSource === current.source) {
    return blockedPlan(freshness, 'prepared_target_has_no_byte_change')
  }

  return deepFreeze({
    schemaVersion: 1,
    ready: true,
    reason: null,
    artifactPath: input.displayPath,
    configPath: current.displayPath,
    instanceId: artifact.bundle.instance.id,
    bundleHash: integrity.bundleHash,
    artifactHash: integrity.artifactHash,
    sourceManifestHash: artifact.bundle.hashes.sourceManifestHash,
    baselineManifestHash: artifact.bundle.hashes.baselineManifestHash,
    targetManifestHash: artifact.bundle.hashes.targetManifestHash,
    changed: true,
    changeCount: artifact.bundle.proposal.changes.length,
    changes: artifact.bundle.proposal.changes,
    warnings: artifact.bundle.proposal.warnings,
    provisioningDraft: artifact.bundle.provisioningDraft === true,
    cutoverReady: artifact.bundle.cutoverReady === true,
    deploymentReady: freshness.deploymentReady,
    freshness,
    write: {
      configPath: current.path,
      expectedSource: current.source,
      sourceIdentity: Object.freeze({
        dev: currentMetadata.dev,
        ino: currentMetadata.ino,
        mode: currentMetadata.mode & 0o777,
      }),
      targetSource,
      targetManifestHash: artifact.bundle.hashes.targetManifestHash,
      expectedInstanceId: artifact.bundle.instance.id,
    },
  })
}

export async function writeInstanceBundleApply(plan, writerOptions = {}) {
  if (!plan?.ready) throw new Error(`Bundle apply is not ready: ${plan?.reason ?? 'unknown blocker'}`)
  await writeVerifiedManifestReplacement(plan.write, writerOptions)
  return true
}

export function renderInstanceBundleApplyText(plan, {
  written = false,
  writeResult = null,
} = {}) {
  const outcome = normalizeWriteResult({ written, writeResult })
  const lines = [
    `Mochi Bus change-bundle apply: ${plan.ready ? applyStatus(outcome) : 'BLOCKED'}`,
    `Artifact: ${plan.artifactPath ?? 'unavailable'}`,
    `Config: ${plan.configPath ?? 'unavailable'}`,
    `Instance: ${plan.instanceId ?? 'unknown'}`,
    `Bundle SHA-256: ${plan.bundleHash ?? 'unavailable'}`,
    `Artifact SHA-256: ${plan.artifactHash ?? 'unavailable'}`,
    `Target manifest SHA-256: ${plan.targetManifestHash ?? 'unavailable'}`,
    `Deployment ready: ${plan.deploymentReady ? 'yes' : 'no'}`,
  ]

  if (!plan.ready) {
    lines.push('', `Blocker: ${plan.reason}`)
    for (const detail of plan.details ?? []) lines.push(`x ${detail}`)
    lines.push('', 'NO FILE WAS CHANGED')
    return `${lines.join('\n')}\n`
  }

  lines.push('', `Reviewed changes (${plan.changeCount}):`)
  for (const change of plan.changes) {
    lines.push(`~ ${change.path}`)
    lines.push(`  before: ${JSON.stringify(change.before)}`)
    lines.push(`  after:  ${JSON.stringify(change.after)}`)
  }
  if (plan.warnings.length > 0) {
    lines.push('', 'Warnings:')
    for (const warning of plan.warnings) lines.push(`- ${warning}`)
  }

  if (outcome.writeState === 'preview') {
    lines.push('', 'NO FILE WAS CHANGED')
    lines.push(`Apply: ${renderApplyCommand(plan)}`)
  } else if (outcome.writeState === 'written_verified') {
    appendSuccessfulNextStep(lines, plan)
  } else {
    lines.push('', `Write state: ${outcome.writeState}`)
    lines.push(`Manifest written: ${outcome.written ? 'yes' : 'no'}`)
    lines.push(`Manifest verified: ${outcome.verified ? 'yes' : 'no'}`)
    if (outcome.lockPath) lines.push(`Apply lock: ${outcome.lockPath}`)
    if (outcome.error) lines.push(`x ${outcome.error}`)
    for (const cleanupError of outcome.cleanupErrors) lines.push(`x ${cleanupError}`)

    if (outcome.writeState === 'written_verified_cleanup_failed') {
      lines.push('', 'THE REVIEWED TARGET WAS WRITTEN AND VERIFIED, BUT CLEANUP FAILED')
      lines.push('Inspect the apply lock and repository state before retrying.')
    } else if (outcome.writeState === 'written_unverified') {
      lines.push('', 'THE MANIFEST MAY HAVE CHANGED')
      lines.push('Inspect the current manifest hash and contents before retrying.')
    } else {
      lines.push('', 'NO FILE WAS CHANGED')
    }
  }
  return `${lines.join('\n')}\n`
}

export function renderInstanceBundleApplyJson(plan, {
  written = false,
  writeResult = null,
} = {}) {
  const outcome = normalizeWriteResult({ written, writeResult })
  return {
    schemaVersion: 1,
    ready: plan.ready,
    written: outcome.written,
    verified: outcome.verified,
    writeState: outcome.writeState,
    writeError: outcome.error,
    cleanupErrors: outcome.cleanupErrors,
    lockPath: outcome.lockPath,
    reason: plan.reason,
    details: plan.details ?? [],
    artifactPath: plan.artifactPath,
    configPath: plan.configPath,
    instanceId: plan.instanceId,
    bundleHash: plan.bundleHash,
    artifactHash: plan.artifactHash,
    sourceManifestHash: plan.sourceManifestHash ?? null,
    baselineManifestHash: plan.baselineManifestHash ?? null,
    targetManifestHash: plan.targetManifestHash ?? null,
    changeCount: plan.changeCount ?? 0,
    changes: plan.changes ?? [],
    warnings: plan.warnings ?? [],
    provisioningDraft: plan.provisioningDraft ?? false,
    cutoverReady: plan.cutoverReady ?? false,
    deploymentReady: plan.deploymentReady ?? false,
    freshness: plan.freshness,
  }
}

export function instanceBundleApplyUsage() {
  return `Preview or atomically apply a reviewed Mochi Bus instance change-bundle artifact.\n\nUsage:\n  npm run instance:apply-bundle -- --input <bundle.json> --expect-hash <sha256> --expect-artifact-hash <sha256>\n  npm run instance:apply-bundle -- --input <bundle.json> --expect-hash <sha256> --expect-artifact-hash <sha256> --write\n\nRequired:\n  --input <path>                  Self-contained reviewed bundle artifact\n  --expect-hash <sha256>          Exact reviewed bundle SHA-256\n  --expect-artifact-hash <sha256> Exact reviewed artifact SHA-256\n\nOptional:\n  --config <path>                 Current manifest; must match artifact configPath\n  --write                         Revalidate and atomically replace the manifest\n  --json                          Print a machine-readable result\n  --help                          Show this help\n\nWithout --write the command performs the complete verification and prints the exact apply command. It never compiles, deploys, runs Wrangler or contacts Cloudflare.\n`
}

export async function main({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  stdout = process.stdout,
  writerOptions = {},
} = {}) {
  const options = parseInstanceBundleApplyArguments(argv)
  if (options.help) {
    stdout.write(instanceBundleApplyUsage())
    return null
  }

  const plan = await buildInstanceBundleApply(options, { cwd })
  let writeResult = null
  if (options.write && plan.ready) {
    try {
      await writeInstanceBundleApply(plan, writerOptions)
      writeResult = successfulWriteResult(plan)
    } catch (error) {
      writeResult = failedWriteResult(error, plan)
      stdout.write(options.json
        ? `${JSON.stringify(renderInstanceBundleApplyJson(plan, { writeResult }), null, 2)}\n`
        : renderInstanceBundleApplyText(plan, { writeResult }))
      throw error
    }
  }

  stdout.write(options.json
    ? `${JSON.stringify(renderInstanceBundleApplyJson(plan, { writeResult }), null, 2)}\n`
    : renderInstanceBundleApplyText(plan, { writeResult }))
  if (!plan.ready) throw new Error(`instance:apply-bundle blocked: ${plan.reason}`)
  return plan
}

function blockedPlan(freshness, reason, details = freshness.errors ?? []) {
  return deepFreeze({
    schemaVersion: 1,
    ready: false,
    reason,
    details: uniqueStrings(details),
    artifactPath: freshness.artifactPath,
    configPath: freshness.configPath,
    instanceId: freshness.instanceId,
    bundleHash: freshness.bundleHash,
    artifactHash: freshness.artifactHash,
    targetManifestHash: freshness.target?.expectedHash ?? null,
    deploymentReady: false,
    freshness,
  })
}

function detectJsonFormat(source) {
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const indentation = source.match(/\r?\n([ \t]+)"/)?.[1] ?? ''
  return {
    eol,
    indentation,
    trailingNewline: source.endsWith('\n'),
  }
}

function serializeManifest(manifest, format) {
  const spacing = format.indentation || undefined
  const json = JSON.stringify(manifest, null, spacing).replaceAll('\n', format.eol)
  return `${json}${format.trailingNewline ? format.eol : ''}`
}

function renderApplyCommand(plan) {
  return [
    'npm run instance:apply-bundle --',
    '--input', shellQuote(plan.artifactPath),
    '--expect-hash', plan.bundleHash,
    '--expect-artifact-hash', plan.artifactHash,
    '--write',
  ].join(' ')
}

function appendSuccessfulNextStep(lines, plan) {
  if (plan.provisioningDraft) {
    lines.push('', `Next: npm run instance:provision-plan -- --config ${shellQuote(plan.configPath)}`)
  } else {
    lines.push('', `Next: npm run instance:validate -- --config ${shellQuote(plan.configPath)}`)
  }
}

function applyStatus(outcome) {
  if (outcome.writeState === 'written_verified') return 'APPLIED'
  if (outcome.writeState === 'written_verified_cleanup_failed') return 'APPLIED WITH CLEANUP FAILURE'
  if (outcome.writeState === 'written_unverified') return 'WRITE STATE UNKNOWN'
  if (outcome.writeState === 'not_written') return 'WRITE FAILED'
  return 'READY'
}

function normalizeWriteResult({ written, writeResult }) {
  if (writeResult) return writeResult
  return Object.freeze({
    writeState: written ? 'written_verified' : 'preview',
    written: Boolean(written),
    verified: Boolean(written),
    error: null,
    cleanupErrors: Object.freeze([]),
    lockPath: null,
  })
}

function successfulWriteResult(plan) {
  return Object.freeze({
    writeState: 'written_verified',
    written: true,
    verified: true,
    error: null,
    cleanupErrors: Object.freeze([]),
    lockPath: `${plan.write.configPath}.apply.lock`,
  })
}

function failedWriteResult(error, plan) {
  if (error instanceof ManifestReplacementError) {
    const written = error.writeState !== 'not_written'
    return Object.freeze({
      writeState: error.writeState,
      written,
      verified: error.writeState === 'written_verified_cleanup_failed',
      error: error.message,
      cleanupErrors: Object.freeze([...error.cleanupErrors]),
      lockPath: error.lockPath,
    })
  }
  return Object.freeze({
    writeState: 'not_written',
    written: false,
    verified: false,
    error: errorMessage(error),
    cleanupErrors: Object.freeze([]),
    lockPath: `${plan.write.configPath}.apply.lock`,
  })
}

function normalizeHash(value, optionName) {
  const hash = String(value).trim().toLowerCase()
  if (!SHA256_PATTERN.test(hash)) throw new Error(`${optionName} must be a lowercase SHA-256 digest`)
  return hash
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean).map(String))]
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
