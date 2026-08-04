import { createHash } from 'node:crypto'
import { appendFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  buildInstanceUpdate,
  parseInstanceUpdateArguments,
} from './update.mjs'
import { buildInstanceMigrationPlanFromProposal } from './migration-plan.mjs'

const DEFAULT_OUTPUT_DIRECTORY = '.generated/instance'
const DEFAULT_PRODUCTION_CONFIG = 'instances/mochi-production.json'
const STATUS_ORDER = Object.freeze(['blocked', 'action_required', 'verify', 'optional', 'complete', 'not_applicable'])
const SECRET_REQUIREMENTS = Object.freeze([
  Object.freeze({ name: 'CLOUDFLARE_DEPLOY_API_TOKEN', operations: ['deploy'] }),
  Object.freeze({ name: 'CLOUDFLARE_ACCOUNT_ID', operations: ['deploy', 'snapshot', 'publicProbe', 'windowWatchdog'] }),
  Object.freeze({ name: 'CLOUDFLARE_API_TOKEN', operations: ['snapshot', 'publicProbe', 'windowWatchdog'] }),
  Object.freeze({ name: 'TDX_CLIENT_ID', operations: ['snapshot'] }),
  Object.freeze({ name: 'TDX_CLIENT_SECRET', operations: ['snapshot'] }),
  Object.freeze({ name: 'R2_ACCESS_KEY_ID', operations: ['snapshot'], scalableOnly: true }),
  Object.freeze({ name: 'R2_SECRET_ACCESS_KEY', operations: ['snapshot'], scalableOnly: true }),
])

export function parseInstanceChangeBundleArguments(argv = process.argv.slice(2)) {
  const forwarded = []
  let outputDirectory = null
  let expectedHash = null
  let githubSummary = false

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--github-summary') {
      githubSummary = true
      continue
    }
    if (argument === '--out-dir' || argument === '--expect-hash') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) throw new Error(`Missing value after ${argument}`)
      if (argument === '--out-dir') outputDirectory = value
      else expectedHash = normalizeExpectedHash(value)
      index += 1
      continue
    }
    if (argument.startsWith('--out-dir=')) {
      outputDirectory = argument.slice('--out-dir='.length)
      if (!outputDirectory) throw new Error('Missing value after --out-dir=')
      continue
    }
    if (argument.startsWith('--expect-hash=')) {
      const value = argument.slice('--expect-hash='.length)
      if (!value) throw new Error('Missing value after --expect-hash=')
      expectedHash = normalizeExpectedHash(value)
      continue
    }
    forwarded.push(argument)
  }

  const updateOptions = parseInstanceUpdateArguments(forwarded)
  if (updateOptions.write) {
    throw new Error('instance:change-bundle is non-destructive and does not accept --write')
  }

  return Object.freeze({
    updateOptions,
    outputDirectory,
    expectedHash,
    githubSummary,
    json: updateOptions.json,
    help: updateOptions.help,
  })
}

export async function buildInstanceChangeBundle(options, {
  cwd = process.cwd(),
  env = process.env,
} = {}) {
  const updateOptions = options?.updateOptions ?? options
  if (!updateOptions || typeof updateOptions !== 'object') {
    throw new Error('Instance change bundle options are required')
  }
  if (updateOptions.write) {
    throw new Error('instance:change-bundle is non-destructive and does not accept --write')
  }

  const outputDirectory = options?.outputDirectory || DEFAULT_OUTPUT_DIRECTORY
  const proposal = await buildInstanceUpdate({ ...updateOptions, write: false }, { cwd, env })
  const migrationPlan = buildInstanceMigrationPlanFromProposal(proposal, { ...updateOptions, write: false })
  const proposalFingerprint = updateProposalFingerprint(proposal)
  const migrationFingerprint = migrationProposalFingerprint(migrationPlan)
  if (proposalFingerprint !== migrationFingerprint) {
    throw new Error('Migration plan proposal fingerprint does not match the updater proposal')
  }

  const outputDisplayPath = displayPath(cwd, resolve(cwd, outputDirectory))
  const doctorProjection = buildDoctorProjection(proposal, { outputDisplayPath })
  const provisioningPlan = buildProvisioningProjection(proposal, doctorProjection, {
    outputDisplayPath,
  })

  const hashes = buildHashes({
    proposal,
    migrationPlan,
    provisioningPlan,
    doctorProjection,
    proposalFingerprint,
  })
  const expectedHash = options?.expectedHash ?? null
  if (expectedHash && expectedHash !== hashes.bundleHash) {
    throw new Error(`Change bundle hash mismatch: expected ${expectedHash}, received ${hashes.bundleHash}`)
  }

  return deepFreeze({
    schemaVersion: 1,
    nonDestructive: true,
    deterministic: true,
    changed: proposal.changed,
    cutoverReady: migrationPlan.cutoverReady,
    provisioningDraft: proposal.provisioningDraft,
    risk: migrationPlan.risk,
    instance: {
      id: proposal.manifest.instanceId,
      configPath: proposal.displayPath,
      outputDirectory: outputDisplayPath,
      fromProfile: proposal.before.operations.profile,
      toProfile: proposal.manifest.operations.profile,
    },
    consistency: {
      sameProposal: true,
      proposalFingerprint,
      verification: 'migration plan was derived from the same immutable updater proposal',
    },
    proposal: {
      changed: proposal.changed,
      changes: proposal.changes,
      warnings: proposal.warnings,
      strictValidation: proposal.strictValidation,
      manifest: proposal.manifest,
      previewCommand: migrationPlan.proposal.previewCommand,
      applyCommand: migrationPlan.proposal.applyCommand,
    },
    migrationPlan,
    provisioningPlan,
    doctor: doctorProjection,
    hashes,
    expectedHash: expectedHash
      ? { value: expectedHash, matched: true }
      : null,
  })
}

export function renderInstanceChangeBundleText(bundle) {
  const lines = [
    'Mochi Bus instance change bundle',
    '',
    `${bundle.instance.id} · ${bundle.instance.fromProfile} → ${bundle.instance.toProfile} · ${bundle.risk.toUpperCase()} RISK`,
    `Config: ${bundle.instance.configPath}`,
    `Bundle SHA-256: ${bundle.hashes.bundleHash}`,
    `Target manifest SHA-256: ${bundle.hashes.targetManifestHash}`,
    '',
    `Proposal: ${bundle.proposal.changes.length} changes · ${bundle.proposal.warnings.length} warnings`,
  ]

  for (const change of bundle.proposal.changes) {
    lines.push(`~ ${change.path}: ${JSON.stringify(change.before)} → ${JSON.stringify(change.after)}`)
  }
  for (const warning of bundle.proposal.warnings) lines.push(`! ${warning}`)

  lines.push(
    '',
    `Migration: ${bundle.migrationPlan.summary.actionRequired} action required · ${bundle.migrationPlan.summary.blocked} blocked · ${bundle.migrationPlan.summary.verify} verify`,
    `Provisioning: ${bundle.provisioningPlan.summary.actionRequired} action required · ${bundle.provisioningPlan.summary.blocked} blocked · ${bundle.provisioningPlan.summary.verify} verify`,
    `Doctor projection: ${bundle.doctor.ok ? 'READY' : 'NOT READY'} · manifest ${bundle.doctor.manifest.status} · generated ${bundle.doctor.generated[0]?.status ?? 'not_checked'}`,
    '',
    `Preview: ${bundle.proposal.previewCommand}`,
    `Apply after review: ${bundle.proposal.applyCommand}`,
    `Verify hash: npm run instance:change-bundle -- ${renderVerificationArguments(bundle)} --expect-hash ${bundle.hashes.bundleHash}`,
    '',
    'NO CHANGES WERE APPLIED',
  )
  return `${lines.join('\n')}\n`
}

export function renderInstanceChangeBundleMarkdown(bundle) {
  const lines = [
    '## Mochi Bus instance change bundle',
    '',
    `**${bundle.instance.id} · ${bundle.instance.fromProfile} → ${bundle.instance.toProfile} · ${bundle.risk.toUpperCase()} RISK**`,
    '',
    `Bundle SHA-256: \`${bundle.hashes.bundleHash}\``,
    '',
    `Target manifest SHA-256: \`${bundle.hashes.targetManifestHash}\``,
    '',
    '| Area | Result |',
    '| --- | --- |',
    `| Proposal | ${bundle.proposal.changes.length} changes · ${bundle.proposal.warnings.length} warnings |`,
    `| Migration | ${bundle.migrationPlan.summary.actionRequired} action required · ${bundle.migrationPlan.summary.blocked} blocked · ${bundle.migrationPlan.summary.verify} verify |`,
    `| Provisioning | ${bundle.provisioningPlan.summary.actionRequired} action required · ${bundle.provisioningPlan.summary.blocked} blocked · ${bundle.provisioningPlan.summary.verify} verify |`,
    `| Doctor projection | ${bundle.doctor.ok ? 'READY' : 'NOT READY'} · manifest ${bundle.doctor.manifest.status} |`,
    '',
    '### Proposal changes',
    '',
  ]

  if (bundle.proposal.changes.length === 0) lines.push('- No effective changes.')
  for (const change of bundle.proposal.changes) {
    lines.push(`- \`${escapeInline(change.path)}\`: \`${escapeInline(JSON.stringify(change.before))}\` → \`${escapeInline(JSON.stringify(change.after))}\``)
  }
  if (bundle.proposal.warnings.length > 0) {
    lines.push('', '### Warnings', '')
    for (const warning of bundle.proposal.warnings) lines.push(`- ${escapeMarkdown(warning)}`)
  }
  lines.push(
    '',
    '### Review commands',
    '',
    `- Preview: \`${escapeInline(bundle.proposal.previewCommand)}\``,
    `- Apply: \`${escapeInline(bundle.proposal.applyCommand)}\``,
    `- Verify bundle: \`npm run instance:change-bundle -- ${escapeInline(renderVerificationArguments(bundle))} --expect-hash ${bundle.hashes.bundleHash}\``,
    '',
    '> This bundle is non-destructive. It did not write the manifest, compile artifacts, contact Cloudflare, inspect secret values or apply remote changes.',
    '',
  )
  return `${lines.join('\n')}\n`
}

export function instanceChangeBundleUsage() {
  return `Build a deterministic, non-destructive Mochi Bus instance change bundle.\n\nUsage:\n  npm run instance:change-bundle -- [--config <path>] <instance:update changes>\n\nThe command derives an updater proposal, migration plan, provisioning projection, doctor projection and SHA-256 review hashes.\n\nBundle options:\n  --out-dir <path>       Generated-artifact directory used in projected commands\n  --expect-hash <sha256> Fail unless the rebuilt bundle matches the expected hash\n  --github-summary       Append a compact Markdown bundle to GITHUB_STEP_SUMMARY\n  --json                 Print the complete machine-readable bundle\n  --help                 Show this help\n\nAll instance:update change options are accepted except --write.\n`
}

export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  cwd = process.cwd(),
  stdout = process.stdout,
} = {}) {
  const options = parseInstanceChangeBundleArguments(argv)
  if (options.help) {
    stdout.write(instanceChangeBundleUsage())
    return null
  }

  const bundle = await buildInstanceChangeBundle(options, { cwd, env })
  stdout.write(options.json
    ? `${JSON.stringify(bundle, null, 2)}\n`
    : renderInstanceChangeBundleText(bundle))

  if (options.githubSummary) {
    const summaryPath = typeof env.GITHUB_STEP_SUMMARY === 'string' ? env.GITHUB_STEP_SUMMARY.trim() : ''
    if (!summaryPath) throw new Error('--github-summary requires GITHUB_STEP_SUMMARY')
    await appendFile(summaryPath, renderInstanceChangeBundleMarkdown(bundle), 'utf8')
  }
  return bundle
}

function buildDoctorProjection(proposal, { outputDisplayPath }) {
  const manifestBlocked = proposal.provisioningDraft
  const manifestBlockers = manifestBlocked
    ? proposal.strictValidation.errors
    : []
  const generatedStatus = proposal.changed ? 'not_checked' : 'not_checked'
  const generatedBlocker = proposal.changed
    ? 'The target manifest is only a proposal; apply it and run instance:compile before comparing generated artifacts.'
    : 'No effective manifest change was proposed; run instance:doctor to inspect the current generated artifacts.'
  const operations = targetOperations(proposal.manifest).map((operation) => {
    if (!operation.enabled) return { ...operation, status: 'disabled', blockers: [], warnings: [] }
    const blockers = []
    if (proposal.provisioningDraft && operation.name === 'deploy') {
      blockers.push(...proposal.strictValidation.errors)
    } else {
      blockers.push('The target manifest has not been applied, compiled or checked against the execution environment.')
    }
    return {
      ...operation,
      status: proposal.provisioningDraft && operation.name === 'deploy' ? 'blocked' : 'not_checked',
      blockers,
      warnings: [],
    }
  })

  return {
    schemaVersion: 1,
    projected: true,
    ok: false,
    manifest: {
      status: manifestBlocked ? 'blocked' : 'ready',
      path: proposal.displayPath,
      blockers: manifestBlockers,
      instanceId: proposal.manifest.instanceId,
      siteName: proposal.manifest.site.name,
      profile: proposal.manifest.operations.profile,
      enabledCities: [...proposal.manifest.transit.enabledCities],
      defaultCity: proposal.manifest.transit.defaultCity,
      snapshotSchedule: proposal.manifest.operations.snapshotSchedule,
    },
    generated: ['runtime', 'wrangler', 'operations'].map((key) => ({
      key,
      label: key === 'runtime' ? 'Runtime config' : key === 'wrangler' ? 'Wrangler config' : 'Operations plan',
      path: join(outputDisplayPath, key === 'runtime' ? 'instance-runtime.json' : key === 'wrangler' ? 'wrangler.instance.jsonc' : 'operations-plan.json').replaceAll('\\', '/'),
      status: generatedStatus,
      blockers: [generatedBlocker],
    })),
    environment: {
      status: 'not_checked',
      blockers: ['Apply and compile the target manifest before checking environment identity.'],
    },
    operations,
    remote: {
      requested: false,
      status: 'not_checked',
      checkedResources: [],
      blockers: ['Remote verification is intentionally excluded from a deterministic proposal bundle.'],
    },
  }
}

function buildProvisioningProjection(proposal, doctor, { outputDisplayPath }) {
  const config = proposal.manifest
  const profile = config.operations.profile
  const operations = new Set(targetOperations(config).filter((item) => item.enabled).map((item) => item.name))
  const steps = []

  steps.push(step({
    id: 'manifest',
    category: 'repository',
    status: proposal.provisioningDraft ? 'blocked' : 'complete',
    title: 'Validate the target instance manifest',
    detail: proposal.provisioningDraft
      ? proposal.strictValidation.errors.join('; ')
      : `The proposed manifest is valid for the ${profile} profile.`,
  }))
  steps.push(step({
    id: 'generated-artifacts',
    category: 'repository',
    status: proposal.changed ? 'action_required' : 'verify',
    title: 'Compile generated instance artifacts',
    detail: proposal.changed
      ? 'Generated artifacts cannot represent the target until the reviewed proposal is applied.'
      : 'Run the compiler or doctor to confirm current generated artifacts.',
    commands: [compileCommand(proposal.displayPath, outputDisplayPath)],
  }))

  const d1Name = config.cloudflare.d1.databaseName
  const d1Id = config.cloudflare.d1.databaseId
  steps.push(step({
    id: 'cloudflare-d1',
    category: 'cloudflare',
    status: d1Id ? 'verify' : 'action_required',
    title: d1Id ? `Verify D1 database ${d1Name}` : `Provision D1 database ${d1Name}`,
    detail: d1Id
      ? 'A D1 ID is configured in the proposal, but deterministic bundles do not contact Cloudflare.'
      : 'The target manifest does not contain a D1 database ID.',
    commands: d1Id
      ? [doctorCommand(proposal.displayPath, outputDisplayPath, true)]
      : [`npx wrangler d1 create ${shellQuote(d1Name)}`],
    manualActions: d1Id ? [] : [`Write the returned ID to ${proposal.displayPath} before deployment cutover.`],
  }))

  const r2Name = config.cloudflare.r2.bucketName
  steps.push(step({
    id: 'cloudflare-r2',
    category: 'cloudflare',
    status: 'verify',
    title: `Verify or create R2 bucket ${r2Name}`,
    detail: 'Bucket existence and contents are not checked by a deterministic bundle.',
    commands: [doctorCommand(proposal.displayPath, outputDisplayPath, true)],
    manualActions: [`Run npx wrangler r2 bucket create ${shellQuote(r2Name)} only after confirming the bucket is absent.`],
  }))

  const standardId = config.cloudflare.rateLimits.standardNamespaceId
  const expensiveId = config.cloudflare.rateLimits.expensiveNamespaceId
  const validRateLimits = positiveInteger(standardId)
    && positiveInteger(expensiveId)
    && standardId !== expensiveId
  steps.push(step({
    id: 'rate-limit-namespaces',
    category: 'cloudflare',
    status: profile === 'operator' ? validRateLimits ? 'complete' : 'action_required' : 'optional',
    title: 'Configure rate-limit namespace identity',
    detail: profile !== 'operator'
      ? 'Starter and managed profiles do not require operator namespace IDs.'
      : validRateLimits
        ? 'Two distinct positive namespace IDs are present in the target manifest.'
        : 'Operator deployments require two distinct positive integer namespace IDs.',
  }))

  steps.push(step({
    id: 'worker-runtime-secrets',
    category: 'worker',
    status: 'verify',
    title: 'Verify Worker runtime TDX secrets',
    detail: 'The bundle never reads Worker secret values or existence.',
    commands: [
      `npx wrangler secret put TDX_CLIENT_ID --config ${shellQuote(join(outputDisplayPath, 'wrangler.instance.jsonc').replaceAll('\\', '/'))}`,
      `npx wrangler secret put TDX_CLIENT_SECRET --config ${shellQuote(join(outputDisplayPath, 'wrangler.instance.jsonc').replaceAll('\\', '/'))}`,
    ],
    manualActions: ['Run secret commands only when initially provisioning or rotating credentials.'],
  }))

  for (const requirement of SECRET_REQUIREMENTS) {
    const relatedOperations = requirement.operations.filter((operation) => operations.has(operation))
    if (relatedOperations.length === 0) continue
    const optional = requirement.scalableOnly && profile === 'starter'
    steps.push(step({
      id: `github-secret-${requirement.name.toLowerCase().replaceAll('_', '-')}`,
      category: 'github-secret',
      status: optional ? 'optional' : 'verify',
      title: `Verify GitHub secret ${requirement.name}`,
      detail: optional
        ? `${requirement.name} is optional for the starter snapshot fallback.`
        : 'Secret existence and values are intentionally excluded from deterministic bundle input.',
      commands: optional ? [] : [`gh secret set ${requirement.name}`],
      manualActions: optional ? ['Set both R2 S3 credentials together to enable scalable publication.'] : [],
      relatedOperations,
    }))
  }

  if (normalizePath(proposal.displayPath) !== normalizePath(DEFAULT_PRODUCTION_CONFIG)) {
    steps.push(step({
      id: 'github-variable-instance-config',
      category: 'github-variable',
      status: 'action_required',
      title: 'Select the target manifest in GitHub Actions',
      detail: 'A non-production manifest requires MOCHI_BUS_INSTANCE_CONFIG before npm prepare runs.',
      commands: [`gh variable set MOCHI_BUS_INSTANCE_CONFIG --body ${shellQuote(proposal.displayPath)}`],
    }))
  }

  if (config.site.canonicalOrigin === 'request') {
    if (config.operations.releaseSmoke) {
      steps.push(originVariableStep('RELEASE_SMOKE_ORIGIN', ['deploy']))
    }
    if (operations.has('snapshot') || operations.has('publicProbe')) {
      steps.push(originVariableStep('SNAPSHOT_SMOKE_BASE_URL', operations.has('publicProbe') ? ['snapshot', 'publicProbe'] : ['snapshot']))
    }
  }

  steps.push(step({
    id: 'final-doctor',
    category: 'verification',
    status: 'action_required',
    title: 'Run the final readiness doctor',
    detail: doctor.manifest.status === 'blocked'
      ? 'Complete target manifest identities before deployment cutover.'
      : 'Apply and compile the proposal, then run local and remote readiness checks.',
    commands: [doctorCommand(proposal.displayPath, outputDisplayPath, true)],
  }))

  const summary = summarize(steps)
  return {
    schemaVersion: 1,
    projected: true,
    ready: summary.blocked === 0 && summary.actionRequired === 0,
    nonDestructive: true,
    remoteRequested: false,
    instance: {
      id: config.instanceId,
      profile,
      configPath: proposal.displayPath,
      outputDirectory: outputDisplayPath,
    },
    diagnostics: {
      ok: doctor.ok,
      remoteStatus: doctor.remote.status,
    },
    summary,
    steps,
  }
}

function buildHashes({ proposal, migrationPlan, provisioningPlan, doctorProjection, proposalFingerprint }) {
  const sourceManifestHash = sha256(proposal.source)
  const baselineManifestHash = hashCanonical(proposal.before)
  const targetManifestHash = hashCanonical(proposal.manifest)
  const proposalHash = hashCanonical({
    configPath: proposal.displayPath,
    changed: proposal.changed,
    changes: proposal.changes,
    warnings: proposal.warnings,
    strictValidation: proposal.strictValidation,
    sourceManifestHash,
    baselineManifestHash,
    targetManifestHash,
    proposalFingerprint,
  })
  const migrationPlanHash = hashCanonical(migrationPlan)
  const provisioningPlanHash = hashCanonical(provisioningPlan)
  const doctorHash = hashCanonical(doctorProjection)
  const bundleHash = hashCanonical({
    schemaVersion: 1,
    sourceManifestHash,
    baselineManifestHash,
    targetManifestHash,
    proposalHash,
    migrationPlanHash,
    provisioningPlanHash,
    doctorHash,
  })
  return {
    algorithm: 'sha256',
    sourceManifestHash,
    baselineManifestHash,
    targetManifestHash,
    proposalHash,
    migrationPlanHash,
    provisioningPlanHash,
    doctorHash,
    bundleHash,
  }
}

function updateProposalFingerprint(proposal) {
  return hashCanonical({
    configPath: proposal.displayPath,
    instanceId: proposal.manifest.instanceId,
    fromProfile: proposal.before.operations.profile,
    toProfile: proposal.manifest.operations.profile,
    changes: proposal.changes,
    warnings: proposal.warnings,
  })
}

function migrationProposalFingerprint(plan) {
  return hashCanonical({
    configPath: plan.instance.configPath,
    instanceId: plan.instance.id,
    fromProfile: plan.instance.fromProfile,
    toProfile: plan.instance.toProfile,
    changes: plan.proposal.changes,
    warnings: plan.proposal.warnings,
  })
}

function targetOperations(config) {
  return [
    { name: 'deploy', label: 'Deploy', enabled: true, mode: 'release' },
    { name: 'snapshot', label: 'Snapshot publication', enabled: true, mode: config.operations.snapshotSchedule },
    { name: 'publicProbe', label: 'Public probe', enabled: config.operations.publicProbe === true, mode: 'read-only' },
    { name: 'windowWatchdog', label: 'Snapshot watchdog', enabled: config.operations.windowWatchdog === true, mode: 'read-only' },
  ]
}

function originVariableStep(name, relatedOperations) {
  return step({
    id: `github-variable-${name.toLowerCase().replaceAll('_', '-')}`,
    category: 'github-variable',
    status: 'action_required',
    title: `Set GitHub variable ${name}`,
    detail: 'Request-derived canonical origins require an explicit public HTTPS origin.',
    commands: [`gh variable set ${name} --body 'https://your-domain.example'`],
    manualActions: ['Replace the placeholder with the exact target origin.'],
    relatedOperations,
  })
}

function step(value) {
  return {
    id: value.id,
    category: value.category,
    status: STATUS_ORDER.includes(value.status) ? value.status : 'blocked',
    title: value.title,
    detail: value.detail ?? '',
    commands: [...(value.commands ?? [])],
    manualActions: [...(value.manualActions ?? [])],
    relatedOperations: [...(value.relatedOperations ?? [])],
  }
}

function summarize(steps) {
  const result = {
    blocked: 0,
    actionRequired: 0,
    verify: 0,
    optional: 0,
    complete: 0,
    notApplicable: 0,
  }
  for (const item of steps) {
    if (item.status === 'action_required') result.actionRequired += 1
    else if (item.status === 'not_applicable') result.notApplicable += 1
    else result[item.status] += 1
  }
  return result
}

function compileCommand(configPath, outputDirectory) {
  return `npm run instance:compile -- --config ${shellQuote(configPath)} --out-dir ${shellQuote(outputDirectory)}`
}

function doctorCommand(configPath, outputDirectory, remote = false) {
  return `npm run instance:doctor -- --config ${shellQuote(configPath)} --out-dir ${shellQuote(outputDirectory)}${remote ? ' --remote' : ''}`
}

function renderVerificationArguments(bundle) {
  const prefix = 'npm run instance:update -- '
  const previewCommand = bundle.proposal.previewCommand
  if (!previewCommand.startsWith(prefix)) {
    throw new Error('Migration plan preview command cannot be converted into change-bundle verification arguments')
  }
  const updateArguments = previewCommand.slice(prefix.length)
  return `${updateArguments} --out-dir ${shellQuote(bundle.instance.outputDirectory)}`
}

function normalizeExpectedHash(value) {
  const normalized = String(value).trim().toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new Error('--expect-hash must be a 64-character SHA-256 hex digest')
  return normalized
}

function positiveInteger(value) {
  return typeof value === 'string' && /^[1-9][0-9]*$/.test(value)
}

function hashCanonical(value) {
  return sha256(canonicalStringify(value))
}

function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex')
}

function canonicalStringify(value) {
  return JSON.stringify(canonicalize(value))
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  const result = {}
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) result[key] = canonicalize(value[key])
  }
  return result
}

function displayPath(cwd, path) {
  return relative(resolve(cwd), path).split(sep).join('/') || '.'
}

function normalizePath(value) {
  return String(value).replaceAll('\\', '/').replace(/^\.\//, '')
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`
}

function escapeInline(value) {
  return String(value).replaceAll('`', '\\`').replaceAll('|', '\\|')
}

function escapeMarkdown(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('*', '\\*').replaceAll('_', '\\_')
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
