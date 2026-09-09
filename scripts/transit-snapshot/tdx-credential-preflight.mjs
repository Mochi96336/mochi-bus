import { appendFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { acquireSnapshotTdxToken } from './snapshot-tdx-token.mjs'

const SAFE_FAILURES = new Set([
  'TDX token preflight requires TDX_CLIENT_ID and TDX_CLIENT_SECRET',
  'TDX token preflight returned an invalid access token',
  'TDX token preflight returned an access token with insufficient lifetime',
  'TDX token preflight retry exhausted',
  'TDX token response exceeded byte limit',
])

export async function runTdxCredentialPreflight({
  env = process.env,
  acquire = acquireSnapshotTdxToken,
  now = Date.now,
} = {}) {
  if (typeof acquire !== 'function') throw new TypeError('acquire is required')
  const tokenRecord = await acquire({ env })
  const current = safeNow(now)
  return Object.freeze({
    schemaVersion: 1,
    ok: true,
    expiresInSeconds: Math.max(0, Math.floor((tokenRecord.expiresAt - current) / 1000)),
  })
}

export function safeTdxCredentialFailure(error) {
  const message = error instanceof Error ? error.message : String(error ?? '')
  if (SAFE_FAILURES.has(message)) return message
  if (/^TDX token preflight failed \((?:timeout|network_error)\)$/.test(message)) return message
  if (/^TDX token preflight failed \(\d{3}; [a-z][a-z0-9._-]{0,63}\)$/.test(message)) return message
  return 'TDX token preflight failed (unclassified)'
}

export function renderTdxCredentialPreflightMarkdown(report) {
  if (report?.ok) {
    return [
      '## TDX credential preflight',
      '',
      '**Result: READY**',
      '',
      '- TDX accepted the configured Client ID / Client Secret pair.',
      `- Returned access-token lifetime: ${report.expiresInSeconds} seconds.`,
      '- The access token and credential values were not printed or persisted.',
      '',
    ].join('\n')
  }
  return [
    '## TDX credential preflight',
    '',
    '**Result: BLOCKED**',
    '',
    `- ${report?.failure ?? 'TDX token preflight failed (unclassified)'}`,
    '- The access token and credential values were not printed or persisted.',
    '',
  ].join('\n')
}

export function renderTdxCredentialPreflightText(report) {
  if (report?.ok) {
    return [
      'TDX credential preflight: READY',
      `Access-token lifetime: ${report.expiresInSeconds} seconds`,
      'No token or credential value was printed or persisted.',
      '',
    ].join('\n')
  }
  return [
    'TDX credential preflight: BLOCKED',
    report?.failure ?? 'TDX token preflight failed (unclassified)',
    'No token or credential value was printed or persisted.',
    '',
  ].join('\n')
}

async function main() {
  let report
  let exitCode = 0
  try {
    report = await runTdxCredentialPreflight()
  } catch (error) {
    report = Object.freeze({
      schemaVersion: 1,
      ok: false,
      failure: safeTdxCredentialFailure(error),
    })
    exitCode = 1
  }

  const text = renderTdxCredentialPreflightText(report)
  if (report.ok) process.stdout.write(text)
  else process.stderr.write(text)

  const summaryPath = nonEmpty(process.env.GITHUB_STEP_SUMMARY)
  if (summaryPath) {
    await appendFile(summaryPath, renderTdxCredentialPreflightMarkdown(report), 'utf8')
  }
  process.exitCode = exitCode
}

function safeNow(now) {
  try {
    const value = typeof now === 'function' ? now() : now
    return Number.isFinite(value) ? value : Date.now()
  } catch {
    return Date.now()
  }
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

const directEntry = process.argv[1]
  ? pathToFileURL(process.argv[1]).href === import.meta.url
  : false
if (directEntry) await main()
