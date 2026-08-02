import { constants } from 'node:fs'
import { appendFile, open } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  MAX_INSTANCE_BUNDLE_BYTES,
  parseStrictJson,
  verifyInstanceBundleArtifact,
} from './bundle-integrity.mjs'

const SHA256_PATTERN = /^[a-f0-9]{64}$/

export function parseInstanceBundleVerificationArguments(argv = process.argv.slice(2)) {
  const options = {
    inputPath: null,
    expectedBundleHash: null,
    expectedArtifactHash: null,
    json: false,
    githubSummary: false,
    help: false,
  }
  const positional = []

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--json' || argument === '--github-summary' || argument === '--help') {
      if (argument === '--json') options.json = true
      else if (argument === '--github-summary') options.githubSummary = true
      else options.help = true
      continue
    }

    const equalsIndex = argument.indexOf('=')
    const optionName = equalsIndex >= 0 ? argument.slice(0, equalsIndex) : argument
    let value = equalsIndex >= 0 ? argument.slice(equalsIndex + 1) : null
    if (!optionName.startsWith('--')) {
      positional.push(argument)
      continue
    }
    if (!['--input', '--expect-hash', '--expect-artifact-hash'].includes(optionName)) {
      throw new Error(`Unknown bundle verification option: ${optionName}`)
    }
    if (value === null) {
      value = argv[index + 1]
      if (!value || value.startsWith('--')) throw new Error(`Missing value after ${optionName}`)
      index += 1
    }
    if (!value) throw new Error(`Missing value after ${optionName}=`)
    if (optionName === '--input') options.inputPath = value
    else if (optionName === '--expect-hash') options.expectedBundleHash = normalizeHash(value, '--expect-hash')
    else options.expectedArtifactHash = normalizeHash(value, '--expect-artifact-hash')
  }

  if (!options.inputPath && positional.length > 0) options.inputPath = positional.shift()
  if (positional.length > 0) throw new Error(`Unexpected argument: ${positional[0]}`)
  if (!options.help && !options.inputPath) throw new Error('instance:verify-bundle requires --input <artifact.json> or one positional path')
  return Object.freeze(options)
}

export async function readInstanceBundleArtifact(inputPath, {
  cwd = process.cwd(),
  maxBytes = MAX_INSTANCE_BUNDLE_BYTES,
} = {}) {
  const resolvedPath = resolve(cwd, inputPath)
  let handle
  try {
    const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
    handle = await open(resolvedPath, constants.O_RDONLY | noFollow)
    const stat = await handle.stat()
    if (!stat.isFile()) throw new Error('Bundle artifact input must be a regular file')
    if (stat.size === 0) throw new Error('Bundle artifact input is empty')
    if (stat.size > maxBytes) {
      throw new Error(`Bundle artifact exceeds the ${maxBytes}-byte read limit`)
    }
    const source = await handle.readFile('utf8')
    if (Buffer.byteLength(source, 'utf8') !== stat.size) {
      throw new Error('Bundle artifact changed while it was being read')
    }
    return Object.freeze({
      path: resolvedPath,
      displayPath: displayPath(cwd, resolvedPath),
      source,
      artifact: parseStrictJson(source),
    })
  } finally {
    await handle?.close()
  }
}

export async function verifyInstanceBundleFile(options, {
  cwd = process.cwd(),
} = {}) {
  const input = await readInstanceBundleArtifact(options.inputPath, { cwd })
  const integrity = verifyInstanceBundleArtifact(input.artifact)
  const errors = [...integrity.errors]
  const checks = [...integrity.checks]
  addExpectedCheck(
    checks,
    errors,
    'expected-bundle-hash',
    options.expectedBundleHash,
    integrity.bundleHash,
  )
  addExpectedCheck(
    checks,
    errors,
    'expected-artifact-hash',
    options.expectedArtifactHash,
    integrity.artifactHash,
  )
  return deepFreeze({
    schemaVersion: 1,
    ok: errors.length === 0,
    path: input.displayPath,
    kind: input.artifact?.kind ?? null,
    instanceId: input.artifact?.bundle?.instance?.id ?? null,
    bundleHash: integrity.bundleHash,
    artifactHash: integrity.artifactHash,
    expectedBundleHash: options.expectedBundleHash,
    expectedArtifactHash: options.expectedArtifactHash,
    summary: {
      passed: checks.filter((item) => item.ok).length,
      failed: checks.filter((item) => !item.ok).length,
      total: checks.length,
    },
    checks,
    errors,
  })
}

export function renderInstanceBundleVerificationText(report) {
  const lines = [
    `Mochi Bus change-bundle artifact: ${report.ok ? 'VERIFIED' : 'INVALID'}`,
    `Path: ${report.path}`,
    `Instance: ${report.instanceId ?? 'unknown'}`,
    `Bundle SHA-256: ${report.bundleHash ?? 'unavailable'}`,
    `Artifact SHA-256: ${report.artifactHash ?? 'unavailable'}`,
    `Checks: ${report.summary.passed}/${report.summary.total} passed`,
  ]
  if (!report.ok) {
    lines.push('', 'Failures:')
    for (const error of report.errors) lines.push(`x ${error}`)
  }
  lines.push('', 'NO FILES WERE CHANGED')
  return `${lines.join('\n')}\n`
}

export function renderInstanceBundleVerificationMarkdown(report) {
  const lines = [
    '## Mochi Bus change-bundle artifact verification',
    '',
    `**${report.ok ? 'VERIFIED' : 'INVALID'} · ${report.instanceId ?? 'unknown instance'}**`,
    '',
    `- Path: \`${escapeInline(report.path)}\``,
    `- Bundle SHA-256: \`${report.bundleHash ?? 'unavailable'}\``,
    `- Artifact SHA-256: \`${report.artifactHash ?? 'unavailable'}\``,
    `- Checks: ${report.summary.passed}/${report.summary.total} passed`,
  ]
  if (!report.ok) {
    lines.push('', '### Failures', '')
    for (const error of report.errors) lines.push(`- ${escapeMarkdown(error)}`)
  }
  lines.push('', '> Offline verification only. No manifest, generated artifact or remote resource was changed.', '')
  return `${lines.join('\n')}\n`
}

export function instanceBundleVerificationUsage() {
  return `Verify a saved Mochi Bus instance change-bundle artifact entirely offline.\n\nUsage:\n  npm run instance:verify-bundle -- --input <artifact.json>\n  npm run instance:verify-bundle -- <artifact.json> --expect-hash <sha256> --expect-artifact-hash <sha256>\n\nOptions:\n  --input <path>                  Artifact to verify\n  --expect-hash <sha256>          Require the reviewed bundle SHA-256\n  --expect-artifact-hash <sha256> Require the exact self-contained artifact SHA-256\n  --json                          Print the complete verification report\n  --github-summary                Append the report to GITHUB_STEP_SUMMARY\n  --help                          Show this help\n\nThe verifier reads at most ${MAX_INSTANCE_BUNDLE_BYTES} bytes, rejects duplicate JSON object keys, performs no network requests and changes no files except an explicitly requested GitHub job summary.\n`
}

export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  cwd = process.cwd(),
  stdout = process.stdout,
} = {}) {
  const options = parseInstanceBundleVerificationArguments(argv)
  if (options.help) {
    stdout.write(instanceBundleVerificationUsage())
    return null
  }

  const report = await verifyInstanceBundleFile(options, { cwd })
  stdout.write(options.json
    ? `${JSON.stringify(report, null, 2)}\n`
    : renderInstanceBundleVerificationText(report))

  if (options.githubSummary) {
    const summaryPath = typeof env.GITHUB_STEP_SUMMARY === 'string' ? env.GITHUB_STEP_SUMMARY.trim() : ''
    if (!summaryPath) throw new Error('--github-summary requires GITHUB_STEP_SUMMARY')
    await appendFile(summaryPath, renderInstanceBundleVerificationMarkdown(report), 'utf8')
  }
  if (!report.ok) {
    const error = new Error(`Change-bundle artifact verification failed with ${report.summary.failed} failed checks`)
    error.reported = true
    throw error
  }
  return report
}

function addExpectedCheck(checks, errors, id, expected, actual) {
  if (!expected) return
  const ok = expected === actual
  const detail = ok
    ? `matched ${expected}`
    : `expected ${expected}, received ${actual ?? 'unavailable'}`
  checks.push({ id, ok, detail })
  if (!ok) errors.push(`${id}: ${detail}`)
}

function normalizeHash(value, optionName) {
  const normalized = String(value).trim().toLowerCase()
  if (!SHA256_PATTERN.test(normalized)) {
    throw new Error(`${optionName} must be a 64-character SHA-256 hex digest`)
  }
  return normalized
}

function displayPath(cwd, path) {
  const shown = relative(resolve(cwd), path).split(sep).join('/')
  return shown && !shown.startsWith('../') ? shown : path.split(sep).join('/')
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
    if (!error?.reported) process.stderr.write(`${errorMessage(error)}\n`)
    process.exitCode = 1
  })
}
