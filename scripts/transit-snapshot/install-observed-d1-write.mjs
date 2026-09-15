import { createRequire, syncBuiltinESMExports } from 'node:module'
import { resolve } from 'node:path'
import { executePublisherD1File } from './observed-d1-write.mjs'

if (process.env.SNAPSHOT_D1_OBSERVED_WRITE === '1') installObservedD1Write()

export function installObservedD1Write({ env = process.env } = {}) {
  const require = createRequire(import.meta.url)
  const childProcess = require('node:child_process')
  if (childProcess.spawnSync?.__snapshotObservedD1Write === true) return
  const originalSpawnSync = childProcess.spawnSync

  function observedSpawnSync(command, args = [], options = {}) {
    if (!isPublisherRemoteD1FileExecute(command, args)) {
      return originalSpawnSync(command, args, options)
    }
    return executePublisherD1File({
      spawnSyncImpl: originalSpawnSync,
      execPath: command,
      database: args[3],
      file: d1FileArgument(args),
      env,
      stdout: process.stdout,
      stderr: process.stderr,
    })
  }
  Object.defineProperty(observedSpawnSync, '__snapshotObservedD1Write', { value: true })
  childProcess.spawnSync = observedSpawnSync
  syncBuiltinESMExports()
}

export function isPublisherRemoteD1FileExecute(command, args) {
  if (command !== process.execPath || !Array.isArray(args)) return false
  const script = String(args[0] ?? '').replaceAll('\\', '/')
  if (!script.endsWith('node_modules/wrangler/bin/wrangler.js')
    || args[1] !== 'd1'
    || args[2] !== 'execute'
    || !args.includes('--remote')) return false
  const file = d1FileArgument(args)
  if (!file) return false
  const normalized = resolve(file).replaceAll('\\', '/')
  return /(?:^|\/)\.transit-snapshot\/[^/]+\/(?:import-\d+\.sql|cleanup\.sql)$/.test(normalized)
}

function d1FileArgument(args) {
  const index = args.indexOf('--file')
  if (index >= 0) return typeof args[index + 1] === 'string' ? args[index + 1] : null
  const inline = args.find((arg) => typeof arg === 'string' && arg.startsWith('--file='))
  return inline ? inline.slice('--file='.length) : null
}
