import { appendFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import {
  buildInstanceUpdate,
  parseInstanceUpdateArguments,
} from './update.mjs'

const STATUS_ORDER = Object.freeze(['blocked', 'action_required', 'verify', 'complete', 'not_applicable'])
const RISK_ORDER = Object.freeze(['none', 'low', 'medium', 'high'])

export function parseInstanceMigrationPlanArguments(argv = process.argv.slice(2)) {
  const forwarded = []
  let githubSummary = false

  for (const argument of argv) {
    if (argument === '--github-summary') {
      githubSummary = true
      continue
    }
    forwarded.push(argument)
  }

  const updateOptions = parseInstanceUpdateArguments(forwarded)
  if (updateOptions.write) {
    throw new Error('instance:migration-plan is non-destructive and does not accept --write')
  }

  return Object.freeze({
    updateOptions,
    json: updateOptions.json,
    help: updateOptions.help,
    githubSummary,
  })
}

export async function buildInstanceMigrationPlan(options, {
  cwd = process.cwd(),
  env = process.env,
} = {}) {
  const updateOptions = options?.updateOptions ?? options
  if (!updateOptions || typeof updateOptions !== 'object') {
    throw new Error('Instance migration plan options are required')
  }
  if (updateOptions.write) {
    throw new Error('instance:migration-plan is non-destructive and does not accept --write')
  }

  const proposal = await buildInstanceUpdate({ ...updateOptions, write: false }, { cwd, env })
  const facts = migrationFacts(proposal)
  const steps = Object.freeze(buildSteps(proposal, facts).map(freezeStep))
  const summary = Object.freeze(summarizeSteps(steps))
  const risk = highestRisk(steps)
  const previewCommand = renderUpdateCommand(updateOptions, proposal.displayPath, { write: false })
  const applyCommand = renderUpdateCommand(updateOptions, proposal.displayPath, { write: true })

  return Object.freeze({
    schemaVersion: 1,
    nonDestructive: true,
    changed: proposal.changed,
    cutoverReady: summary.blocked === 0,
    provisioningDraft: proposal.provisioningDraft,
    risk,
    instance: Object.freeze({
      id: proposal.manifest.instanceId,
      configPath: proposal.displayPath,
      fromProfile: proposal.before.operations.profile,
      toProfile: proposal.manifest.operations.profile,
    }),
    proposal: Object.freeze({
      previewCommand,
      applyCommand,
      changes: proposal.changes,
      warnings: proposal.warnings,
    }),
    summary,
    steps,
  })
}

export function renderInstanceMigrationPlanText(plan) {
  const lines = [
    'Mochi Bus instance migration plan',
    '',
    `${plan.instance.id} · ${plan.instance.fromProfile} → ${plan.instance.toProfile} · ${plan.risk.toUpperCase()} RISK`,
    `${plan.summary.actionRequired} action required · ${plan.summary.blocked} blocked · ${plan.summary.verify} verify`,
    `Config: ${plan.instance.configPath}`,
    '',
  ]

  if (plan.proposal.changes.length === 0) {
    lines.push('No effective manifest changes were found.', '')
  } else {
    lines.push(`Manifest changes (${plan.proposal.changes.length}):`)
    for (const change of plan.proposal.changes) {
      lines.push(`~ ${change.path}`)
      lines.push(`  before: ${JSON.stringify(change.before)}`)
      lines.push(`  after:  ${JSON.stringify(change.after)}`)
    }
    lines.push('')
  }

  for (const step of plan.steps) {
    lines.push(`${statusGlyph(step.status)} [${step.phase}/${step.category}] ${step.title}`)
    if (step.detail) lines.push(`  ${step.detail}`)
    for (const command of step.commands) lines.push(`  $ ${command}`)
    for (const action of step.manualActions) lines.push(`  - ${action}`)
    for (const rollback of step.rollbackActions) lines.push(`  rollback: ${rollback}`)
  }

  lines.push('', `Preview: ${plan.proposal.previewCommand}`)
  lines.push(`Apply after review: ${plan.proposal.applyCommand}`)
  lines.push('', 'NO CHANGES WERE APPLIED')
  return `${lines.join('\n')}\n`
}

export function renderInstanceMigrationPlanMarkdown(plan) {
  const lines = [
    '## Mochi Bus instance migration plan',
    '',
    `**${plan.cutoverReady ? 'No known cutover blocker' : 'Cutover is blocked'} · ${plan.risk.toUpperCase()} risk**`,
    '',
    `Instance: \`${escapeInline(plan.instance.id)}\` · profile: \`${escapeInline(plan.instance.fromProfile)}\` → \`${escapeInline(plan.instance.toProfile)}\``,
    '',
    '| Status | Phase | Area | Step | Detail |',
    '| --- | --- | --- | --- | --- |',
  ]

  for (const step of plan.steps) {
    const detail = [
      step.detail,
      ...step.commands.map((command) => `\`${command}\``),
      ...step.manualActions,
      ...step.rollbackActions.map((action) => `Rollback: ${action}`),
    ].filter(Boolean).join('<br>')
    lines.push(`| ${markdownStatus(step.status)} | ${escapeTable(step.phase)} | ${escapeTable(step.category)} | ${escapeTable(step.title)} | ${escapeTable(detail)} |`)
  }

  lines.push(
    '',
    `Preview command: \`${escapeInline(plan.proposal.previewCommand)}\``,
    '',
    '> This report is non-destructive. It did not write the manifest, contact Cloudflare, deploy a Worker, copy R2 objects, migrate D1 data, or change GitHub settings.',
    '',
  )
  return `${lines.join('\n')}\n`
}

export function instanceMigrationPlanUsage() {
  return `Build a non-destructive migration, verification and rollback plan for a proposed instance update.\n\nUsage:\n  npm run instance:migration-plan -- [--config <path>] <instance:update options>\n\nThe command reuses the preview-first instance updater. It never accepts --write and never changes local or remote resources.\n\nIdentity and profile:\n  --profile <starter|managed|operator>\n  --site-name <name>\n  --origin <request|https://host>\n\nCities:\n  --cities <City[,City...]>\n  --add-city <City[,City...]>\n  --remove-city <City[,City...]>\n  --default-city <city>\n  --clear-demo-query\n\nCloudflare resources:\n  --worker-name <name>\n  --d1-name <name>\n  --r2-name <name>\n  --database-id <uuid|null>\n  --standard-rate-limit-id <id|null>\n  --expensive-rate-limit-id <id|null>\n  --workers-dev <true|false>\n\nOperations:\n  --snapshot-schedule <manual|daily|taipei-weekly-sharded>\n  --release-smoke <true|false>\n  --public-probe <true|false>\n  --window-watchdog <true|false>\n\nOutput:\n  --config <path>\n  --json\n  --github-summary        Append a Markdown plan to GITHUB_STEP_SUMMARY\n  --help\n`
}

export async function main({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  env = process.env,
  stdout = process.stdout,
} = {}) {
  const options = parseInstanceMigrationPlanArguments(argv)
  if (options.help) {
    stdout.write(instanceMigrationPlanUsage())
    return null
  }

  const plan = await buildInstanceMigrationPlan(options, { cwd, env })
  stdout.write(options.json
    ? `${JSON.stringify(plan, null, 2)}\n`
    : renderInstanceMigrationPlanText(plan))

  if (options.githubSummary) {
    const summaryPath = typeof env.GITHUB_STEP_SUMMARY === 'string' ? env.GITHUB_STEP_SUMMARY.trim() : ''
    if (!summaryPath) throw new Error('--github-summary requires GITHUB_STEP_SUMMARY')
    await appendFile(summaryPath, renderInstanceMigrationPlanMarkdown(plan), 'utf8')
  }
  return plan
}

function migrationFacts(proposal) {
  const before = proposal.before
  const after = proposal.manifest
  const changedPaths = new Set(proposal.changes.map((change) => change.path))
  const beforeCities = before.transit.enabledCities
  const afterCities = after.transit.enabledCities

  return Object.freeze({
    changedPaths,
    profileChanged: before.operations.profile !== after.operations.profile,
    workerNameChanged: before.cloudflare.workerName !== after.cloudflare.workerName,
    originChanged: before.site.canonicalOrigin !== after.site.canonicalOrigin,
    workersDevChanged: before.cloudflare.workersDev !== after.cloudflare.workersDev,
    d1NameChanged: before.cloudflare.d1.databaseName !== after.cloudflare.d1.databaseName,
    d1IdChanged: before.cloudflare.d1.databaseId !== after.cloudflare.d1.databaseId,
    r2NameChanged: before.cloudflare.r2.bucketName !== after.cloudflare.r2.bucketName,
    standardRateLimitChanged: before.cloudflare.rateLimits.standardNamespaceId !== after.cloudflare.rateLimits.standardNamespaceId,
    expensiveRateLimitChanged: before.cloudflare.rateLimits.expensiveNamespaceId !== after.cloudflare.rateLimits.expensiveNamespaceId,
    addedCities: Object.freeze(afterCities.filter((city) => !beforeCities.includes(city))),
    removedCities: Object.freeze(beforeCities.filter((city) => !afterCities.includes(city))),
    operationsChanged: [
      'operations.snapshotSchedule',
      'operations.releaseSmoke',
      'operations.publicProbe',
      'operations.windowWatchdog',
    ].some((path) => changedPaths.has(path)),
    remoteImpact: false,
  })
}

function buildSteps(proposal, facts) {
  const steps = []
  steps.push(sourceControlStep(proposal))
  steps.push(profileStep(proposal, facts))
  steps.push(operatorReadinessStep(proposal))
  steps.push(workerStep(proposal, facts))
  steps.push(d1Step(proposal, facts))
  steps.push(r2Step(proposal, facts))
  steps.push(rateLimitStep(proposal, facts))
  steps.push(transitStep(proposal, facts))
  steps.push(operationsStep(proposal, facts))
  steps.push(cutoverStep(proposal))
  steps.push(verificationStep(proposal, facts))
  steps.push(rollbackStep(proposal, facts))
  return steps
}

function sourceControlStep(proposal) {
  if (!proposal.changed) {
    return step({
      id: 'source-control-baseline',
      phase: 'prepare',
      category: 'repository',
      status: 'complete',
      risk: 'none',
      title: 'No source-control baseline change is required',
      detail: 'The requested values already match the manifest.',
    })
  }
  return step({
    id: 'source-control-baseline',
    phase: 'prepare',
    category: 'repository',
    status: 'verify',
    risk: 'low',
    title: 'Record the current deployment baseline',
    detail: 'Preserve the current manifest revision and active deployment identities before any remote change.',
    commands: [`git diff -- ${shellQuote(proposal.displayPath)}`],
    manualActions: [
      'Record the current Worker deployment/version and custom-domain routing.',
      'Record the current D1 ID, R2 bucket and rate-limit namespace IDs.',
    ],
  })
}

function profileStep(proposal, facts) {
  if (!facts.profileChanged) {
    return step({
      id: 'profile-transition',
      phase: 'prepare',
      category: 'operations',
      status: 'not_applicable',
      risk: 'none',
      title: 'No deployment profile transition',
    })
  }
  return step({
    id: 'profile-transition',
    phase: 'prepare',
    category: 'operations',
    status: 'action_required',
    risk: proposal.manifest.operations.profile === 'operator' ? 'high' : 'medium',
    title: `Review the ${proposal.before.operations.profile} → ${proposal.manifest.operations.profile} profile transition`,
    detail: 'The updater reapplies profile operation defaults, but it does not create secrets, repository variables, schedules or Cloudflare resources.',
    commands: [`npm run instance:provision-plan -- --config ${shellQuote(proposal.displayPath)}`],
    manualActions: [
      'Review every enabled operation and its GitHub secret/variable requirements.',
      'Confirm whether scheduled workflows should start, stop or change cadence at cutover.',
    ],
    rollbackActions: [`Restore profile ${proposal.before.operations.profile} and its previous operation settings.`],
  })
}

function operatorReadinessStep(proposal) {
  if (proposal.manifest.operations.profile !== 'operator') {
    return step({
      id: 'operator-readiness',
      phase: 'prepare',
      category: 'cloudflare',
      status: 'not_applicable',
      risk: 'none',
      title: 'Operator resource identity is not required by the target profile',
    })
  }
  if (!proposal.provisioningDraft) {
    return step({
      id: 'operator-readiness',
      phase: 'prepare',
      category: 'cloudflare',
      status: 'verify',
      risk: 'medium',
      title: 'Verify operator resource identities before cutover',
      detail: 'The target manifest contains D1 and rate-limit identities, but this local plan does not prove that the remote resources exist.',
      commands: [
        `npm run instance:doctor -- --config ${shellQuote(proposal.displayPath)} --remote`,
      ],
    })
  }
  return step({
    id: 'operator-readiness',
    phase: 'prepare',
    category: 'cloudflare',
    status: 'blocked',
    risk: 'high',
    title: 'Provision missing operator identities before cutover',
    detail: proposal.strictValidation.errors.join('; '),
    commands: [`npm run instance:provision-plan -- --config ${shellQuote(proposal.displayPath)}`],
    manualActions: ['Do not deploy the operator target until every required D1 and rate-limit identity is recorded.'],
  })
}

function workerStep(proposal, facts) {
  if (!facts.workerNameChanged && !facts.originChanged && !facts.workersDevChanged) {
    return step({
      id: 'worker-routing',
      phase: 'remote-resources',
      category: 'worker',
      status: 'not_applicable',
      risk: 'none',
      title: 'Worker identity and public routing are unchanged',
    })
  }
  const changes = []
  if (facts.workerNameChanged) changes.push(`Worker ${proposal.before.cloudflare.workerName} → ${proposal.manifest.cloudflare.workerName}`)
  if (facts.originChanged) changes.push(`origin ${proposal.before.site.canonicalOrigin} → ${proposal.manifest.site.canonicalOrigin}`)
  if (facts.workersDevChanged) changes.push(`workers.dev ${proposal.before.cloudflare.workersDev} → ${proposal.manifest.cloudflare.workersDev}`)
  return step({
    id: 'worker-routing',
    phase: 'remote-resources',
    category: 'worker',
    status: 'action_required',
    risk: facts.workerNameChanged || facts.originChanged ? 'high' : 'medium',
    title: 'Prepare Worker identity and traffic routing',
    detail: changes.join('; '),
    manualActions: [
      'Deploy and verify the target Worker before moving production traffic.',
      'Verify custom-domain and workers.dev routing independently of the manifest preview.',
      'Keep the previous Worker route available until post-cutover checks pass.',
    ],
    rollbackActions: [
      `Route traffic back to ${proposal.before.cloudflare.workerName}.`,
      `Restore canonical origin ${proposal.before.site.canonicalOrigin}.`,
    ],
  })
}

function d1Step(proposal, facts) {
  if (!facts.d1NameChanged && !facts.d1IdChanged) {
    return step({
      id: 'd1-database',
      phase: 'remote-resources',
      category: 'd1',
      status: 'not_applicable',
      risk: 'none',
      title: 'D1 identity is unchanged',
    })
  }
  const before = proposal.before.cloudflare.d1
  const after = proposal.manifest.cloudflare.d1
  if (facts.d1IdChanged && !after.databaseId) {
    return step({
      id: 'd1-database',
      phase: 'remote-resources',
      category: 'd1',
      status: 'blocked',
      risk: 'high',
      title: 'Do not cut over with the D1 identity removed',
      detail: `The previous database ID ${before.databaseId ?? '<none>'} would be replaced by null.`,
      manualActions: ['Provision or deliberately select the target D1 database before deployment.'],
      rollbackActions: [`Restore D1 ${before.databaseName} (${before.databaseId ?? 'unprovisioned'}).`],
    })
  }
  if (facts.d1IdChanged) {
    return step({
      id: 'd1-database',
      phase: 'remote-resources',
      category: 'd1',
      status: 'action_required',
      risk: 'high',
      title: 'Migrate and verify the target D1 database',
      detail: `${before.databaseName} (${before.databaseId ?? 'none'}) → ${after.databaseName} (${after.databaseId})`,
      manualActions: [
        'Apply the required schema migrations to the target database.',
        'Copy or rebuild required production data and compare critical row counts.',
        'Run read-only application probes against the target before cutover.',
        'Retain the previous database without destructive cleanup until rollback expires.',
      ],
      rollbackActions: [`Rebind ${before.databaseName} with database ID ${before.databaseId ?? '<none>'}.`],
    })
  }
  return step({
    id: 'd1-database',
    phase: 'remote-resources',
    category: 'd1',
    status: 'verify',
    risk: 'medium',
    title: 'Verify the preserved D1 ID/name pair',
    detail: `The name changes from ${before.databaseName} to ${after.databaseName} while database ID ${after.databaseId} is preserved.`,
    commands: [`npm run instance:doctor -- --config ${shellQuote(proposal.displayPath)} --remote`],
    manualActions: ['Confirm the manifest label matches the remote database resolved by the preserved ID.'],
    rollbackActions: [`Restore D1 display name ${before.databaseName}.`],
  })
}

function r2Step(proposal, facts) {
  if (!facts.r2NameChanged) {
    return step({
      id: 'r2-bucket',
      phase: 'remote-resources',
      category: 'r2',
      status: 'not_applicable',
      risk: 'none',
      title: 'R2 bucket identity is unchanged',
    })
  }
  const before = proposal.before.cloudflare.r2.bucketName
  const after = proposal.manifest.cloudflare.r2.bucketName
  return step({
    id: 'r2-bucket',
    phase: 'remote-resources',
    category: 'r2',
    status: 'action_required',
    risk: 'high',
    title: 'Copy and verify R2 snapshot objects',
    detail: `${before} → ${after}; changing the manifest does not rename a bucket or copy any object.`,
    manualActions: [
      'Create or verify the target bucket.',
      'Copy required snapshot objects and metadata.',
      'Compare object counts, representative checksums and public read behavior.',
      'Keep the source bucket available until the rollback window closes.',
    ],
    rollbackActions: [`Rebind the Worker and snapshot jobs to R2 bucket ${before}.`],
  })
}

function rateLimitStep(proposal, facts) {
  if (!facts.standardRateLimitChanged && !facts.expensiveRateLimitChanged) {
    return step({
      id: 'rate-limit-identities',
      phase: 'remote-resources',
      category: 'rate-limits',
      status: 'not_applicable',
      risk: 'none',
      title: 'Rate-limit namespace identities are unchanged',
    })
  }
  const before = proposal.before.cloudflare.rateLimits
  const after = proposal.manifest.cloudflare.rateLimits
  const removed = !after.standardNamespaceId || !after.expensiveNamespaceId
  return step({
    id: 'rate-limit-identities',
    phase: 'remote-resources',
    category: 'rate-limits',
    status: removed && proposal.manifest.operations.profile === 'operator' ? 'blocked' : 'action_required',
    risk: removed ? 'high' : 'medium',
    title: 'Verify replacement rate-limit namespace identities',
    detail: `standard ${before.standardNamespaceId ?? 'none'} → ${after.standardNamespaceId ?? 'none'}; expensive ${before.expensiveNamespaceId ?? 'none'} → ${after.expensiveNamespaceId ?? 'none'}`,
    manualActions: [
      'Confirm both target namespace IDs exist and remain distinct.',
      'Verify standard and expensive bindings retain their intended limits.',
    ],
    rollbackActions: [`Restore namespace IDs ${before.standardNamespaceId ?? 'none'} and ${before.expensiveNamespaceId ?? 'none'}.`],
  })
}

function transitStep(proposal, facts) {
  if (facts.addedCities.length === 0 && facts.removedCities.length === 0) {
    return step({
      id: 'transit-scope',
      phase: 'remote-resources',
      category: 'snapshots',
      status: 'not_applicable',
      risk: 'none',
      title: 'Enabled transit city scope is unchanged',
    })
  }
  const detail = [
    facts.addedCities.length ? `add ${facts.addedCities.join(', ')}` : null,
    facts.removedCities.length ? `remove ${facts.removedCities.join(', ')}` : null,
  ].filter(Boolean).join('; ')
  const actions = []
  if (facts.addedCities.length) actions.push('Seed and validate snapshots for every added city before advertising support.')
  if (facts.removedCities.length) actions.push('Choose a retention policy for removed-city D1/R2 data before cleanup.')
  return step({
    id: 'transit-scope',
    phase: 'remote-resources',
    category: 'snapshots',
    status: 'action_required',
    risk: facts.removedCities.length ? 'high' : 'medium',
    title: 'Prepare transit snapshot scope changes',
    detail,
    manualActions: actions,
    rollbackActions: [`Restore enabled cities ${proposal.before.transit.enabledCities.join(', ')}.`],
  })
}

function operationsStep(proposal, facts) {
  if (!facts.profileChanged && !facts.operationsChanged) {
    return step({
      id: 'scheduled-operations',
      phase: 'remote-resources',
      category: 'operations',
      status: 'not_applicable',
      risk: 'none',
      title: 'Snapshot and verification operation settings are unchanged',
    })
  }
  return step({
    id: 'scheduled-operations',
    phase: 'remote-resources',
    category: 'operations',
    status: 'action_required',
    risk: 'medium',
    title: 'Coordinate scheduled operation changes',
    detail: `Snapshot ${proposal.before.operations.snapshotSchedule} → ${proposal.manifest.operations.snapshotSchedule}; release smoke ${proposal.before.operations.releaseSmoke} → ${proposal.manifest.operations.releaseSmoke}; public probe ${proposal.before.operations.publicProbe} → ${proposal.manifest.operations.publicProbe}; watchdog ${proposal.before.operations.windowWatchdog} → ${proposal.manifest.operations.windowWatchdog}.`,
    manualActions: [
      'Confirm GitHub schedules and required secrets before enabling new operations.',
      'Prevent old and new snapshot publishers from running concurrently during cutover.',
    ],
    rollbackActions: ['Restore the previous workflow schedules and operation flags.'],
  })
}

function cutoverStep(proposal) {
  if (!proposal.changed) {
    return step({
      id: 'manifest-cutover',
      phase: 'cutover',
      category: 'repository',
      status: 'complete',
      risk: 'none',
      title: 'No manifest cutover is required',
    })
  }
  return step({
    id: 'manifest-cutover',
    phase: 'cutover',
    category: 'repository',
    status: proposal.provisioningDraft ? 'blocked' : 'action_required',
    risk: proposal.provisioningDraft ? 'high' : 'medium',
    title: 'Apply the reviewed manifest proposal',
    detail: proposal.provisioningDraft
      ? 'The target is still an operator provisioning draft and must not be deployed.'
      : 'Apply only after the required remote resources and rollback baseline are ready.',
    manualActions: ['Run the exact reviewed update again with --write, then commit the manifest change.'],
    rollbackActions: ['Restore the previous manifest revision and regenerate instance artifacts.'],
  })
}

function verificationStep(proposal, facts) {
  if (!proposal.changed) {
    return step({
      id: 'post-cutover-verification',
      phase: 'verify',
      category: 'verification',
      status: 'complete',
      risk: 'none',
      title: 'No post-cutover verification is required for a no-op proposal',
    })
  }
  const commands = [
    `npm run instance:validate -- --config ${shellQuote(proposal.displayPath)}`,
    `npm run instance:compile -- --config ${shellQuote(proposal.displayPath)}`,
    'npm run check',
  ]
  if (hasRemoteImpact(facts)) {
    commands.splice(2, 0, `npm run instance:doctor -- --config ${shellQuote(proposal.displayPath)} --remote`)
  }
  return step({
    id: 'post-cutover-verification',
    phase: 'verify',
    category: 'verification',
    status: 'verify',
    risk: hasRemoteImpact(facts) ? 'high' : 'low',
    title: 'Run repository and live-service verification',
    detail: hasRemoteImpact(facts)
      ? 'Validate generated artifacts and independently confirm remote resources and public behavior.'
      : 'This proposal is repository-only, but generated artifacts and tests still need confirmation.',
    commands,
    manualActions: hasRemoteImpact(facts)
      ? ['Run release smoke, public probe and representative city queries before closing rollback.']
      : [],
  })
}

function rollbackStep(proposal, facts) {
  if (!proposal.changed) {
    return step({
      id: 'rollback-plan',
      phase: 'rollback',
      category: 'recovery',
      status: 'not_applicable',
      risk: 'none',
      title: 'No rollback is required for a no-op proposal',
    })
  }
  const actions = [
    'Restore the previous manifest revision and regenerate instance artifacts.',
  ]
  if (facts.workerNameChanged || facts.originChanged || facts.workersDevChanged) {
    actions.push(`Redeploy or route traffic back to Worker ${proposal.before.cloudflare.workerName}.`)
  }
  if (facts.d1NameChanged || facts.d1IdChanged) {
    actions.push(`Rebind D1 ${proposal.before.cloudflare.d1.databaseName} (${proposal.before.cloudflare.d1.databaseId ?? 'none'}).`)
  }
  if (facts.r2NameChanged) actions.push(`Rebind R2 bucket ${proposal.before.cloudflare.r2.bucketName}.`)
  if (facts.standardRateLimitChanged || facts.expensiveRateLimitChanged) {
    actions.push('Restore the previous rate-limit namespace IDs.')
  }
  if (facts.profileChanged || facts.operationsChanged) actions.push('Restore previous schedules, secrets and operation flags.')
  return step({
    id: 'rollback-plan',
    phase: 'rollback',
    category: 'recovery',
    status: 'verify',
    risk: hasRemoteImpact(facts) ? 'high' : 'low',
    title: 'Review the complete rollback sequence',
    detail: 'Do not delete previous remote resources until the rollback window and post-cutover verification are complete.',
    manualActions: actions,
  })
}

function hasRemoteImpact(facts) {
  return facts.profileChanged
    || facts.workerNameChanged
    || facts.originChanged
    || facts.workersDevChanged
    || facts.d1NameChanged
    || facts.d1IdChanged
    || facts.r2NameChanged
    || facts.standardRateLimitChanged
    || facts.expensiveRateLimitChanged
    || facts.addedCities.length > 0
    || facts.removedCities.length > 0
    || facts.operationsChanged
}

function renderUpdateCommand(options, displayPath, { write }) {
  const args = ['--config', displayPath]
  addValue(args, '--profile', options.profile)
  addValue(args, '--site-name', options.siteName)
  addValue(args, '--origin', options.origin)
  if (options.replaceCities !== null) addValue(args, '--cities', options.replaceCities.join(','))
  if (options.addCities.length > 0) addValue(args, '--add-city', options.addCities.join(','))
  if (options.removeCities.length > 0) addValue(args, '--remove-city', options.removeCities.join(','))
  addValue(args, '--default-city', options.defaultCity)
  addValue(args, '--worker-name', options.workerName)
  addValue(args, '--d1-name', options.d1DatabaseName)
  addValue(args, '--r2-name', options.r2BucketName)
  addOptional(args, '--database-id', options.databaseId)
  addOptional(args, '--standard-rate-limit-id', options.standardNamespaceId)
  addOptional(args, '--expensive-rate-limit-id', options.expensiveNamespaceId)
  addOptional(args, '--workers-dev', options.workersDev)
  addValue(args, '--snapshot-schedule', options.snapshotSchedule)
  addOptional(args, '--release-smoke', options.releaseSmoke)
  addOptional(args, '--public-probe', options.publicProbe)
  addOptional(args, '--window-watchdog', options.windowWatchdog)
  if (options.clearDemoQuery) args.push('--clear-demo-query')
  if (write) args.push('--write')
  return `npm run instance:update -- ${args.map(formatShellArgument).join(' ')}`
}

function addValue(args, name, value) {
  if (value === null || value === undefined) return
  args.push(name, String(value))
}

function addOptional(args, name, value) {
  if (value === undefined) return
  args.push(name, value === null ? 'null' : String(value))
}

function formatShellArgument(value) {
  return String(value).startsWith('--') ? String(value) : shellQuote(value)
}

function step({
  id,
  phase,
  category,
  status,
  risk,
  title,
  detail = '',
  commands = [],
  manualActions = [],
  rollbackActions = [],
}) {
  return {
    id,
    phase,
    category,
    status,
    risk,
    title,
    detail,
    commands,
    manualActions,
    rollbackActions,
  }
}

function freezeStep(value) {
  if (!STATUS_ORDER.includes(value.status)) throw new Error(`Unsupported migration step status: ${value.status}`)
  if (!RISK_ORDER.includes(value.risk)) throw new Error(`Unsupported migration step risk: ${value.risk}`)
  return Object.freeze({
    ...value,
    commands: Object.freeze([...(value.commands ?? [])]),
    manualActions: Object.freeze([...(value.manualActions ?? [])]),
    rollbackActions: Object.freeze([...(value.rollbackActions ?? [])]),
  })
}

function summarizeSteps(steps) {
  const summary = {
    blocked: 0,
    actionRequired: 0,
    verify: 0,
    complete: 0,
    notApplicable: 0,
  }
  for (const step of steps) {
    if (step.status === 'action_required') summary.actionRequired += 1
    else if (step.status === 'not_applicable') summary.notApplicable += 1
    else summary[step.status] += 1
  }
  return summary
}

function highestRisk(steps) {
  let index = 0
  for (const step of steps) index = Math.max(index, RISK_ORDER.indexOf(step.risk))
  return RISK_ORDER[index]
}

function statusGlyph(status) {
  if (status === 'blocked') return '✗'
  if (status === 'action_required') return '!'
  if (status === 'verify') return '?'
  if (status === 'complete') return '✓'
  return '○'
}

function markdownStatus(status) {
  if (status === 'blocked') return '❌ blocked'
  if (status === 'action_required') return '⚠️ action required'
  if (status === 'verify') return '🔎 verify'
  if (status === 'complete') return '✅ complete'
  return '➖ not applicable'
}

function escapeInline(value) {
  return String(value).replaceAll('`', '\\`')
}

function escapeTable(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', '<br>')
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`
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
