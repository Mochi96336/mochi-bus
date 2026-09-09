import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

export const TDX_CALLS_PER_POINT = 1_500
export const TDX_BYTES_PER_POINT = 150_000_000

const SNAPSHOT_PERSISTENT_EVENTS = new Set([
  'tdx_city_persistent_cache',
  'tdx_intercity_persistent_cache',
])
const SNAPSHOT_FETCH_EVENTS = new Set([
  'tdx_city_cache',
  'tdx_intercity_cache',
])
const RUNTIME_RESULTS = new Set([
  'success',
  'http_error',
  'transport_error',
  'payload_error',
])
const RUNTIME_CREDENTIAL_SCOPES = new Set(['shared', 'byok'])
const SNAPSHOT_PROBE_RESULTS = new Set(['success', 'http_error', 'transport_error'])

export function parseTdxUsageText(text) {
  const events = []
  let nonEmptyLines = 0
  let parsedLines = 0
  let malformedLines = 0
  let unrelatedRecords = 0

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    nonEmptyLines += 1
    const parsed = parseLogLine(line)
    if (parsed === null) {
      malformedLines += 1
      continue
    }
    parsedLines += 1
    const event = unwrapUsageEvent(parsed)
    if (event) events.push(event)
    else unrelatedRecords += 1
  }

  return Object.freeze({
    events,
    input: Object.freeze({ nonEmptyLines, parsedLines, malformedLines, unrelatedRecords }),
  })
}

export function summarizeTdxUsage(events, input = {}) {
  const groups = new Map()
  const scopes = new Map([
    ['shared', blankCounters()],
    ['byok', blankCounters()],
  ])
  const total = blankCounters()

  for (const event of events) {
    const observation = usageObservation(event)
    if (!observation) continue
    addObservation(total, observation)
    addObservation(scopes.get(observation.billingScope), observation)
    const key = groupKey(observation)
    const current = groups.get(key) ?? {
      billingScope: observation.billingScope,
      plane: observation.plane,
      operation: observation.operation,
      resource: observation.resource,
      scope: observation.scope,
      counters: blankCounters(),
    }
    addObservation(current.counters, observation)
    groups.set(key, current)
  }

  return Object.freeze({
    schemaVersion: 1,
    rates: Object.freeze({
      callsPerPoint: TDX_CALLS_PER_POINT,
      bytesPerPoint: TDX_BYTES_PER_POINT,
      megabytesPerPoint: 150,
      megabyteBase: 1_000_000,
    }),
    input: Object.freeze({
      recognizedEvents: events.length,
      nonEmptyLines: numberOrZero(input.nonEmptyLines),
      parsedLines: numberOrZero(input.parsedLines),
      malformedLines: numberOrZero(input.malformedLines),
      unrelatedRecords: numberOrZero(input.unrelatedRecords),
    }),
    scopes: Object.freeze({
      shared: finalizeCounters(scopes.get('shared')),
      byok: finalizeCounters(scopes.get('byok')),
      all: finalizeCounters(total),
    }),
    groups: Object.freeze([...groups.values()]
      .map((group) => Object.freeze({
        billingScope: group.billingScope,
        plane: group.plane,
        operation: group.operation,
        resource: group.resource,
        scope: group.scope,
        ...finalizeCounters(group.counters),
      }))
      .sort(compareGroups)),
  })
}

export function formatTdxUsageSummary(summary) {
  const lines = [
    'TDX upstream usage summary',
    `Reference rates: ${summary.rates.callsPerPoint} HTTP responses/point; ${summary.rates.megabytesPerPoint} MB/point (decimal MB).`,
    'Point values below are estimates from observed logs; TDX settlement and rounding remain authoritative.',
    '',
    'scope\tattempts\thttp_responses\tsuccess_responses\texact_MB\tunknown_byte_responses\tdeclared_only_MB\tcall_points\texact_volume_points\tcombined_known_estimate',
  ]

  for (const [label, counters] of [
    ['shared', summary.scopes.shared],
    ['byok', summary.scopes.byok],
    ['all', summary.scopes.all],
  ]) {
    lines.push(formatCounterRow(label, counters))
  }

  if (summary.groups.length) {
    lines.push('', 'breakdown')
    lines.push('billing_scope\tplane\toperation\tresource\tscope\thttp_responses\texact_MB\tcall_points\texact_volume_points\tcombined_known_estimate')
    for (const group of summary.groups) {
      lines.push([
        group.billingScope,
        group.plane,
        group.operation,
        group.resource,
        group.scope,
        group.httpResponses,
        decimalMegabytes(group.exactReceivedBytes),
        fixed(group.responseCallPoints),
        fixed(group.exactVolumePoints),
        fixed(group.combinedKnownEstimate),
      ].join('\t'))
    }
  }

  lines.push('', [
    `recognized_events=${summary.input.recognizedEvents}`,
    `malformed_lines=${summary.input.malformedLines}`,
    `unrelated_records=${summary.input.unrelatedRecords}`,
  ].join(' '))

  return `${lines.join('\n')}\n`
}

function usageObservation(event) {
  if (!event || typeof event !== 'object') return null

  if (event.message === 'tdx_upstream_usage') {
    const operation = safeLabel(event.operation, null)
    const resource = safeLabel(event.resource, null)
    const scope = safeLabel(event.scope, null)
    const attempt = positiveInteger(event.attempt)
    if (!operation || !resource || !scope || attempt === null
      || !RUNTIME_CREDENTIAL_SCOPES.has(event.credentialScope)
      || !RUNTIME_RESULTS.has(event.result)) return null

    const exactBytes = nonNegativeInteger(event.receivedBytes)
    const declaredBytes = exactBytes === null ? nonNegativeInteger(event.declaredBytes) : null
    const status = httpStatus(event.status)
    if (event.result === 'success' && (status === null || exactBytes === null)) return null
    if (event.result === 'http_error' && status === null) return null
    if (event.result === 'transport_error' && status !== null) return null

    return {
      billingScope: event.credentialScope,
      plane: 'runtime',
      operation,
      resource,
      scope,
      status,
      success: event.result === 'success',
      exactBytes,
      declaredBytes,
    }
  }

  if (SNAPSHOT_PERSISTENT_EVENTS.has(event.event) && event.resolution === 'probe') {
    const resource = safeLabel(event.resource, null)
    if (!resource || !SNAPSHOT_PROBE_RESULTS.has(event.result)) return null
    const status = httpStatus(event.status)
    const exactBytes = nonNegativeInteger(event.bytes)
    if (event.result === 'success' && (status === null || exactBytes === null)) return null
    if (event.result === 'http_error' && status === null) return null
    if (event.result === 'transport_error' && status !== null) return null

    return {
      billingScope: 'shared',
      plane: 'snapshot',
      operation: 'source_probe',
      resource,
      scope: event.event === 'tdx_intercity_persistent_cache' ? 'InterCity' : 'City/*',
      status,
      success: event.result === 'success',
      exactBytes,
      declaredBytes: null,
    }
  }

  if (SNAPSHOT_FETCH_EVENTS.has(event.event)
    && (event.resolution === 'miss' || event.resolution === 'upstream-error')) {
    const resource = safeLabel(event.resource, null)
    const city = event.event === 'tdx_city_cache' ? safeLabel(event.city, null) : null
    if (!resource || (event.event === 'tdx_city_cache' && !city)) return null

    const status = httpStatus(event.status)
    if (event.resolution === 'miss') {
      const exactBytes = nonNegativeInteger(event.bytes)
      if (status === null || status < 200 || status >= 300 || exactBytes === null) return null
      return {
        billingScope: 'shared',
        plane: 'snapshot',
        operation: 'full_source',
        resource,
        scope: event.event === 'tdx_intercity_cache' ? 'InterCity' : `City/${city}`,
        status,
        success: true,
        exactBytes,
        declaredBytes: null,
      }
    }

    return {
      billingScope: 'shared',
      plane: 'snapshot',
      operation: 'full_source',
      resource,
      scope: event.event === 'tdx_intercity_cache' ? 'InterCity' : `City/${city}`,
      status,
      success: false,
      exactBytes: null,
      declaredBytes: nonNegativeInteger(event.bytes),
    }
  }

  return null
}

function addObservation(counters, observation) {
  counters.attempts += 1
  if (observation.status !== null) {
    counters.httpResponses += 1
    if (observation.success) counters.successResponses += 1
    if (observation.exactBytes === null) counters.unknownByteResponses += 1
  }
  if (observation.exactBytes !== null) counters.exactReceivedBytes += observation.exactBytes
  if (observation.declaredBytes !== null) counters.declaredOnlyBytes += observation.declaredBytes
}

function blankCounters() {
  return {
    attempts: 0,
    httpResponses: 0,
    successResponses: 0,
    exactReceivedBytes: 0,
    unknownByteResponses: 0,
    declaredOnlyBytes: 0,
  }
}

function finalizeCounters(counters) {
  const responseCallPoints = counters.httpResponses / TDX_CALLS_PER_POINT
  const exactVolumePoints = counters.exactReceivedBytes / TDX_BYTES_PER_POINT
  const declaredAdjustedVolumePoints = (counters.exactReceivedBytes + counters.declaredOnlyBytes) / TDX_BYTES_PER_POINT
  return Object.freeze({
    ...counters,
    responseCallPoints,
    exactVolumePoints,
    declaredAdjustedVolumePoints,
    combinedKnownEstimate: responseCallPoints + exactVolumePoints,
    combinedDeclaredEstimate: responseCallPoints + declaredAdjustedVolumePoints,
  })
}

function formatCounterRow(label, counters) {
  return [
    label,
    counters.attempts,
    counters.httpResponses,
    counters.successResponses,
    decimalMegabytes(counters.exactReceivedBytes),
    counters.unknownByteResponses,
    decimalMegabytes(counters.declaredOnlyBytes),
    fixed(counters.responseCallPoints),
    fixed(counters.exactVolumePoints),
    fixed(counters.combinedKnownEstimate),
  ].join('\t')
}

function parseLogLine(line) {
  try {
    return JSON.parse(line)
  } catch {}

  const start = line.indexOf('{')
  if (start < 0) return null
  try {
    return JSON.parse(line.slice(start))
  } catch {
    return null
  }
}

function unwrapUsageEvent(value) {
  if (usageObservation(value)) return value
  if (typeof value === 'string') {
    const nested = value.trim()
    if (nested.startsWith('{')) {
      const parsed = parseLogLine(nested)
      if (parsed && typeof parsed !== 'string' && usageObservation(parsed)) return parsed
    }
    return null
  }
  if (!value || typeof value !== 'object') return null

  for (const key of ['log', 'Log', 'messageText', 'Message', 'message']) {
    const nested = value[key]
    const candidates = Array.isArray(nested) ? nested : [nested]
    for (const candidate of candidates) {
      if (typeof candidate !== 'string') continue
      const text = candidate.trim()
      if (!text.startsWith('{')) continue
      const parsed = parseLogLine(text)
      if (parsed && usageObservation(parsed)) return parsed
    }
  }
  return null
}

function groupKey(observation) {
  return [
    observation.billingScope,
    observation.plane,
    observation.operation,
    observation.resource,
    observation.scope,
  ].join('\0')
}

function compareGroups(left, right) {
  return left.billingScope.localeCompare(right.billingScope)
    || left.plane.localeCompare(right.plane)
    || left.operation.localeCompare(right.operation)
    || left.resource.localeCompare(right.resource)
    || left.scope.localeCompare(right.scope)
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

function httpStatus(value) {
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : null
}

function safeLabel(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function numberOrZero(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function decimalMegabytes(bytes) {
  return (bytes / 1_000_000).toFixed(6)
}

function fixed(value) {
  return value.toFixed(6)
}

async function readInputs(paths) {
  const chunks = []
  for (const path of paths) {
    if (path === '-') {
      chunks.push(await readStdin())
    } else {
      chunks.push(await readFile(path, 'utf8'))
    }
  }
  return chunks.join('\n')
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

async function main(argv) {
  const json = argv.includes('--json')
  const paths = argv.filter((arg) => arg !== '--json')
  if (!paths.length) {
    console.error('Usage: node scripts/tdx-usage-summary.mjs [--json] <log-file|-> [...]')
    process.exitCode = 2
    return
  }

  const parsed = parseTdxUsageText(await readInputs(paths))
  const summary = summarizeTdxUsage(parsed.events, parsed.input)
  process.stdout.write(json ? `${JSON.stringify(summary, null, 2)}\n` : formatTdxUsageSummary(summary))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2))
}
