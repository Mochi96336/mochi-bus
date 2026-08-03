import { appendFile, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { pathToFileURL } from 'node:url'
import {
  DEFAULT_OUTPUT_DIRECTORY,
  compileInstanceConfig,
  loadInstanceConfig,
  rebaseWranglerConfig,
  resolveInstanceConfigPath,
} from './config.mjs'
import {
  DEFAULT_OPERATIONS_PLAN_PATH,
  validateOperationsPlan,
} from './operations-plan.mjs'
import {
  DEFAULT_RUNTIME_CONFIG_PATH,
  DEFAULT_WRANGLER_CONFIG_PATH,
  resolveOperationalResources,
  validateOperationalEnvironment,
} from './operational-resources.mjs'
import {
  inspectOperatorPreflight,
  verifyOperatorResources,
} from './operator-preflight.mjs'

const OPERATION_SPECS = Object.freeze([
  Object.freeze({ name: 'deploy', label: 'Deploy', alwaysEnabled: true }),
  Object.freeze({ name: 'snapshot', label: 'Snapshot publication', alwaysEnabled: true, forceEnabled: true }),
  Object.freeze({ name: 'publicProbe', label: 'Public probe', check: 'publicProbe' }),
  Object.freeze({ name: 'windowWatchdog', label: 'Snapshot watchdog', check: 'windowWatchdog' }),
])

export function parseInstanceDoctorArguments(argv = process.argv.slice(2)) {
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
    throw new Error(`Unknown instance doctor option: ${argument}`)
  }

  return Object.freeze({ configPath, outputDirectory, remote, json, githubSummary })
}

export async function diagnoseInstance({
  cwd = process.cwd(),
  env = process.env,
  configPath = null,
  outputDirectory = null,
  remote = false,
  fetchImpl = fetch,
} = {}) {
  const manifest = {
    status: 'blocked',
    path: null,
    blockers: [],
    instanceId: null,
    siteName: null,
    profile: null,
    enabledCities: [],
    defaultCity: null,
    snapshotSchedule: null,
  }

  let config = null
  let compiled = null
  try {
    const resolvedConfigPath = configPath
      ? absoluteFrom(cwd, configPath)
      : await resolveInstanceConfigPath({ cwd, argv: [], env })
    manifest.path = displayPath(cwd, resolvedConfigPath)
    config = await loadInstanceConfig(resolvedConfigPath)
    compiled = compileInstanceConfig(config)
    Object.assign(manifest, {
      status: 'ready',
      instanceId: config.instanceId,
      siteName: config.site.name,
      profile: config.operations.profile,
      enabledCities: [...config.transit.enabledCities],
      defaultCity: config.transit.defaultCity,
      snapshotSchedule: config.operations.snapshotSchedule,
    })
  } catch (error) {
    manifest.blockers.push(...errorMessages(error))
  }

  const artifactPaths = resolveArtifactPaths({ cwd, env, outputDirectory })
  const generated = []
  const parsed = {}
  if (compiled) {
    const expectedWrangler = rebaseWranglerConfig(
      compiled.wrangler,
      dirname(artifactPaths.wrangler),
      cwd,
    )
    generated.push(await inspectGeneratedArtifact({
      key: 'runtime',
      label: 'Runtime config',
      path: artifactPaths.runtime,
      expected: compiled.runtime,
      cwd,
    }))
    generated.push(await inspectGeneratedArtifact({
      key: 'wrangler',
      label: 'Wrangler config',
      path: artifactPaths.wrangler,
      expected: expectedWrangler,
      cwd,
    }))
    generated.push(await inspectGeneratedArtifact({
      key: 'operations',
      label: 'Operations plan',
      path: artifactPaths.operations,
      expected: compiled.operations,
      cwd,
      validate: (value, path) => validateOperationsPlan(value, { source: path }),
    }))
    for (const artifact of generated) {
      if (artifact.status === 'ready') parsed[artifact.key] = artifact.value
      delete artifact.value
    }
  } else {
    for (const [key, label, path] of [
      ['runtime', 'Runtime config', artifactPaths.runtime],
      ['wrangler', 'Wrangler config', artifactPaths.wrangler],
      ['operations', 'Operations plan', artifactPaths.operations],
    ]) {
      generated.push({
        key,
        label,
        path: displayPath(cwd, path),
        status: 'not_checked',
        blockers: ['The instance manifest must validate before generated artifacts can be compared'],
      })
    }
  }

  const allGeneratedReady = generated.every((artifact) => artifact.status === 'ready')
  let plan = null
  let resources = null
  const environment = { status: 'not_checked', blockers: [] }
  if (allGeneratedReady) {
    try {
      plan = validateOperationsPlan(parsed.operations, { source: artifactPaths.operations })
      resources = resolveOperationalResources(parsed.runtime, parsed.wrangler, {
        runtimePath: artifactPaths.runtime,
        wranglerPath: artifactPaths.wrangler,
      })
      validateOperationalEnvironment(resources, env)
      environment.status = 'ready'
    } catch (error) {
      environment.status = 'blocked'
      environment.blockers.push(...errorMessages(error))
    }
  } else {
    environment.blockers.push('Generated instance artifacts must be current before environment identity can be checked')
  }

  const operations = []
  const inspections = []
  if (plan && resources) {
    for (const spec of OPERATION_SPECS) {
      const configuredEnabled = spec.alwaysEnabled || Boolean(plan.checks[spec.check])
      if (!configuredEnabled) {
        operations.push({
          name: spec.name,
          label: spec.label,
          enabled: false,
          mode: operationMode(spec.name, plan),
          status: 'disabled',
          blockers: [],
          warnings: [],
        })
        continue
      }
      const inspection = inspectOperatorPreflight({
        operation: spec.name,
        forceEnabled: Boolean(spec.forceEnabled),
        plan,
        resources,
        env,
      })
      inspections.push(inspection)
      const blockers = [...environment.blockers, ...inspection.blockers]
      operations.push({
        name: spec.name,
        label: spec.label,
        enabled: true,
        mode: operationMode(spec.name, plan),
        status: blockers.length === 0 ? 'ready' : 'blocked',
        blockers: unique(blockers),
        warnings: [...inspection.warnings],
      })
    }
  } else {
    for (const spec of OPERATION_SPECS) {
      operations.push({
        name: spec.name,
        label: spec.label,
        enabled: true,
        mode: null,
        status: 'not_checked',
        blockers: ['Generated operations and resource identity must validate first'],
        warnings: [],
      })
    }
  }

  const remoteReport = {
    requested: remote,
    status: remote ? 'blocked' : 'not_checked',
    checkedResources: [],
    blockers: [],
  }
  if (remote) {
    if (!plan || !resources || environment.status !== 'ready') {
      remoteReport.blockers.push('Local instance and environment checks must pass before remote verification')
    } else if (!resources.d1DatabaseId) {
      remoteReport.blockers.push('Remote verification requires a provisioned D1 database ID')
    } else {
      try {
        const remoteChecks = dedupeRemoteChecks(inspections.flatMap((inspection) => inspection.remoteChecks))
        remoteReport.checkedResources = [...await verifyOperatorResources({ remoteChecks, env, fetchImpl })]
        remoteReport.status = 'ready'
      } catch (error) {
        remoteReport.blockers.push(...errorMessages(error))
      }
    }
  }

  const ok = manifest.status === 'ready'
    && allGeneratedReady
    && environment.status === 'ready'
    && operations.every((operation) => operation.status === 'ready' || operation.status === 'disabled')
    && (!remote || remoteReport.status === 'ready')

  return {
    schemaVersion: 1,
    ok,
    manifest,
    generated,
    environment,
    operations,
    remote: remoteReport,
  }
}

export function renderInstanceDoctorText(report) {
  const lines = ['Mochi Bus instance doctor', '']
  lines.push(`${statusGlyph(report.manifest.status)} Manifest: ${report.manifest.path ?? '<unresolved>'}`)
  if (report.manifest.status === 'ready') {
    lines.push(`  ${report.manifest.instanceId} · ${report.manifest.profile} · ${report.manifest.enabledCities.length} cities`)
    lines.push(`  default ${report.manifest.defaultCity} · snapshots ${report.manifest.snapshotSchedule}`)
  }
  appendDetails(lines, report.manifest)

  lines.push('', 'Generated artifacts')
  for (const artifact of report.generated) {
    lines.push(`${statusGlyph(artifact.status)} ${artifact.label}: ${artifact.path}`)
    appendDetails(lines, artifact)
  }

  lines.push('', `${statusGlyph(report.environment.status)} Environment identity`)
  appendDetails(lines, report.environment)

  lines.push('', 'Operations')
  for (const operation of report.operations) {
    const mode = operation.mode ? ` (${operation.mode})` : ''
    lines.push(`${statusGlyph(operation.status)} ${operation.label}${mode}`)
    appendDetails(lines, operation)
  }

  lines.push('', `${statusGlyph(report.remote.status)} Remote Cloudflare resources${report.remote.requested ? '' : ' (use --remote)'}`)
  for (const resource of report.remote.checkedResources) {
    lines.push(`  ✓ ${resource.kind.toUpperCase()} ${resource.name}`)
  }
  appendDetails(lines, report.remote)
  lines.push('', report.ok ? 'READY' : 'BLOCKED')
  return `${lines.join('\n')}\n`
}

export function renderInstanceDoctorMarkdown(report) {
  const lines = [
    '## Mochi Bus instance doctor',
    '',
    `**Result: ${report.ok ? 'READY' : 'BLOCKED'}**`,
    '',
    '| Area | Status | Detail |',
    '| --- | --- | --- |',
  ]
  const manifestDetail = report.manifest.status === 'ready'
    ? `${report.manifest.instanceId} · ${report.manifest.profile} · ${report.manifest.enabledCities.length} cities`
    : report.manifest.blockers.join('<br>')
  lines.push(`| Manifest | ${markdownStatus(report.manifest.status)} | ${escapeTable(manifestDetail || report.manifest.path || '')} |`)
  for (const artifact of report.generated) {
    const detail = artifact.blockers.length > 0 ? artifact.blockers.join('<br>') : artifact.path
    lines.push(`| ${escapeTable(artifact.label)} | ${markdownStatus(artifact.status)} | ${escapeTable(detail)} |`)
  }
  const environmentDetail = report.environment.blockers.join('<br>') || 'Generated resource identity matches environment overrides'
  lines.push(`| Environment identity | ${markdownStatus(report.environment.status)} | ${escapeTable(environmentDetail)} |`)
  for (const operation of report.operations) {
    const details = [...operation.blockers, ...operation.warnings.map((warning) => `Warning: ${warning}`)]
    const detail = details.join('<br>') || operation.mode || 'Ready'
    lines.push(`| ${escapeTable(operation.label)} | ${markdownStatus(operation.status)} | ${escapeTable(detail)} |`)
  }
  const remoteDetail = report.remote.checkedResources.length > 0
    ? report.remote.checkedResources.map((resource) => `${resource.kind.toUpperCase()} ${resource.name}`).join('<br>')
    : report.remote.blockers.join('<br>') || 'Not requested; run with `--remote`'
  lines.push(`| Remote Cloudflare | ${markdownStatus(report.remote.status)} | ${escapeTable(remoteDetail)} |`)
  lines.push('')
  return `${lines.join('\n')}\n`
}

export async function main({ argv = process.argv.slice(2), env = process.env, cwd = process.cwd() } = {}) {
  const options = parseInstanceDoctorArguments(argv)
  const report = await diagnoseInstance({ ...options, env, cwd })
  const output = options.json
    ? `${JSON.stringify(report, null, 2)}\n`
    : renderInstanceDoctorText(report)
  process.stdout.write(output)

  if (options.githubSummary) {
    const summaryPath = typeof env.GITHUB_STEP_SUMMARY === 'string' ? env.GITHUB_STEP_SUMMARY.trim() : ''
    if (!summaryPath) throw new Error('--github-summary requires GITHUB_STEP_SUMMARY')
    await appendFile(summaryPath, renderInstanceDoctorMarkdown(report), 'utf8')
  }
  if (!report.ok) process.exitCode = 1
  return report
}

async function inspectGeneratedArtifact({ key, label, path, expected, cwd, validate = null }) {
  const result = {
    key,
    label,
    path: displayPath(cwd, path),
    status: 'blocked',
    blockers: [],
    value: null,
  }
  let source
  try {
    source = await readFile(path, 'utf8')
  } catch (error) {
    result.blockers.push(`Cannot read generated ${label.toLowerCase()}: ${errorMessage(error)}`)
    return result
  }
  let value
  try {
    value = JSON.parse(source)
  } catch (error) {
    result.blockers.push(`Invalid JSON in generated ${label.toLowerCase()}: ${errorMessage(error)}`)
    return result
  }
  try {
    value = validate ? validate(value, path) : value
  } catch (error) {
    result.blockers.push(...errorMessages(error))
    return result
  }
  if (!isDeepStrictEqual(value, expected)) {
    result.blockers.push(`Generated ${label.toLowerCase()} is stale; run npm run instance:compile`)
    return result
  }
  result.status = 'ready'
  result.value = value
  return result
}

function resolveArtifactPaths({ cwd, env, outputDirectory }) {
  if (outputDirectory) {
    const directory = absoluteFrom(cwd, outputDirectory)
    return {
      runtime: join(directory, 'instance-runtime.json'),
      wrangler: join(directory, 'wrangler.instance.jsonc'),
      operations: join(directory, 'operations-plan.json'),
    }
  }
  return {
    runtime: resolve(cwd, env.MOCHI_BUS_RUNTIME_CONFIG?.trim() || DEFAULT_RUNTIME_CONFIG_PATH),
    wrangler: resolve(cwd, env.MOCHI_BUS_WRANGLER_CONFIG?.trim() || DEFAULT_WRANGLER_CONFIG_PATH),
    operations: resolve(cwd, env.MOCHI_BUS_OPERATIONS_PLAN?.trim() || DEFAULT_OPERATIONS_PLAN_PATH),
  }
}

function operationMode(name, plan) {
  if (name === 'snapshot') return plan.snapshotSchedule
  if (name === 'deploy') return plan.checks.releaseSmoke ? 'release smoke enabled' : 'release smoke disabled'
  return null
}

function dedupeRemoteChecks(checks) {
  const result = []
  const seen = new Set()
  for (const check of checks) {
    const key = `${check.kind}:${check.name}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(check)
  }
  return result
}

function appendDetails(lines, item) {
  for (const blocker of item.blockers ?? []) lines.push(`  - ${blocker}`)
  for (const warning of item.warnings ?? []) lines.push(`  - warning: ${warning}`)
}

function errorMessages(error) {
  if (error instanceof AggregateError && Array.isArray(error.errors)) {
    return unique(error.errors.map(errorMessage))
  }
  return [errorMessage(error)]
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function unique(values) {
  return [...new Set(values.filter(Boolean))]
}

function statusGlyph(status) {
  if (status === 'ready') return '✓'
  if (status === 'disabled' || status === 'not_checked') return '–'
  return '✗'
}

function markdownStatus(status) {
  if (status === 'ready') return '✅ Ready'
  if (status === 'disabled') return '➖ Disabled'
  if (status === 'not_checked') return '➖ Not checked'
  return '❌ Blocked'
}

function escapeTable(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', '<br>')
}

function displayPath(cwd, path) {
  const displayed = relative(cwd, path)
  return displayed && !displayed.startsWith('..') ? displayed : path
}

function absoluteFrom(cwd, path) {
  return isAbsolute(path) ? path : resolve(cwd, path)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main()
  } catch (error) {
    console.error(errorMessage(error))
    process.exitCode = 1
  }
}
