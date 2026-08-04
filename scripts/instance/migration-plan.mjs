import { appendFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { buildInstanceUpdate } from './update.mjs'
import {
  buildInstanceMigrationPlanFromProposal as buildCoreMigrationPlanFromProposal,
  instanceMigrationPlanUsage,
  parseInstanceMigrationPlanArguments,
  renderInstanceMigrationPlanMarkdown,
  renderInstanceMigrationPlanText,
} from './migration-plan-core.mjs'

const RISK_ORDER = Object.freeze(['none', 'low', 'medium', 'high'])

export {
  instanceMigrationPlanUsage,
  parseInstanceMigrationPlanArguments,
  renderInstanceMigrationPlanMarkdown,
  renderInstanceMigrationPlanText,
}

export async function buildInstanceMigrationPlan(options, {
  cwd = process.cwd(),
  env = process.env,
} = {}) {
  const updateOptions = options?.updateOptions ?? options
  validateUpdateOptions(updateOptions)
  const proposal = await buildInstanceUpdate({ ...updateOptions, write: false }, { cwd, env })
  return buildInstanceMigrationPlanFromProposal(proposal, updateOptions)
}

export function buildInstanceMigrationPlanFromProposal(proposal, updateOptions) {
  if (!proposal || typeof proposal !== 'object') {
    throw new Error('Instance migration plan proposal is required')
  }
  validateUpdateOptions(updateOptions)

  const core = buildCoreMigrationPlanFromProposal(proposal, updateOptions)
  const remoteImpact = hasRemoteImpact(proposal)
  const initialD1Provisioning = isInitialD1Provisioning(proposal)
  const steps = Object.freeze(core.steps.map((original) => Object.freeze(normalizeStep(original, {
    proposal,
    remoteImpact,
    initialD1Provisioning,
  }))))
  const summary = Object.freeze(summarizeSteps(steps))
  const risk = highestRisk(steps)

  return deepFreeze({
    ...core,
    cutoverReady: summary.blocked === 0,
    risk,
    proposal: {
      ...core.proposal,
      previewCommand: renderUpdateCommand(updateOptions, proposal.displayPath, { write: false }),
      applyCommand: renderUpdateCommand(updateOptions, proposal.displayPath, { write: true }),
    },
    summary,
    steps,
  })
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

function normalizeStep(step, {
  proposal,
  remoteImpact,
  initialD1Provisioning,
}) {
  if (step.id === 'operator-readiness' && proposal.manifest.operations.profile === 'operator') {
    if (!proposal.changed) {
      return replaceStep(step, {
        status: 'complete',
        risk: 'none',
        title: 'Operator resource identities are unchanged',
        detail: 'The requested values already match the operator manifest.',
        commands: [],
        manualActions: [],
        rollbackActions: [],
      })
    }
    if (!remoteImpact) {
      return replaceStep(step, {
        status: 'not_applicable',
        risk: 'none',
        title: 'Operator resource verification is not affected by this repository-only change',
        detail: '',
        commands: [],
        manualActions: [],
        rollbackActions: [],
      })
    }
  }

  if (step.id === 'source-control-baseline' && proposal.changed && !remoteImpact) {
    return replaceStep(step, {
      detail: 'Record the current manifest revision before applying the repository-only change.',
      manualActions: [],
    })
  }

  if (initialD1Provisioning && step.id === 'd1-database') {
    const before = proposal.before.cloudflare.d1
    const after = proposal.manifest.cloudflare.d1
    return replaceStep(step, {
      status: 'action_required',
      risk: 'medium',
      title: 'Provision and verify the target D1 database',
      detail: `${after.databaseName} receives its first database ID ${after.databaseId}.`,
      commands: [],
      manualActions: [
        'Apply the required schema migrations to the target database.',
        'Verify the target database identity and generated binding with read-only checks.',
      ],
      rollbackActions: [`Restore the unprovisioned D1 state for ${before.databaseName}.`],
    })
  }

  if (
    initialD1Provisioning
    && (step.id === 'post-cutover-verification' || step.id === 'rollback-plan')
    && step.risk === 'high'
  ) {
    return replaceStep(step, { risk: 'medium' })
  }

  return {
    ...step,
    commands: [...step.commands],
    manualActions: [...step.manualActions],
    rollbackActions: [...step.rollbackActions],
  }
}

function replaceStep(step, changes) {
  return {
    ...step,
    ...changes,
    commands: [...(changes.commands ?? step.commands ?? [])],
    manualActions: [...(changes.manualActions ?? step.manualActions ?? [])],
    rollbackActions: [...(changes.rollbackActions ?? step.rollbackActions ?? [])],
  }
}

function hasRemoteImpact(proposal) {
  const before = proposal.before
  const after = proposal.manifest
  return before.operations.profile !== after.operations.profile
    || before.cloudflare.workerName !== after.cloudflare.workerName
    || before.site.canonicalOrigin !== after.site.canonicalOrigin
    || before.cloudflare.workersDev !== after.cloudflare.workersDev
    || before.cloudflare.d1.databaseName !== after.cloudflare.d1.databaseName
    || before.cloudflare.d1.databaseId !== after.cloudflare.d1.databaseId
    || before.cloudflare.r2.bucketName !== after.cloudflare.r2.bucketName
    || before.cloudflare.rateLimits.standardNamespaceId !== after.cloudflare.rateLimits.standardNamespaceId
    || before.cloudflare.rateLimits.expensiveNamespaceId !== after.cloudflare.rateLimits.expensiveNamespaceId
    || JSON.stringify(before.transit.enabledCities) !== JSON.stringify(after.transit.enabledCities)
    || before.operations.snapshotSchedule !== after.operations.snapshotSchedule
    || before.operations.releaseSmoke !== after.operations.releaseSmoke
    || before.operations.publicProbe !== after.operations.publicProbe
    || before.operations.windowWatchdog !== after.operations.windowWatchdog
}

function isInitialD1Provisioning(proposal) {
  return !proposal.before.cloudflare.d1.databaseId
    && Boolean(proposal.manifest.cloudflare.d1.databaseId)
}

function renderUpdateCommand(options, displayPath, { write }) {
  const parts = ['--config', shellQuote(displayPath)]
  addValue(parts, '--profile', options.profile)
  addValue(parts, '--site-name', options.siteName)
  addValue(parts, '--origin', options.origin)
  if (options.replaceCities !== null) addValue(parts, '--cities', options.replaceCities.join(','))
  if (options.addCities.length > 0) addValue(parts, '--add-city', options.addCities.join(','))
  if (options.removeCities.length > 0) addValue(parts, '--remove-city', options.removeCities.join(','))
  addValue(parts, '--default-city', options.defaultCity)
  addValue(parts, '--worker-name', options.workerName)
  addValue(parts, '--d1-name', options.d1DatabaseName)
  addValue(parts, '--r2-name', options.r2BucketName)
  addOptional(parts, '--database-id', options.databaseId)
  addOptional(parts, '--standard-rate-limit-id', options.standardNamespaceId)
  addOptional(parts, '--expensive-rate-limit-id', options.expensiveNamespaceId)
  addOptional(parts, '--workers-dev', options.workersDev)
  addValue(parts, '--snapshot-schedule', options.snapshotSchedule)
  addOptional(parts, '--release-smoke', options.releaseSmoke)
  addOptional(parts, '--public-probe', options.publicProbe)
  addOptional(parts, '--window-watchdog', options.windowWatchdog)
  if (options.clearDemoQuery) parts.push('--clear-demo-query')
  if (write) parts.push('--write')
  return `npm run instance:update -- ${parts.join(' ')}`
}

function addValue(parts, option, value) {
  if (value === null || value === undefined) return
  parts.push(option, shellQuote(String(value)))
}

function addOptional(parts, option, value) {
  if (value === undefined) return
  parts.push(option, shellQuote(value === null ? 'null' : String(value)))
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

function validateUpdateOptions(options) {
  if (!options || typeof options !== 'object') {
    throw new Error('Instance migration plan options are required')
  }
  if (options.write) {
    throw new Error('instance:migration-plan is non-destructive and does not accept --write')
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`
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
