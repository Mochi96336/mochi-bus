import { createHash } from 'node:crypto'
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { parseWranglerD1ImportJson, segmentPublisherD1Sql } from './d1-write-telemetry.mjs'

const TELEMETRY_ENABLED = process.env.SNAPSHOT_D1_WRITE_TELEMETRY === '1'
const CAPTURE_MAX_BYTES = 32 * 1024 * 1024
const TDX_TOKEN_ENDPOINT = 'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token'

if (TELEMETRY_ENABLED) {
  installSnapshotD1WriteTelemetry()
  installTdxTokenDiagnostic()
}

export function installSnapshotD1WriteTelemetry() {
  const require = createRequire(import.meta.url)
  const childProcess = require('node:child_process')
  if (childProcess.spawnSync?.__snapshotD1WriteTelemetry === true) return
  const telemetrySpawnSync = createSnapshotD1TelemetrySpawnSync({
    originalSpawnSync: childProcess.spawnSync,
    env: process.env,
    execPath: process.execPath,
    stdout: process.stdout,
    stderr: process.stderr,
  })
  Object.defineProperty(telemetrySpawnSync, '__snapshotD1WriteTelemetry', { value: true })
  childProcess.spawnSync = telemetrySpawnSync
  syncBuiltinESMExports()
}

export function installTdxTokenDiagnostic() {
  const currentFetch = globalThis.fetch
  if (typeof currentFetch !== 'function' || currentFetch.__snapshotTdxTokenDiagnostic === true) return
  const diagnosticFetch = createTdxTokenDiagnosticFetch({
    originalFetch: currentFetch,
    env: process.env,
    stdout: process.stdout,
  })
  Object.defineProperty(diagnosticFetch, '__snapshotTdxTokenDiagnostic', { value: true })
  globalThis.fetch = diagnosticFetch
}

export function createTdxTokenDiagnosticFetch({
  originalFetch,
  env = {},
  stdout = process.stdout,
} = {}) {
  if (typeof originalFetch !== 'function') throw new TypeError('originalFetch is required')
  const telemetryFile = env.SNAPSHOT_D1_WRITE_TELEMETRY_FILE
    ?? '.transit-snapshot/d1-write-telemetry.jsonl'

  return async function tdxTokenDiagnosticFetch(input, init) {
    const response = await originalFetch(input, init)
    if (!isTdxTokenRequest(input, init) || response?.ok === true) return response

    let oauthError = 'unavailable'
    try {
      const payload = await response.clone().json()
      oauthError = boundedOAuthErrorCode(payload?.error)
    } catch {
      // Keep the publisher response untouched and report only a bounded classification.
    }

    try {
      const record = {
        schemaVersion: 1,
        event: 'snapshot_d1_write_telemetry',
        action: 'tdx_token_error',
        phase: 'source_fetch',
        city: env.SNAPSHOT_D1_WRITE_TELEMETRY_CITY ?? null,
        workflowRunId: env.GITHUB_RUN_ID ?? null,
        workflowRunAttempt: env.GITHUB_RUN_ATTEMPT ?? null,
        recordedAt: new Date().toISOString(),
        httpStatus: Number.isInteger(response?.status) ? response.status : null,
        oauthError,
      }
      mkdirSync(dirname(telemetryFile), { recursive: true })
      appendFileSync(telemetryFile, `${JSON.stringify(record)}\n`, { mode: 0o600 })
      stdout?.write?.(`${JSON.stringify(record)}\n`)
    } catch {
      // Diagnostics must never change the publisher's request/response semantics.
    }
    return response
  }
}

export function createSnapshotD1TelemetrySpawnSync({
  originalSpawnSync,
  env = {},
  execPath = process.execPath,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  if (typeof originalSpawnSync !== 'function') throw new TypeError('originalSpawnSync is required')
  const telemetryFile = env.SNAPSHOT_D1_WRITE_TELEMETRY_FILE
    ?? '.transit-snapshot/d1-write-telemetry.jsonl'
  const fileStates = new Map()

  return function telemetrySpawnSync(command, args = [], options = {}) {
    if (!isRemoteWranglerD1FileExecute(command, args, execPath)) {
      return originalSpawnSync(command, args, options)
    }
    const file = d1FileArgument(args)
    if (!file || !isPublisherD1File(file)) return originalSpawnSync(command, args, options)

    const source = readFileSync(file, 'utf8')
    const segments = segmentPublisherD1Sql(source)
    if (segments.length === 0) return originalSpawnSync(command, args, options)
    if (segments.some((segment) => segment.table === 'unattributed')) {
      throw new Error(`Snapshot D1 write telemetry cannot attribute ${file}`)
    }

    const sourceHash = createHash('sha256').update(source).digest('hex')
    const stateKey = `${resolve(file)}\0${sourceHash}`
    const state = fileStates.get(stateKey) ?? { attempt: 0, completed: new Map() }
    state.attempt += 1
    fileStates.set(stateKey, state)

    const temporaryRoot = mkdtempSync(join(tmpdir(), 'mochi-d1-write-telemetry-'))
    let lastSuccess = null
    try {
      for (let index = 0; index < segments.length; index += 1) {
        const segment = segments[index]
        const committed = state.completed.get(index)
        if (committed) {
          appendTelemetry({
            action: 'reuse_committed_segment',
            sourceFile: file,
            sourceHash,
            phase: publisherD1Phase(file),
            table: segment.table,
            segmentIndex: index,
            sourceAttempt: state.attempt,
            statementCount: segment.statements.length,
            writeStatementCount: segment.writeStatementCount,
            ...committed,
          })
          continue
        }

        const segmentFile = join(
          temporaryRoot,
          `${basename(file)}.${String(index).padStart(2, '0')}.${segment.table}.sql`,
        )
        writeFileSync(segmentFile, segment.sql, { mode: 0o600 })
        const segmentArgs = withD1File(withJson(args), segmentFile)
        const result = originalSpawnSync(command, segmentArgs, captureOptions(options))
        forwardStderr(result?.stderr)
        if (result?.status !== 0) {
          appendTelemetry({
            action: 'segment_failed',
            sourceFile: file,
            sourceHash,
            phase: publisherD1Phase(file),
            table: segment.table,
            segmentIndex: index,
            sourceAttempt: state.attempt,
            statementCount: segment.statements.length,
            writeStatementCount: segment.writeStatementCount,
            exitStatus: result?.status ?? null,
          })
          return result
        }

        let metrics
        try {
          metrics = parseWranglerD1ImportJson(result.stdout)
        } catch (error) {
          throw new Error(
            `Snapshot D1 write telemetry could not parse committed ${segment.table} import: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
        state.completed.set(index, metrics)
        appendTelemetry({
          action: 'segment_committed',
          sourceFile: file,
          sourceHash,
          phase: publisherD1Phase(file),
          table: segment.table,
          segmentIndex: index,
          sourceAttempt: state.attempt,
          statementCount: segment.statements.length,
          writeStatementCount: segment.writeStatementCount,
          ...metrics,
        })
        lastSuccess = result
      }
      return lastSuccess ?? syntheticSuccess()
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true })
    }
  }

  function appendTelemetry(event) {
    mkdirSync(dirname(telemetryFile), { recursive: true })
    const record = {
      schemaVersion: 1,
      event: 'snapshot_d1_write_telemetry',
      city: env.SNAPSHOT_D1_WRITE_TELEMETRY_CITY ?? null,
      workflowRunId: env.GITHUB_RUN_ID ?? null,
      workflowRunAttempt: env.GITHUB_RUN_ATTEMPT ?? null,
      recordedAt: new Date().toISOString(),
      ...event,
    }
    appendFileSync(telemetryFile, `${JSON.stringify(record)}\n`, { mode: 0o600 })
    stdout?.write?.(`${JSON.stringify(record)}\n`)
  }

  function forwardStderr(value) {
    if (value === undefined || value === null || value === '') return
    stderr?.write?.(Buffer.isBuffer(value) ? value : String(value))
  }
}

function isTdxTokenRequest(input, init) {
  const method = String(init?.method ?? input?.method ?? 'GET').toUpperCase()
  return method === 'POST' && requestUrl(input) === TDX_TOKEN_ENDPOINT
}

function requestUrl(input) {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return typeof input?.url === 'string' ? input.url : ''
}

function boundedOAuthErrorCode(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  return /^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(text) ? text.toLowerCase() : 'unclassified'
}

function isRemoteWranglerD1FileExecute(command, args, execPath) {
  if (command !== execPath || !Array.isArray(args)) return false
  const script = String(args[0] ?? '').replaceAll('\\', '/')
  return script.endsWith('node_modules/wrangler/bin/wrangler.js')
    && args[1] === 'd1'
    && args[2] === 'execute'
    && args.includes('--remote')
    && d1FileArgument(args) !== null
}

function d1FileArgument(args) {
  const index = args.indexOf('--file')
  if (index >= 0) return typeof args[index + 1] === 'string' ? args[index + 1] : null
  const inline = args.find((arg) => typeof arg === 'string' && arg.startsWith('--file='))
  return inline ? inline.slice('--file='.length) : null
}

function withD1File(args, file) {
  const next = [...args]
  const index = next.indexOf('--file')
  if (index >= 0) {
    next[index + 1] = file
    return next
  }
  const inlineIndex = next.findIndex((arg) => typeof arg === 'string' && arg.startsWith('--file='))
  if (inlineIndex >= 0) next[inlineIndex] = `--file=${file}`
  return next
}

function withJson(args) {
  return args.includes('--json') ? [...args] : [...args, '--json']
}

function isPublisherD1File(file) {
  const normalized = String(file).replaceAll('\\', '/')
  return /(?:^|\/)\.transit-snapshot\/[^/]+\/(?:import-\d+\.sql|cleanup\.sql)$/.test(normalized)
}

function publisherD1Phase(file) {
  return basename(file) === 'cleanup.sql' ? 'cleanup' : 'stage'
}

function captureOptions(options) {
  const next = { ...(options ?? {}) }
  delete next.stdio
  next.encoding = 'utf8'
  const requested = Number(next.maxBuffer)
  next.maxBuffer = Number.isSafeInteger(requested) && requested > CAPTURE_MAX_BYTES
    ? requested
    : CAPTURE_MAX_BYTES
  return next
}

function syntheticSuccess() {
  return Object.freeze({
    pid: 0,
    output: [null, '', ''],
    stdout: '',
    stderr: '',
    status: 0,
    signal: null,
    error: undefined,
  })
}
