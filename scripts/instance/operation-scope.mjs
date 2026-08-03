import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { loadOperationsPlan } from './operations-plan.mjs'
import { loadOperationalResources } from './operational-resources.mjs'

const OPERATIONS = new Set(['snapshot', 'releaseSmoke', 'publicProbe', 'windowWatchdog'])

export function resolveOperationScope(
  operation,
  plan = loadOperationsPlan(),
  resources = loadOperationalResources(),
) {
  if (!OPERATIONS.has(operation)) throw new Error(`Unsupported instance operation: ${operation || '<empty>'}`)
  const enabled = operation === 'snapshot'
    ? plan.snapshotSchedule !== 'manual'
    : plan.checks[operation]

  return Object.freeze({
    operation,
    enabled,
    snapshotSchedule: plan.snapshotSchedule,
    profile: plan.profile,
    ...resources,
  })
}

export function writeOperationScope(scope, env = process.env, appendFile = appendFileSync) {
  const lines = [
    `enabled=${scope.enabled}`,
    `snapshot_schedule=${scope.snapshotSchedule}`,
    `profile=${scope.profile}`,
    `worker_name=${scope.workerName}`,
    `d1_database_name=${scope.d1DatabaseName}`,
    `d1_database_id=${scope.d1DatabaseId ?? ''}`,
    `r2_bucket_name=${scope.r2BucketName}`,
    `public_origin=${scope.publicOrigin ?? ''}`,
  ]
  if (env.GITHUB_OUTPUT) appendFile(env.GITHUB_OUTPUT, `${lines.join('\n')}\n`)
  console.log(JSON.stringify({ message: 'instance_operation_scope', ...scope }))
}

export function main({ argv = process.argv.slice(2), env = process.env } = {}) {
  const scope = resolveOperationScope(argv[0])
  writeOperationScope(scope, env)
  return scope
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
