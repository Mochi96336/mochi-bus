import { appendFile, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  DEFAULT_OUTPUT_DIRECTORY,
  DEFAULT_PRODUCTION_CONFIG,
  resolveInstanceConfigPath,
} from './config.mjs'
import { diagnoseInstance } from './doctor.mjs'

const STATUS_ORDER = Object.freeze(['blocked', 'action_required', 'verify', 'optional', 'complete', 'not_applicable'])
const CLOUDFLARE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/
const D1_DATABASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SECRET_SPECS = Object.freeze([
  Object.freeze({
    name: 'CLOUDFLARE_DEPLOY_API_TOKEN',
    consumers: ['deploy'],
    detail: 'GitHub Actions token used only by the deployment workflow.',
  }),
  Object.freeze({
    name: 'CLOUDFLARE_API_TOKEN',
    consumers: ['snapshot', 'publicProbe', 'windowWatchdog'],
    detail: 'GitHub Actions token used by snapshot and read-only operational checks.',
  }),
  Object.freeze({
    name: 'CLOUDFLARE_ACCOUNT_ID',
    consumers: ['deploy', 'snapshot', 'publicProbe', 'windowWatchdog'],
    detail: 'Cloudflare account identity consumed by every enabled remote operation.',
  }),
  Object.freeze({
    name: 'TDX_CLIENT_ID',
    consumers: ['snapshot'],
    detail: 'TDX credential used by snapshot publication.',
  }),
  Object.freeze({
    name: 'TDX_CLIENT_SECRET',
    consumers: ['snapshot'],
    detail: 'TDX credential used by snapshot publication.',
  }),
  Object.freeze({
    name: 'R2_ACCESS_KEY_ID',
    consumers: ['snapshot'],
    detail: 'R2 S3 credential used by scalable snapshot publication.',
    scalableSnapshotOnly: true,
  }),
  Object.freeze({
    name: 'R2_SECRET_ACCESS_KEY',
    consumers: ['snapshot'],
    detail: 'R2 S3 credential used by scalable snapshot publication.',
    scalableSnapshotOnly: true,
  }),
])

export function parseProvisioningPlanArguments(argv = process.argv.slice(2)) {
  let configPath = null
  let outputDirectory = null
  let remote = false
  let json = false
  let githubSummary = false

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--remote') {
      remote = true
      continue
    }
    if (argument === '--json') {
      json = true
      continue
    }
    if (argument === '--github-summary') {
      githubSummary = true
      continue
    }
    if (argument === '--config' || argument === '--out-dir') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) throw new Error(`Missing value after ${argument}`)
      if (argument === '--config') configPath = value
      else outputDirectory = value
      index += 1
      continue
    }
    if (argument.startsWith('--config=')) {
      configPath = argument.slice('--config='.length)
      if (!configPath) throw new Error('Missing value after --config=')
      continue
    }
    if (argument.startsWith('--out-dir=')) {
      outputDirectory = argument.slice('--out-dir='.length)
      if (!outputDirectory) throw new Error('Missing value after --out-dir=')
      continue
    }
    throw new Error(`Unknown provisioning plan option: ${argument}`)
  }

  return Object.freeze({ configPath, outputDirectory, remote, json, githubSummary })
}

export async function buildProvisioningPlan({
  cwd = process.cwd(),
  env = process.env,
  configPath = null,
  outputDirectory = null,
  remote = false,
  fetchImpl = fetch,
} = {}) {
  const draft = await loadManifestDraft({ cwd, env, configPath })
  const outputPath = resolve(cwd, outputDirectory || DEFAULT_OUTPUT_DIRECTORY)
  const doctor = await diagnoseInstance({
    cwd,
    env,
    configPath: draft.path,
    outputDirectory: outputPath,
    remote,
    fetchImpl,
  })
  const config = isRecord(draft.value) ? draft.value : {}
  const profile = stringValue(config.operations?.profile) ?? doctor.manifest.profile
  const operations = resolveEnabledOperations(config, doctor)
  const resourceIdentity = resolveResourceIdentity(config)
  const configDisplayPath = displayPath(cwd, draft.path)
  const outputDisplayPath = displayPath(cwd, outputPath)
  const wranglerDisplayPath = displayPath(cwd, join(outputPath, 'wrangler.instance.jsonc'))
  const steps = []

  steps.push(manifestStep({ doctor, configDisplayPath }))
  steps.push(generatedStep({ doctor, configDisplayPath, outputDisplayPath }))
  steps.push(d1Step({
    doctor,
    remote,
    configDisplayPath,
    resourceIdentity,
  }))
  steps.push(r2Step({ doctor, remote, resourceIdentity }))
  steps.push(rateLimitStep({ profile, configDisplayPath, resourceIdentity }))
  steps.push(workerSecretsStep({ wranglerDisplayPath }))
  steps.push(...repositorySecretSteps({ env, profile, operations }))
  steps.push(...repositoryVariableSteps({
    env,
    config,
    configDisplayPath,
    operations,
  }))
  steps.push(finalVerificationStep({
    doctor,
    remote,
    configDisplayPath,
    outputDisplayPath,
  }))

  const normalizedSteps = steps
    .filter(Boolean)
    .map((step) => freezeStep(step))
  const summary = summarize(normalizedSteps)
  const instanceId = stringValue(config.instanceId) ?? doctor.manifest.instanceId
  const plan = {
    schemaVersion: 1,
    ready: summary.blocked === 0 && summary.actionRequired === 0,
    nonDestructive: true,
    remoteRequested: remote,
    instance: Object.freeze({
      id: instanceId,
      profile,
      configPath: configDisplayPath,
      outputDirectory: outputDisplayPath,
    }),
    diagnostics: Object.freeze({
      ok: doctor.ok,
      remoteStatus: doctor.remote.status,
    }),
    summary: Object.freeze(summary),
    steps: Object.freeze(normalizedSteps),
  }
  return Object.freeze(plan)
}

export function renderProvisioningPlanText(plan) {
  const lines = [
    'Mochi Bus provisioning plan',
    '',
    `${plan.instance.id ?? '<unresolved>'} · ${plan.instance.profile ?? '<unknown profile>'}`,
    `${plan.summary.actionRequired} action required · ${plan.summary.blocked} blocked · ${plan.summary.verify} verify`,
    '',
  ]
  for (const step of plan.steps) {
    lines.push(`${statusGlyph(step.status)} [${step.category}] ${step.title}`)
    if (step.detail) lines.push(`  ${step.detail}`)
    for (const operation of step.relatedOperations) lines.push(`  operation: ${operation}`)
    for (const command of step.commands) lines.push(`  $ ${command}`)
    for (const action of step.manualActions) lines.push(`  - ${action}`)
  }
  lines.push('', 'NO CHANGES WERE APPLIED')
  return `${lines.join('\n')}\n`
}

export function renderProvisioningPlanMarkdown(plan) {
  const lines = [
    '## Mochi Bus provisioning plan',
    '',
    `**${plan.ready ? 'No known blocking setup actions' : 'Setup actions remain'}**`,
    '',
    `Instance: \`${escapeInline(plan.instance.id ?? '<unresolved>')}\` · profile: \`${escapeInline(plan.instance.profile ?? '<unknown>')}\``,
    '',
    '| Status | Area | Step | Detail |',
    '| --- | --- | --- | --- |',
  ]
  for (const step of plan.steps) {
    const detail = [
      step.detail,
      ...step.commands.map((command) => `\`${command}\``),
      ...step.manualActions,
    ].filter(Boolean).join('<br>')
    lines.push(`| ${markdownStatus(step.status)} | ${escapeTable(step.category)} | ${escapeTable(step.title)} | ${escapeTable(detail)} |`)
  }
  lines.push('', '> This report is non-destructive. No Cloudflare resource, Worker secret, GitHub secret or repository variable was changed.', '')
  return `${lines.join('\n')}\n`
}

export async function main({ argv = process.argv.slice(2), env = process.env, cwd = process.cwd() } = {}) {
  const options = parseProvisioningPlanArguments(argv)
  const plan = await buildProvisioningPlan({ ...options, env, cwd })
  const output = options.json
    ? `${JSON.stringify(plan, null, 2)}\n`
    : renderProvisioningPlanText(plan)
  process.stdout.write(output)

  if (options.githubSummary) {
    const summaryPath = typeof env.GITHUB_STEP_SUMMARY === 'string' ? env.GITHUB_STEP_SUMMARY.trim() : ''
    if (!summaryPath) throw new Error('--github-summary requires GITHUB_STEP_SUMMARY')
    await appendFile(summaryPath, renderProvisioningPlanMarkdown(plan), 'utf8')
  }
  return plan
}

function manifestStep({ doctor, configDisplayPath }) {
  if (doctor.manifest.status === 'ready') {
    return {
      id: 'manifest',
      category: 'repository',
      status: 'complete',
      title: 'Validate the instance manifest',
      detail: `${configDisplayPath} is valid for the ${doctor.manifest.profile} profile.`,
    }
  }
  return {
    id: 'manifest',
    category: 'repository',
    status: 'blocked',
    title: 'Repair the instance manifest',
    detail: doctor.manifest.blockers.join('; ') || 'The selected manifest could not be validated.',
    commands: [`npm run instance:validate -- --config ${shellQuote(configDisplayPath)}`],
    manualActions: ['Fix every validation error before compiling or provisioning resources.'],
  }
}

function generatedStep({ doctor, configDisplayPath, outputDisplayPath }) {
  const blocked = doctor.generated.filter((artifact) => artifact.status !== 'ready')
  if (blocked.length === 0) {
    return {
      id: 'generated-artifacts',
      category: 'repository',
      status: 'complete',
      title: 'Compile generated instance artifacts',
      detail: 'Runtime, Wrangler and operations artifacts match the selected manifest.',
    }
  }
  return {
    id: 'generated-artifacts',
    category: 'repository',
    status: doctor.manifest.status === 'ready' ? 'action_required' : 'blocked',
    title: 'Compile generated instance artifacts',
    detail: blocked.map((artifact) => `${artifact.label}: ${artifact.blockers.join('; ')}`).join(' | '),
    commands: [compileCommand(configDisplayPath, outputDisplayPath)],
    manualActions: doctor.manifest.status === 'ready'
      ? []
      : ['Repair the manifest before running the compiler.'],
  }
}

function d1Step({ doctor, remote, configDisplayPath, resourceIdentity }) {
  const name = resourceIdentity.d1Name
  const id = resourceIdentity.d1Id
  if (!name || !resourceIdentity.d1NameValid) {
    return {
      id: 'cloudflare-d1',
      category: 'cloudflare',
      status: 'blocked',
      title: 'Provision the D1 database',
      detail: name
        ? 'cloudflare.d1.databaseName must match the Cloudflare resource-name format.'
        : 'cloudflare.d1.databaseName is missing or invalid.',
      manualActions: name
        ? [`Repair cloudflare.d1.databaseName in ${configDisplayPath} before creating a database.`]
        : [],
    }
  }
  if (id && !resourceIdentity.d1IdValid) {
    return {
      id: 'cloudflare-d1',
      category: 'cloudflare',
      status: 'blocked',
      title: `Repair D1 database identity for ${name}`,
      detail: 'cloudflare.d1.databaseId is present but is not a valid D1 UUID.',
      manualActions: [
        `Replace cloudflare.d1.databaseId in ${configDisplayPath} with the exact UUID returned by Cloudflare, or set it to null before provisioning.`,
      ],
    }
  }
  if (!id) {
    return {
      id: 'cloudflare-d1',
      category: 'cloudflare',
      status: 'action_required',
      title: `Provision D1 database ${name}`,
      detail: 'The manifest does not contain a D1 database ID.',
      commands: [`npx wrangler d1 create ${shellQuote(name)}`],
      manualActions: [
        `Copy the returned database ID into ${configDisplayPath} at cloudflare.d1.databaseId.`,
        'Recompile generated artifacts after updating the manifest.',
      ],
      relatedOperations: ['deploy', 'snapshot', 'publicProbe', 'windowWatchdog'],
    }
  }
  if (remoteResourceReady(doctor, 'd1', name)) {
    return {
      id: 'cloudflare-d1',
      category: 'cloudflare',
      status: 'complete',
      title: `Verify D1 database ${name}`,
      detail: 'Read-only Cloudflare verification matched the generated ID and name.',
    }
  }
  if (remote && remoteBlockedFor(doctor, 'D1')) {
    return {
      id: 'cloudflare-d1',
      category: 'cloudflare',
      status: 'blocked',
      title: `Verify D1 database ${name}`,
      detail: doctor.remote.blockers.join('; '),
      manualActions: ['Confirm the account, token permissions and manifest database ID refer to the same D1 database.'],
    }
  }
  return {
    id: 'cloudflare-d1',
    category: 'cloudflare',
    status: 'verify',
    title: `Verify D1 database ${name}`,
    detail: 'A database ID is configured, but remote identity was not confirmed.',
    commands: [doctorCommand({ remote: true })],
  }
}

function r2Step({ doctor, remote, resourceIdentity }) {
  const name = resourceIdentity.r2Name
  if (!name || !resourceIdentity.r2NameValid) {
    return {
      id: 'cloudflare-r2',
      category: 'cloudflare',
      status: 'blocked',
      title: 'Provision the R2 bucket',
      detail: name
        ? 'cloudflare.r2.bucketName must match the Cloudflare resource-name format.'
        : 'cloudflare.r2.bucketName is missing or invalid.',
    }
  }
  if (remoteResourceReady(doctor, 'r2', name)) {
    return {
      id: 'cloudflare-r2',
      category: 'cloudflare',
      status: 'complete',
      title: `Verify R2 bucket ${name}`,
      detail: 'Read-only Cloudflare verification matched the generated bucket name.',
    }
  }
  if (remote && remoteBlockedFor(doctor, 'R2')) {
    return {
      id: 'cloudflare-r2',
      category: 'cloudflare',
      status: 'blocked',
      title: `Verify R2 bucket ${name}`,
      detail: doctor.remote.blockers.join('; '),
      commands: [`npx wrangler r2 bucket create ${shellQuote(name)}`],
      manualActions: ['Run the create command only after confirming the bucket is absent from the configured account.'],
    }
  }
  return {
    id: 'cloudflare-r2',
    category: 'cloudflare',
    status: 'verify',
    title: `Verify or create R2 bucket ${name}`,
    detail: 'Bucket existence was not remotely confirmed.',
    commands: [
      doctorCommand({ remote: true }),
      `npx wrangler r2 bucket create ${shellQuote(name)}`,
    ],
    manualActions: ['Use the create command only if remote verification confirms the bucket is absent.'],
  }
}

function rateLimitStep({ profile, configDisplayPath, resourceIdentity }) {
  if (profile !== 'operator') {
    return {
      id: 'rate-limit-namespaces',
      category: 'cloudflare',
      status: 'optional',
      title: 'Configure rate-limit namespace identity',
      detail: 'Starter and managed profiles do not require operator namespace IDs.',
    }
  }
  const { standardRateLimitId, expensiveRateLimitId } = resourceIdentity
  const valid = positiveInteger(standardRateLimitId)
    && positiveInteger(expensiveRateLimitId)
    && standardRateLimitId !== expensiveRateLimitId
  if (valid) {
    return {
      id: 'rate-limit-namespaces',
      category: 'cloudflare',
      status: 'complete',
      title: 'Configure rate-limit namespace identity',
      detail: 'Two distinct positive namespace IDs are present in the operator manifest.',
    }
  }
  return {
    id: 'rate-limit-namespaces',
    category: 'cloudflare',
    status: 'action_required',
    title: 'Configure rate-limit namespace identity',
    detail: 'Operator deployments require two distinct positive integer namespace IDs.',
    manualActions: [
      `Set cloudflare.rateLimits.standardNamespaceId in ${configDisplayPath}.`,
      `Set cloudflare.rateLimits.expensiveNamespaceId in ${configDisplayPath} to a different positive integer string.`,
      'Recompile generated artifacts after updating the manifest.',
    ],
    relatedOperations: ['deploy'],
  }
}

function workerSecretsStep({ wranglerDisplayPath }) {
  return {
    id: 'worker-runtime-secrets',
    category: 'worker',
    status: 'verify',
    title: 'Configure Worker runtime TDX secrets',
    detail: 'Cloudflare does not expose secret values to this planner; confirm both Worker secrets exist.',
    commands: [
      `npx wrangler secret put TDX_CLIENT_ID --config ${shellQuote(wranglerDisplayPath)}`,
      `npx wrangler secret put TDX_CLIENT_SECRET --config ${shellQuote(wranglerDisplayPath)}`,
    ],
    manualActions: ['Run these commands only when initially provisioning or rotating the Worker credentials.'],
    relatedOperations: ['deploy'],
  }
}

function repositorySecretSteps({ env, profile, operations }) {
  const steps = []
  const githubActions = isGitHubActionsEnvironment(env)
  for (const spec of SECRET_SPECS) {
    const relatedOperations = spec.consumers.filter((operation) => operations.has(operation))
    if (relatedOperations.length === 0) continue
    const optional = spec.scalableSnapshotOnly && profile === 'starter'
    const configured = hasEnvironment(env, spec.name)
    const confirmed = configured && githubActions
    steps.push({
      id: `github-secret-${spec.name.toLowerCase().replaceAll('_', '-')}`,
      category: 'github-secret',
      status: optional ? 'optional' : confirmed ? 'complete' : configured ? 'verify' : 'action_required',
      title: `Set GitHub secret ${spec.name}`,
      detail: optional
        ? `${spec.name} is optional for the starter Wrangler fallback.`
        : confirmed
          ? `${spec.name} is configured for this GitHub Actions run.`
          : configured
            ? `${spec.name} is present locally, but GitHub repository secret state was not verified.`
            : spec.detail,
      commands: configured || optional ? [] : [`gh secret set ${spec.name}`],
      manualActions: optional
        ? ['Set both R2 S3 credential secrets together to enable scalable publication.']
        : configured && !githubActions
          ? ['Run the provisioning-plan workflow from the default branch to verify repository secret configuration.']
          : [],
      relatedOperations,
    })
  }
  return steps
}

function repositoryVariableSteps({ env, config, configDisplayPath, operations }) {
  const steps = []
  const githubActions = isGitHubActionsEnvironment(env)
  const defaultProduction = normalizePath(DEFAULT_PRODUCTION_CONFIG)
  if (normalizePath(configDisplayPath) !== defaultProduction) {
    const configured = hasEnvironment(env, 'MOCHI_BUS_INSTANCE_CONFIG')
    const confirmed = configured && githubActions
    steps.push({
      id: 'github-variable-instance-config',
      category: 'github-variable',
      status: confirmed ? 'complete' : configured ? 'verify' : 'action_required',
      title: 'Select the fork instance manifest in GitHub Actions',
      detail: confirmed
        ? 'MOCHI_BUS_INSTANCE_CONFIG is configured for this GitHub Actions run.'
        : configured
          ? 'MOCHI_BUS_INSTANCE_CONFIG selected this local run, but the repository variable was not verified.'
          : 'GitHub Actions must select the committed non-production manifest before npm prepare runs.',
      commands: configured
        ? []
        : [`gh variable set MOCHI_BUS_INSTANCE_CONFIG --body ${shellQuote(configDisplayPath)}`],
      manualActions: configured && !githubActions
        ? ['Run the provisioning-plan workflow from the default branch to verify the repository variable.']
        : [],
    })
  }

  if (config.site?.canonicalOrigin !== 'request') return steps
  if (operations.has('deploy') && config.operations?.releaseSmoke === true) {
    steps.push(originVariableStep({
      env,
      name: 'RELEASE_SMOKE_ORIGIN',
      consumer: 'deploy',
      githubActions,
    }))
  }
  if (operations.has('snapshot') || operations.has('publicProbe')) {
    steps.push(originVariableStep({
      env,
      name: 'SNAPSHOT_SMOKE_BASE_URL',
      consumer: operations.has('publicProbe') ? 'snapshot, publicProbe' : 'snapshot',
      githubActions,
    }))
  }
  return steps
}

function originVariableStep({ env, name, consumer, githubActions }) {
  const configured = hasEnvironment(env, name)
  const confirmed = configured && githubActions
  return {
    id: `github-variable-${name.toLowerCase().replaceAll('_', '-')}`,
    category: 'github-variable',
    status: confirmed ? 'complete' : configured ? 'verify' : 'action_required',
    title: `Set GitHub variable ${name}`,
    detail: confirmed
      ? `${name} is configured for this GitHub Actions run.`
      : configured
        ? `${name} is present locally, but the repository variable was not verified.`
        : 'Request-derived canonical origins require an explicit HTTPS deployment origin.',
    commands: configured
      ? []
      : [`gh variable set ${name} --body 'https://your-domain.example'`],
    manualActions: confirmed
      ? []
      : configured
        ? ['Run the provisioning-plan workflow from the default branch to verify the repository variable.']
        : ['Replace the placeholder with the exact public HTTPS origin.'],
    relatedOperations: consumer.split(', '),
  }
}

function finalVerificationStep({ doctor, remote, configDisplayPath, outputDisplayPath }) {
  const command = doctorCommand({
    remote,
    configPath: configDisplayPath,
    outputDirectory: outputDisplayPath,
  })
  return {
    id: 'final-doctor',
    category: 'verification',
    status: doctor.ok ? 'complete' : 'action_required',
    title: 'Run the final readiness doctor',
    detail: doctor.ok
      ? 'The current doctor report has no enabled-operation blockers.'
      : 'Re-run the doctor after applying the selected provisioning steps.',
    commands: doctor.ok ? [] : [command],
  }
}

async function loadManifestDraft({ cwd, env, configPath }) {
  const path = configPath
    ? absoluteFrom(cwd, configPath)
    : await resolveInstanceConfigPath({ cwd, argv: [], env })
  let value = null
  try {
    value = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    value = null
  }
  return Object.freeze({ path, value })
}

function resolveEnabledOperations(config, doctor) {
  const operations = new Set(['deploy', 'snapshot'])
  const checks = config.operations ?? {}
  if (checks.publicProbe === true) operations.add('publicProbe')
  if (checks.windowWatchdog === true) operations.add('windowWatchdog')
  if (!isRecord(config.operations)) {
    for (const operation of doctor.operations) {
      if (operation.enabled) operations.add(operation.name)
    }
  }
  return operations
}

function resolveResourceIdentity(config) {
  const d1Name = stringValue(config.cloudflare?.d1?.databaseName)
  const d1Id = stringValue(config.cloudflare?.d1?.databaseId)
  const r2Name = stringValue(config.cloudflare?.r2?.bucketName)
  return Object.freeze({
    d1Name,
    d1NameValid: Boolean(d1Name && CLOUDFLARE_NAME.test(d1Name)),
    d1Id,
    d1IdValid: d1Id === null || D1_DATABASE_ID.test(d1Id),
    r2Name,
    r2NameValid: Boolean(r2Name && CLOUDFLARE_NAME.test(r2Name)),
    standardRateLimitId: stringValue(config.cloudflare?.rateLimits?.standardNamespaceId),
    expensiveRateLimitId: stringValue(config.cloudflare?.rateLimits?.expensiveNamespaceId),
  })
}

function freezeStep(step) {
  return Object.freeze({
    id: step.id,
    category: step.category,
    status: STATUS_ORDER.includes(step.status) ? step.status : 'blocked',
    title: step.title,
    detail: step.detail ?? '',
    commands: Object.freeze([...(step.commands ?? [])]),
    manualActions: Object.freeze([...(step.manualActions ?? [])]),
    relatedOperations: Object.freeze([...(step.relatedOperations ?? [])]),
  })
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
  for (const step of steps) {
    if (step.status === 'action_required') result.actionRequired += 1
    else if (step.status === 'not_applicable') result.notApplicable += 1
    else result[step.status] += 1
  }
  return result
}

function remoteResourceReady(doctor, kind, name) {
  return doctor.remote.status === 'ready'
    && doctor.remote.checkedResources.some((resource) => resource.kind === kind && resource.name === name)
}

function remoteBlockedFor(doctor, label) {
  return doctor.remote.status === 'blocked'
    && doctor.remote.blockers.some((blocker) => blocker.toLowerCase().includes(label.toLowerCase()))
}

function compileCommand(configPath, outputDirectory) {
  return `npm run instance:compile -- --config ${shellQuote(configPath)} --out-dir ${shellQuote(outputDirectory)}`
}

function doctorCommand({ remote = false, configPath = null, outputDirectory = null } = {}) {
  const arguments_ = []
  if (remote) arguments_.push('--remote')
  if (configPath) arguments_.push('--config', shellQuote(configPath))
  if (outputDirectory) arguments_.push('--out-dir', shellQuote(outputDirectory))
  return `npm run instance:doctor${arguments_.length > 0 ? ` -- ${arguments_.join(' ')}` : ''}`
}

function hasEnvironment(env, name) {
  return typeof env[name] === 'string' && env[name].trim().length > 0
}

function isGitHubActionsEnvironment(env) {
  return env.GITHUB_ACTIONS === 'true'
}

function positiveInteger(value) {
  return typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value)
}

function stringValue(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

function statusGlyph(status) {
  if (status === 'complete') return '✓'
  if (status === 'optional' || status === 'verify' || status === 'not_applicable') return '–'
  return '✗'
}

function markdownStatus(status) {
  if (status === 'complete') return '✅ Complete'
  if (status === 'action_required') return '🛠 Action required'
  if (status === 'blocked') return '❌ Blocked'
  if (status === 'verify') return '🔎 Verify'
  if (status === 'optional') return '➖ Optional'
  return '➖ N/A'
}

function escapeTable(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', '<br>')
}

function escapeInline(value) {
  return String(value).replaceAll('`', '\\`')
}

function displayPath(cwd, path) {
  const displayed = relative(cwd, path)
  return displayed && !displayed.startsWith('..') ? normalizePath(displayed) : path
}

function normalizePath(path) {
  return String(path).replaceAll('\\', '/')
}

function absoluteFrom(cwd, path) {
  return isAbsolute(path) ? path : resolve(cwd, path)
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
