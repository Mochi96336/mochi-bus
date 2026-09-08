import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AwsClient } from 'aws4fetch'
import { loadOperationalResources } from '../instance/operational-resources.mjs'
import { queryD1 } from './window-d1.mjs'

export const RESOURCE_MEASUREMENT_CITIES = Object.freeze(['Taipei', 'NewTaipei', 'Taichung'])
export const RESOURCE_MEASUREMENT_KINDS = Object.freeze(['direct', 'transfer'])
export const RESOURCE_MEASUREMENT_REQUESTS = 3

const SHA256 = /^[a-f0-9]{64}$/
const SAFE_WORKER_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/
const DEFAULT_ANALYTICS_POLL_ATTEMPTS = 24
const DEFAULT_ANALYTICS_POLL_MS = 10_000
const GRAPHQL_ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql'

const WORKER_ANALYTICS_QUERY = `
query WorkerResourceMeasurement(
  $accountTag: string
  $datetimeStart: string
  $datetimeEnd: string
  $scriptName: string
) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      workersInvocationsAdaptive(
        limit: 100
        filter: {
          scriptName: $scriptName
          datetime_geq: $datetimeStart
          datetime_leq: $datetimeEnd
        }
      ) {
        dimensions {
          scriptName
          status
        }
        quantiles {
          memoryUsageBytesP50
          memoryUsageBytesP90
          memoryUsageBytesP99
          memoryUsageBytesP999
        }
        sum {
          errors
          requests
          subrequests
        }
      }
    }
  }
}
`

export function parsePlaceRoutingExportManifest(value, city, version) {
  if (!value || typeof value !== 'object'
    || value.schemaVersion !== 1
    || value.kind !== 'place-routing-export'
    || value.city !== city
    || value.version !== version
    || !Number.isSafeInteger(Number(value.places)) || Number(value.places) <= 1
    || !Number.isSafeInteger(Number(value.patterns)) || Number(value.patterns) <= 0
    || !Number.isSafeInteger(Number(value.occurrences)) || Number(value.occurrences) <= 0
    || !Array.isArray(value.artifacts)
    || value.artifacts.length !== Number(value.places)) {
    throw new Error(`Invalid place routing export manifest for ${city} ${version}`)
  }

  const seen = new Set()
  const entries = value.artifacts.map((raw, index) => {
    const patterns = Number(raw?.patterns)
    const occurrences = Number(raw?.occurrences)
    const bytes = Number(raw?.bytes)
    if (typeof raw?.placeId !== 'string' || !raw.placeId
      || typeof raw?.key !== 'string' || !raw.key
      || !Number.isSafeInteger(patterns) || patterns <= 0
      || !Number.isSafeInteger(occurrences) || occurrences <= 0
      || !Number.isSafeInteger(bytes) || bytes <= 0
      || typeof raw?.sha256 !== 'string' || !SHA256.test(raw.sha256)
      || seen.has(raw.placeId)) {
      throw new Error(`Invalid place routing export manifest entry ${index}`)
    }
    seen.add(raw.placeId)
    return Object.freeze({
      placeId: raw.placeId,
      key: raw.key,
      patterns,
      occurrences,
      bytes,
      sha256: raw.sha256,
    })
  })

  return Object.freeze({
    entries: Object.freeze(entries),
    places: Number(value.places),
    patterns: Number(value.patterns),
    occurrences: Number(value.occurrences),
  })
}

export function parseTransferRoutingExportManifest(value, city, version) {
  if (!value || typeof value !== 'object'
    || value.schemaVersion !== 1
    || value.kind !== 'transfer-routing-export'
    || value.city !== city
    || value.version !== version
    || !Number.isSafeInteger(Number(value.shardCount))
    || Number(value.shardCount) < 1 || Number(value.shardCount) > 64
    || !Number.isSafeInteger(Number(value.patterns)) || Number(value.patterns) <= 0
    || !Array.isArray(value.patternShards)
    || value.patternShards.length !== Number(value.patterns)
    || !Array.isArray(value.shards)
    || value.shards.length !== Number(value.shardCount)) {
    throw new Error(`Invalid transfer routing export manifest for ${city} ${version}`)
  }

  const shardCount = Number(value.shardCount)
  const patternShards = new Map()
  for (const [index, raw] of value.patternShards.entries()) {
    const shard = Number(raw?.shard)
    if (typeof raw?.patternId !== 'string' || !raw.patternId
      || !Number.isSafeInteger(shard) || shard < 0 || shard >= shardCount
      || patternShards.has(raw.patternId)) {
      throw new Error(`Invalid transfer routing pattern shard ${index}`)
    }
    patternShards.set(raw.patternId, shard)
  }

  const seenShards = new Set()
  const shards = value.shards.map((raw, index) => {
    const shard = Number(raw?.shard)
    const patterns = Number(raw?.patterns)
    const occurrences = Number(raw?.occurrences)
    const bytes = Number(raw?.bytes)
    if (!Number.isSafeInteger(shard) || shard < 0 || shard >= shardCount
      || seenShards.has(shard)
      || !Number.isSafeInteger(patterns) || patterns < 0
      || !Number.isSafeInteger(occurrences) || occurrences < 0
      || !Number.isSafeInteger(bytes) || bytes <= 0
      || typeof raw?.key !== 'string' || !raw.key
      || typeof raw?.sha256 !== 'string' || !SHA256.test(raw.sha256)) {
      throw new Error(`Invalid transfer routing shard ${index}`)
    }
    seenShards.add(shard)
    return Object.freeze({ shard, key: raw.key, patterns, occurrences, bytes, sha256: raw.sha256 })
  })
  if (seenShards.size !== shardCount) throw new Error('Transfer routing shard coverage is incomplete')

  return Object.freeze({
    shardCount,
    patternShards,
    shards: Object.freeze(shards.sort((left, right) => left.shard - right.shard)),
  })
}

export function parsePlaceRoutingArtifact(value, entry, city, version) {
  if (!value || typeof value !== 'object'
    || value.schemaVersion !== 1
    || value.kind !== 'place-routing'
    || value.city !== city
    || value.version !== version
    || !value.place || typeof value.place !== 'object'
    || value.place.placeId !== entry.placeId
    || typeof value.place.name !== 'string' || !value.place.name
    || !Array.isArray(value.patterns) || value.patterns.length !== entry.patterns
    || !Array.isArray(value.occurrences) || value.occurrences.length !== entry.occurrences) {
    throw new Error(`Invalid place routing artifact ${entry.placeId}`)
  }

  const patterns = new Map()
  for (const raw of value.patterns) {
    const minSequence = Number(raw?.minSequence)
    const maxSequence = Number(raw?.maxSequence)
    if (typeof raw?.patternId !== 'string' || !raw.patternId
      || typeof raw.circular !== 'boolean'
      || !Number.isSafeInteger(minSequence) || minSequence < 0
      || !Number.isSafeInteger(maxSequence) || maxSequence < minSequence
      || patterns.has(raw.patternId)) {
      throw new Error(`Invalid place routing pattern ${entry.placeId}`)
    }
    patterns.set(raw.patternId, Object.freeze({
      patternId: raw.patternId,
      circular: raw.circular,
      minSequence,
      maxSequence,
    }))
  }

  const occurrences = new Map()
  for (const raw of value.occurrences) {
    const sequence = Number(raw?.stopSequence)
    if (typeof raw?.patternId !== 'string' || !patterns.has(raw.patternId)
      || !Number.isSafeInteger(sequence)) {
      throw new Error(`Invalid place routing occurrence ${entry.placeId}`)
    }
    const rows = occurrences.get(raw.patternId) ?? []
    rows.push(sequence)
    occurrences.set(raw.patternId, rows)
  }
  for (const [patternId, rows] of occurrences) {
    rows.sort((left, right) => left - right)
    const pattern = patterns.get(patternId)
    if (!rows.length || rows[0] < pattern.minSequence || rows.at(-1) > pattern.maxSequence) {
      throw new Error(`Place routing occurrence is outside pattern bounds ${entry.placeId}`)
    }
  }
  if (occurrences.size !== patterns.size) {
    throw new Error(`Place routing pattern occurrence coverage is incomplete ${entry.placeId}`)
  }

  return Object.freeze({
    entry,
    place: Object.freeze({ placeId: entry.placeId, name: value.place.name }),
    patterns,
    occurrences,
  })
}

export async function selectDirectMeasurementSample({ entries, readPlace }) {
  if (!Array.isArray(entries) || entries.length < 2) throw new Error('At least two place entries are required')
  if (typeof readPlace !== 'function') throw new TypeError('readPlace is required')

  const ordered = [...entries].sort((left, right) =>
    right.bytes - left.bytes || compareBinary(left.placeId, right.placeId))
  const loaded = []
  let best = null

  for (let index = 0; index < ordered.length; index += 1) {
    const current = await readPlace(ordered[index])
    for (const other of loaded) {
      const orientation = directOrientation(current, other)
      if (!orientation) continue
      const candidate = Object.freeze({
        ...orientation,
        endpointBytes: current.entry.bytes + other.entry.bytes,
        candidatePlacesRead: index + 1,
      })
      if (betterDirectCandidate(candidate, best)) best = candidate
    }
    loaded.push(current)

    const next = ordered[index + 1]
    if (best && (!next || best.endpointBytes >= ordered[0].bytes + next.bytes)) {
      return Object.freeze({ ...best, candidatePlacesRead: index + 1 })
    }
  }

  throw new Error('No reachable direct-routing place pair found')
}

export async function selectTransferMeasurementSample({ entries, patternShards, shardCount, readPlace }) {
  if (!Array.isArray(entries) || entries.length < 2) throw new Error('At least two place entries are required')
  if (!(patternShards instanceof Map) || patternShards.size === 0) throw new Error('Pattern shard map is required')
  if (!Number.isSafeInteger(shardCount) || shardCount < 1 || shardCount > 64) throw new Error('Invalid transfer shard count')
  if (typeof readPlace !== 'function') throw new TypeError('readPlace is required')

  const ordered = [...entries].sort((left, right) =>
    right.patterns - left.patterns || right.bytes - left.bytes || compareBinary(left.placeId, right.placeId))
  const loaded = []
  let maxLoadedShardCount = 0
  let best = null

  for (let index = 0; index < ordered.length; index += 1) {
    const place = await readPlace(ordered[index])
    const shardIds = new Set()
    for (const patternId of place.patterns.keys()) {
      const shard = patternShards.get(patternId)
      if (shard === undefined) throw new Error(`Pattern ${patternId} is missing from transfer manifest`)
      shardIds.add(shard)
    }
    const current = Object.freeze({ place, shardIds })
    maxLoadedShardCount = Math.max(maxLoadedShardCount, shardIds.size)

    for (const other of loaded) {
      const union = new Set([...shardIds, ...other.shardIds])
      const [fromPlace, toPlace] = orderPlaces(current.place, other.place)
      const candidate = Object.freeze({
        fromPlaceId: fromPlace.place.placeId,
        fromPlaceName: fromPlace.place.name,
        toPlaceId: toPlace.place.placeId,
        toPlaceName: toPlace.place.name,
        shardIds: Object.freeze([...union].sort((left, right) => left - right)),
        shardFanout: union.size,
        endpointBytes: current.place.entry.bytes + other.place.entry.bytes,
        candidatePlacesRead: index + 1,
      })
      if (betterTransferCandidate(candidate, best)) best = candidate
    }
    loaded.push(current)

    if (best?.shardFanout === shardCount) return Object.freeze({ ...best, candidatePlacesRead: index + 1 })

    const next = ordered[index + 1]
    if (best && !next) return Object.freeze({ ...best, candidatePlacesRead: index + 1 })
    if (best && next) {
      const nextShardUpperBound = Math.min(shardCount, next.patterns)
      const unseenUpperBound = Math.min(
        shardCount,
        Math.max(maxLoadedShardCount + nextShardUpperBound, nextShardUpperBound * 2),
      )
      if (best.shardFanout >= unseenUpperBound) return Object.freeze({ ...best, candidatePlacesRead: index + 1 })
    }
  }
  throw new Error('No transfer-routing place pair found')
}

export function buildMeasurementWranglerConfig(baseConfig, workerName) {
  if (!baseConfig || typeof baseConfig !== 'object') throw new TypeError('Base Wrangler config is required')
  if (!SAFE_WORKER_NAME.test(workerName)) throw new Error('Invalid measurement Worker name')
  const config = structuredClone(baseConfig)
  config.name = workerName
  config.workers_dev = true
  config.preview_urls = false
  config.observability = {
    ...(config.observability && typeof config.observability === 'object' ? config.observability : {}),
    enabled: true,
  }
  delete config.route
  delete config.routes
  delete config.triggers
  delete config.tail_consumers
  return Object.freeze(config)
}

export function parseWorkerAnalytics(payload, { scriptName, expectedRequests = RESOURCE_MEASUREMENT_REQUESTS } = {}) {
  const rows = payload?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive
  if (!Array.isArray(rows)) {
    const message = Array.isArray(payload?.errors) ? payload.errors.map((error) => error?.message).filter(Boolean).join('; ') : ''
    throw new Error(`Cloudflare Workers analytics response is invalid${message ? `: ${message}` : ''}`)
  }
  const successRows = rows.filter((row) => row?.dimensions?.scriptName === scriptName && row?.dimensions?.status === 'success')
  if (successRows.length !== 1) throw new Error(`Expected one successful analytics row for ${scriptName}, received ${successRows.length}`)
  const row = successRows[0]
  const requests = finiteNumber(row?.sum?.requests, 'requests')
  const subrequests = finiteNumber(row?.sum?.subrequests, 'subrequests')
  const errors = finiteNumber(row?.sum?.errors, 'errors')
  if (requests < expectedRequests) throw new Error(`Workers analytics has ${requests} requests; expected at least ${expectedRequests}`)
  if (errors !== 0) throw new Error(`Workers analytics recorded ${errors} errors`)
  const memory = Object.freeze({
    p50: positiveNumber(row?.quantiles?.memoryUsageBytesP50, 'memoryUsageBytesP50'),
    p90: positiveNumber(row?.quantiles?.memoryUsageBytesP90, 'memoryUsageBytesP90'),
    p99: positiveNumber(row?.quantiles?.memoryUsageBytesP99, 'memoryUsageBytesP99'),
    p999: positiveNumber(row?.quantiles?.memoryUsageBytesP999, 'memoryUsageBytesP999'),
  })
  return Object.freeze({ requests, subrequests, subrequestsPerRequest: subrequests / requests, errors, memoryUsageBytes: memory })
}

export function measurementWorkerName({ runId, runAttempt, city, kind }) {
  const citySlug = String(city).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const kindSlug = String(kind).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const suffix = `${String(runId).replace(/\D/g, '').slice(-12)}-${String(runAttempt).replace(/\D/g, '').slice(-3)}-${citySlug}-${kindSlug}`
  const name = `mochi-res-${suffix}`.slice(0, 63).replace(/-+$/g, '')
  if (!SAFE_WORKER_NAME.test(name)) throw new Error('Unable to build safe measurement Worker name')
  return name
}

export async function cleanupRegisteredWorkers({ registryFile, accountId, deployToken, fetchImpl = fetch }) {
  if (!registryFile) throw new Error('Cleanup registry path is required')
  const registry = await readRegistry(registryFile)
  const failures = []
  for (const workerName of registry.workerNames) {
    try {
      await deleteWorker({ accountId, deployToken, workerName, fetchImpl })
      await unregisterWorker(registryFile, workerName)
      console.log(JSON.stringify({ event: 'worker_resource_measurement_cleanup', workerName, result: 'deleted' }))
    } catch (error) {
      failures.push(`${workerName}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (failures.length) throw new Error(`Temporary Worker cleanup failed: ${failures.join('; ')}`)
}

export async function measureWorkerResources({
  outputFile,
  registryFile,
  env = process.env,
  fetchImpl = fetch,
  spawnImpl = spawnSync,
  sleep = delay,
  now = () => new Date(),
} = {}) {
  if (!outputFile || !registryFile) throw new Error('Measurement output and cleanup registry are required')
  const resources = loadOperationalResources()
  const accountId = required(env.CLOUDFLARE_ACCOUNT_ID, 'CLOUDFLARE_ACCOUNT_ID')
  const apiToken = required(env.CLOUDFLARE_API_TOKEN, 'CLOUDFLARE_API_TOKEN')
  const deployToken = required(env.CLOUDFLARE_DEPLOY_API_TOKEN, 'CLOUDFLARE_DEPLOY_API_TOKEN')
  const analyticsToken = env.CLOUDFLARE_ANALYTICS_API_TOKEN?.trim() || apiToken
  const databaseId = required(env.TRANSIT_DATABASE_ID ?? resources.d1DatabaseId, 'TRANSIT_DATABASE_ID')
  const bucket = required(env.TRANSIT_R2_BUCKET_NAME ?? resources.r2BucketName, 'TRANSIT_R2_BUCKET_NAME')
  const accessKeyId = required(env.R2_ACCESS_KEY_ID, 'R2_ACCESS_KEY_ID')
  const secretAccessKey = required(env.R2_SECRET_ACCESS_KEY, 'R2_SECRET_ACCESS_KEY')
  const runId = required(env.GITHUB_RUN_ID, 'GITHUB_RUN_ID')
  const runAttempt = required(env.GITHUB_RUN_ATTEMPT, 'GITHUB_RUN_ATTEMPT')
  const sourceCommit = required(env.GITHUB_SHA, 'GITHUB_SHA')

  await mkdir(dirname(outputFile), { recursive: true })
  await mkdir(dirname(registryFile), { recursive: true })
  await writeRegistry(registryFile, [])
  const report = {
    schemaVersion: 1,
    event: 'snapshot_worker_resource_measurement',
    sourceCommit,
    workflowRunId: runId,
    workflowRunAttempt: runAttempt,
    measuredRequestsPerCase: RESOURCE_MEASUREMENT_REQUESTS,
    cities: [],
    failures: [],
  }
  await writeReport(outputFile, report)

  const r2 = new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' })
  const r2BaseUrl = `https://${accountId}.r2.cloudflarestorage.com/${bucket}`
  const query = (sql, params) => queryD1({ accountId, apiToken, databaseId, fetchImpl, sql, params })
  const readR2 = async (entryOrKey) => {
    const key = typeof entryOrKey === 'string' ? entryOrKey : entryOrKey.key
    const response = await r2.fetch(objectUrl(r2BaseUrl, key))
    const body = await response.text()
    if (!response.ok) throw new Error(`R2 GET ${key} failed (${response.status})`)
    if (typeof entryOrKey === 'object') {
      const bytes = new TextEncoder().encode(body).byteLength
      const sha256 = createHash('sha256').update(body).digest('hex')
      if (bytes !== entryOrKey.bytes || sha256 !== entryOrKey.sha256) throw new Error(`R2 artifact fingerprint mismatch ${key}`)
    }
    try { return JSON.parse(body) } catch { throw new Error(`R2 GET ${key} returned invalid JSON`) }
  }

  const subdomain = await readWorkersSubdomain({ accountId, deployToken, fetchImpl })
  const baseWranglerPath = resolve('.generated/instance/wrangler.instance.jsonc')
  const baseConfig = JSON.parse(await readFile(baseWranglerPath, 'utf8'))

  for (const city of RESOURCE_MEASUREMENT_CITIES) {
    const cityReport = { city, version: null, sampleSelection: null, cases: [] }
    report.cities.push(cityReport)
    try {
      const rows = await query('SELECT active_version FROM dataset_versions WHERE city_code = ? LIMIT 1', [city])
      const version = rows[0]?.active_version
      if (typeof version !== 'string' || !version) throw new Error(`No active snapshot for ${city}`)
      cityReport.version = version

      const [placeManifestRaw, transferManifestRaw] = await Promise.all([
        readR2(`snapshots/${version}/cities/${city}/place-routing-export.json`),
        readR2(`snapshots/${version}/cities/${city}/transfer-routing-export.json`),
      ])
      const placeManifest = parsePlaceRoutingExportManifest(placeManifestRaw, city, version)
      const transferManifest = parseTransferRoutingExportManifest(transferManifestRaw, city, version)
      const placeCache = new Map()
      const readPlace = async (entry) => {
        let pending = placeCache.get(entry.placeId)
        if (!pending) {
          pending = readR2(entry).then((value) => parsePlaceRoutingArtifact(value, entry, city, version))
          placeCache.set(entry.placeId, pending)
        }
        return pending
      }

      const [directSample, transferSample] = await Promise.all([
        selectDirectMeasurementSample({ entries: placeManifest.entries, readPlace }),
        selectTransferMeasurementSample({
          entries: placeManifest.entries,
          patternShards: transferManifest.patternShards,
          shardCount: transferManifest.shardCount,
          readPlace,
        }),
      ])
      cityReport.sampleSelection = {
        direct: directSample,
        transfer: transferSample,
        placeArtifactsRead: placeCache.size,
        transferShardCount: transferManifest.shardCount,
      }

      for (const kind of RESOURCE_MEASUREMENT_KINDS) {
        const sample = kind === 'direct' ? directSample : transferSample
        const workerName = measurementWorkerName({ runId, runAttempt, city, kind })
        const caseReport = { kind, workerName, sample, requestResults: [], analytics: null, cleanupVerified: false, status: 'pending' }
        cityReport.cases.push(caseReport)
        try {
          const result = await measureCase({
            city, kind, sample, workerName, subdomain, baseConfig, baseWranglerPath, registryFile,
            accountId, deployToken, analyticsToken, sourceCommit, fetchImpl, spawnImpl, sleep, now,
          })
          Object.assign(caseReport, result, { status: 'success' })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          caseReport.status = 'failed'
          caseReport.error = message
          report.failures.push(`${city}/${kind}: ${message}`)
        } finally {
          await writeReport(outputFile, report)
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      cityReport.status = 'failed'
      cityReport.error = message
      report.failures.push(`${city}: ${message}`)
      await writeReport(outputFile, report)
    }
  }

  report.completedAt = now().toISOString()
  report.acceptanceEvidence = report.failures.length === 0
    && report.cities.length === RESOURCE_MEASUREMENT_CITIES.length
    && report.cities.every((city) =>
      city.cases.length === RESOURCE_MEASUREMENT_KINDS.length
      && city.cases.every((item) => item.status === 'success' && item.cleanupVerified === true))
  await writeReport(outputFile, report)
  if (!report.acceptanceEvidence) throw new Error(`Worker resource measurement incomplete: ${report.failures.join('; ')}`)
  return Object.freeze(report)
}

async function measureCase({
  city, kind, sample, workerName, subdomain, baseConfig, baseWranglerPath, registryFile,
  accountId, deployToken, analyticsToken, sourceCommit, fetchImpl, spawnImpl, sleep, now,
}) {
  const configPath = join(dirname(baseWranglerPath), `${workerName}.jsonc`)
  const config = buildMeasurementWranglerConfig(baseConfig, workerName)
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  await registerWorker(registryFile, workerName)
  let primaryError = null

  try {
    runWranglerDeploy({ configPath, workerName, deployToken, accountId, sourceCommit, spawnImpl })
    const origin = `https://${workerName}.${subdomain}.workers.dev`
    await waitForWorker(origin, fetchImpl, sleep)

    const measurementStart = new Date(now().getTime() - 1000).toISOString()
    const requestResults = []
    for (let index = 0; index < RESOURCE_MEASUREMENT_REQUESTS; index += 1) {
      const response = await fetchImpl(measurementUrl({ origin, city, kind, sample, index }), {
        headers: { 'Cache-Control': 'no-cache', 'User-Agent': 'mochi-bus-resource-measurement/1' },
      })
      const text = await response.text()
      if (!response.ok) throw new Error(`${city}/${kind} request failed (${response.status}): ${boundedText(text)}`)
      let payload
      try { payload = JSON.parse(text) } catch { throw new Error(`${city}/${kind} returned invalid JSON`) }
      const expectedKey = kind === 'direct' ? 'routes' : 'plans'
      if (payload?.schemaVersion !== 1 || payload?.city !== city
        || payload?.from !== sample.fromPlaceId || payload?.to !== sample.toPlaceId
        || !Array.isArray(payload?.[expectedKey])) throw new Error(`${city}/${kind} response contract mismatch`)
      requestResults.push(Object.freeze({ status: response.status, resultCount: payload[expectedKey].length }))
    }
    const measurementEnd = new Date(now().getTime() + 1000).toISOString()
    const analytics = await waitForAnalytics({
      accountId, analyticsToken, scriptName: workerName, datetimeStart: measurementStart,
      datetimeEnd: measurementEnd, expectedRequests: RESOURCE_MEASUREMENT_REQUESTS, fetchImpl, sleep,
    })
    return Object.freeze({
      requestResults: Object.freeze(requestResults),
      analyticsWindow: Object.freeze({ start: measurementStart, end: measurementEnd }),
      analytics,
      cleanupVerified: true,
    })
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    try {
      await deleteWorker({ accountId, deployToken, workerName, fetchImpl })
      await unregisterWorker(registryFile, workerName)
    } catch (cleanupError) {
      const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
      if (primaryError) {
        const primaryMessage = primaryError instanceof Error ? primaryError.message : String(primaryError)
        throw new AggregateError([primaryError, cleanupError], `${primaryMessage}; cleanup failed: ${cleanupMessage}`)
      }
      throw cleanupError
    } finally {
      await unlink(configPath).catch(() => {})
    }
  }
}

function directOrientation(left, right) {
  for (const [patternId, leftSequences] of left.occurrences) {
    const rightSequences = right.occurrences.get(patternId)
    const pattern = left.patterns.get(patternId)
    const rightPattern = right.patterns.get(patternId)
    if (!rightSequences || !pattern || !rightPattern || pattern.circular !== rightPattern.circular) continue
    for (const leftSequence of leftSequences) {
      for (const rightSequence of rightSequences) {
        if (leftSequence === rightSequence) continue
        if (rightSequence > leftSequence || pattern.circular) {
          return {
            fromPlaceId: left.place.placeId, fromPlaceName: left.place.name,
            toPlaceId: right.place.placeId, toPlaceName: right.place.name, patternId,
          }
        }
        return {
          fromPlaceId: right.place.placeId, fromPlaceName: right.place.name,
          toPlaceId: left.place.placeId, toPlaceName: left.place.name, patternId,
        }
      }
    }
  }
  return null
}

function betterDirectCandidate(candidate, current) {
  if (!current) return true
  if (candidate.endpointBytes !== current.endpointBytes) return candidate.endpointBytes > current.endpointBytes
  return candidateKey(candidate) < candidateKey(current)
}

function betterTransferCandidate(candidate, current) {
  if (!current) return true
  if (candidate.shardFanout !== current.shardFanout) return candidate.shardFanout > current.shardFanout
  if (candidate.endpointBytes !== current.endpointBytes) return candidate.endpointBytes > current.endpointBytes
  return candidateKey(candidate) < candidateKey(current)
}

function candidateKey(candidate) { return `${candidate.fromPlaceId}\u0000${candidate.toPlaceId}` }
function orderPlaces(left, right) { return compareBinary(left.place.placeId, right.place.placeId) <= 0 ? [left, right] : [right, left] }
function compareBinary(left, right) { return left < right ? -1 : left > right ? 1 : 0 }

function finiteNumber(value, label) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) throw new Error(`Invalid ${label}`)
  return number
}
function positiveNumber(value, label) {
  const number = finiteNumber(value, label)
  if (number <= 0) throw new Error(`Invalid ${label}`)
  return number
}
function required(value, name) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) throw new Error(`${name} is required`)
  return text
}
function objectUrl(baseUrl, key) { return `${baseUrl}/${key.split('/').map(encodeURIComponent).join('/')}` }
function boundedText(value) { return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) }

function measurementUrl({ origin, city, kind, sample, index }) {
  const url = new URL(kind === 'direct' ? '/api/v1/map/direct' : '/api/v1/map/transfer', origin)
  url.searchParams.set('city', city)
  url.searchParams.set('from', sample.fromPlaceId)
  url.searchParams.set('to', sample.toPlaceId)
  url.searchParams.set('_measurement', String(index))
  return url.href
}

function runWranglerDeploy({ configPath, workerName, deployToken, accountId, sourceCommit, spawnImpl }) {
  const result = spawnImpl(resolve('node_modules/.bin/wrangler'), [
    'deploy', '--config', configPath, '--name', workerName, '--minify',
    '--tag', sourceCommit, '--message', `Resource measurement ${sourceCommit}`,
  ], {
    cwd: process.cwd(),
    env: { ...process.env, CLOUDFLARE_API_TOKEN: deployToken, CLOUDFLARE_ACCOUNT_ID: accountId },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result?.status !== 0) throw new Error(`Wrangler deploy failed for ${workerName}: ${boundedText(result?.stderr || result?.stdout)}`)
}

async function readWorkersSubdomain({ accountId, deployToken, fetchImpl }) {
  const response = await fetchImpl(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/subdomain`,
    { headers: { Authorization: `Bearer ${deployToken}` } },
  )
  const payload = await response.json().catch(() => null)
  const subdomain = payload?.result?.subdomain
  if (!response.ok || payload?.success !== true || typeof subdomain !== 'string' || !subdomain) {
    throw new Error(`Unable to resolve workers.dev subdomain (${response.status})`)
  }
  return subdomain
}

async function waitForWorker(origin, fetchImpl, sleep) {
  let lastStatus = null
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetchImpl(`${origin}/api/v1/health/release`, { headers: { 'Cache-Control': 'no-cache' } })
      lastStatus = response.status
      if (response.ok) return
    } catch { lastStatus = null }
    await sleep(2000)
  }
  throw new Error(`Temporary Worker did not become ready${lastStatus ? ` (last status ${lastStatus})` : ''}`)
}

async function waitForAnalytics({
  accountId, analyticsToken, scriptName, datetimeStart, datetimeEnd,
  expectedRequests, fetchImpl, sleep, attempts = DEFAULT_ANALYTICS_POLL_ATTEMPTS,
  pollMs = DEFAULT_ANALYTICS_POLL_MS,
}) {
  let lastError = null
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchImpl(GRAPHQL_ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${analyticsToken}`, Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: WORKER_ANALYTICS_QUERY,
          variables: {
            accountTag: accountId,
            datetimeStart,
            datetimeEnd: new Date(Math.max(Date.parse(datetimeEnd), Date.now() + 1000)).toISOString(),
            scriptName,
          },
        }),
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok) throw new Error(`GraphQL HTTP ${response.status}`)
      return parseWorkerAnalytics(payload, { scriptName, expectedRequests })
    } catch (error) {
      lastError = error
      if (attempt + 1 < attempts) await sleep(pollMs)
    }
  }
  throw new Error(`Workers analytics did not become complete: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

async function deleteWorker({ accountId, deployToken, workerName, fetchImpl }) {
  const response = await fetchImpl(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(workerName)}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${deployToken}` } },
  )
  if (response.status === 404) return
  const payload = await response.json().catch(() => null)
  if (!response.ok || payload?.success !== true) throw new Error(`Cloudflare Worker delete failed for ${workerName} (${response.status})`)
}

async function registerWorker(registryFile, workerName) {
  const registry = await readRegistry(registryFile)
  const names = new Set(registry.workerNames)
  names.add(workerName)
  await writeRegistry(registryFile, [...names].sort(compareBinary))
}
async function unregisterWorker(registryFile, workerName) {
  const registry = await readRegistry(registryFile)
  await writeRegistry(registryFile, registry.workerNames.filter((name) => name !== workerName))
}
async function readRegistry(registryFile) {
  try {
    const value = JSON.parse(await readFile(registryFile, 'utf8'))
    if (!Array.isArray(value?.workerNames)
      || value.workerNames.some((name) => typeof name !== 'string' || !SAFE_WORKER_NAME.test(name))) {
      throw new Error('Cleanup registry is invalid')
    }
    return Object.freeze({ workerNames: Object.freeze([...new Set(value.workerNames)]) })
  } catch (error) {
    if (error?.code === 'ENOENT') return Object.freeze({ workerNames: Object.freeze([]) })
    throw error
  }
}
async function writeRegistry(registryFile, workerNames) {
  await mkdir(dirname(registryFile), { recursive: true })
  await writeFile(registryFile, `${JSON.stringify({ schemaVersion: 1, workerNames }, null, 2)}\n`, { mode: 0o600 })
}
async function writeReport(outputFile, report) {
  await mkdir(dirname(outputFile), { recursive: true })
  await writeFile(outputFile, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
}
function delay(milliseconds) { return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)) }

async function main() {
  const args = process.argv.slice(2)
  if (args[0] === '--cleanup-registry') {
    await cleanupRegisteredWorkers({
      registryFile: args[1],
      accountId: required(process.env.CLOUDFLARE_ACCOUNT_ID, 'CLOUDFLARE_ACCOUNT_ID'),
      deployToken: required(process.env.CLOUDFLARE_DEPLOY_API_TOKEN, 'CLOUDFLARE_DEPLOY_API_TOKEN'),
    })
    return
  }
  if (!args[0] || !args[1]) throw new Error('Usage: measure-worker-resources.mjs <output-json> <cleanup-registry-json>')
  const report = await measureWorkerResources({ outputFile: args[0], registryFile: args[1] })
  console.log(JSON.stringify({
    event: 'snapshot_worker_resource_measurement_completed',
    sourceCommit: report.sourceCommit,
    acceptanceEvidence: report.acceptanceEvidence,
    cities: report.cities.map((city) => city.city),
  }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify({
      event: 'snapshot_worker_resource_measurement_failed',
      message: error instanceof Error ? error.message : String(error),
    }))
    process.exitCode = 1
  })
}
