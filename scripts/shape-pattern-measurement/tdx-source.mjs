import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { performance } from 'node:perf_hooks'
import { Worker } from 'node:worker_threads'
import { DEFAULT_MAX_ATTEMPTS, DEFAULT_TIMEOUT_MS, RAW_SCHEMA_VERSION } from './constants.mjs'
import { attachCleanupFailure } from './measurement-errors.mjs'
import { atomicWrite, contentHash, readJson, sleep, stableStringify, writeJson } from './util.mjs'

const TOKEN_ENDPOINT = 'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token'
const API_BASE = 'https://tdx.transportdata.tw/api/basic/v2/Bus'
const SAFE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}\.json$/
const PARSE_WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
try {
  parentPort.postMessage({ ok: true, value: JSON.parse(workerData) })
} catch {
  parentPort.postMessage({ ok: false, failureClass: 'invalid_json' })
}
`

export class TDXMeasurementError extends Error {
  constructor(message, details = {}, options = {}) {
    super(message, options)
    this.name = 'TDXMeasurementError'
    this.code = 'TDX_MEASUREMENT_ERROR'
    this.details = {
      endpointCategory: details.endpointCategory ?? 'unknown',
      city: details.city ?? null,
      httpStatus: Number.isInteger(details.httpStatus) ? details.httpStatus : null,
      failureClass: details.failureClass ?? 'unknown',
      retryCount: Number.isInteger(details.retryCount) ? details.retryCount : 0,
      timestamp: details.timestamp ?? new Date().toISOString(),
      ...(typeof details.cleanupFailureClass === 'string'
        ? { cleanupFailureClass: details.cleanupFailureClass.slice(0, 80) }
        : {}),
    }
  }
}

export async function loadCredentials({ env = process.env, varsFile = '.dev.vars' } = {}) {
  let fileVars = {}
  try { fileVars = parseVars(await readFile(varsFile, 'utf8')) } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const clientId = env.TDX_CLIENT_ID ?? fileVars.TDX_CLIENT_ID
  const clientSecret = env.TDX_CLIENT_SECRET ?? fileVars.TDX_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new TDXMeasurementError('TDX credentials are required for live fetch', {
      endpointCategory: 'token', failureClass: 'missing_credentials',
    })
  }
  return { clientId, clientSecret }
}

export function parseVars(source) {
  const result = {}
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (!match) continue
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    result[match[1]] = value
  }
  return result
}

export function expectedEndpointSpecs(cities, includeIntercity) {
  const specs = []
  for (const city of cities) {
    specs.push(endpointSpec('city', city, 'stop-of-route', `StopOfRoute/City/${city}`))
    specs.push(endpointSpec('city', city, 'shape', `Shape/City/${city}`))
  }
  if (includeIntercity) {
    specs.push(endpointSpec('intercity', null, 'stop-of-route', 'StopOfRoute/InterCity'))
    specs.push(endpointSpec('intercity', null, 'shape', 'Shape/InterCity'))
  }
  return specs.sort((a, b) => a.endpointId.localeCompare(b.endpointId))
}

export async function fetchRawBundle({
  cities,
  includeIntercity,
  rawDir,
  concurrency = 2,
  fetcher = fetch,
  now = () => new Date(),
  random = Math.random,
  progress = (entry) => console.log(stableStringify(entry)),
  credentials,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  removeDirectory = rm,
}) {
  const target = resolve(rawDir)
  await assertMissing(target)
  const onParseCleanupFailure = (failure) => progress({
    phase: 'parse-cleanup-failure',
    ...failure,
    timestamp: now().toISOString(),
  })
  const resolvedCredentials = credentials ?? await loadCredentials()
  const token = await fetchToken(resolvedCredentials, {
    fetcher, random, now, timeoutMs, maxAttempts, onParseCleanupFailure,
  })
  const specs = expectedEndpointSpecs(cities, includeIntercity)
  await mkdir(dirname(target), { recursive: true })
  const temporary = `${target}.tmp-${randomUUID()}`
  await mkdir(temporary, { recursive: false })
  try {
    const fetchedAt = now().toISOString()
    const responses = await mapConcurrent(specs, concurrency, async (spec) => {
      progress({ phase: 'fetch-start', endpointCategory: spec.category, city: spec.city, timestamp: now().toISOString() })
      const payload = await fetchEndpointPayload(spec, token, {
        fetcher, random, now, timeoutMs, maxAttempts, onParseCleanupFailure,
      })
      const entry = createRawCacheEntry(spec, payload)
      await atomicWrite(join(temporary, entry.fileName), `${stableStringify(payload, 2)}\n`)
      progress({ phase: 'fetch-complete', endpointCategory: spec.category, city: spec.city, timestamp: now().toISOString() })
      return { ...entry, payload }
    })
    const manifest = createRawCacheManifest({ cities, includeIntercity, fetchedAt, responses })
    const bundle = bundleFromResponses(responses, manifest)
    await writeJson(join(temporary, 'manifest.json'), manifest)
    await syncDirectory(temporary)
    await rename(temporary, target)
    return { bundle, manifest }
  } catch (error) {
    try {
      await removeDirectory(temporary, { recursive: true, force: true })
    } catch {
      throw attachCleanupFailure(error, { stage: 'raw-cache-temporary-cleanup', temporaryPath: temporary })
    }
    throw error
  }
}

export async function replayRawBundle({ rawDir }) {
  const root = resolve(rawDir)
  await assertDirectoryNoSymlink(root)
  const manifestPath = join(root, 'manifest.json')
  await assertRegularFileNoSymlink(manifestPath, root)
  const manifest = await readJson(manifestPath)
  const specs = validateManifest(manifest)
  const responses = []
  const entryById = new Map(manifest.endpoints.map((entry) => [entry.endpointId, entry]))
  for (const spec of specs) {
    const entry = entryById.get(spec.endpointId)
    const file = await resolveManifestFile(root, entry.fileName)
    const payload = await readJson(file)
    if (!Array.isArray(payload) || contentHash(payload) !== entry.contentHash) {
      throw corruptCache(entry, 'Raw cache content hash mismatch')
    }
    responses.push({ ...entry, payload })
  }
  const expectedBundleHash = computeBundleHash(manifest)
  if (expectedBundleHash !== manifest.bundleContentHash) {
    throw new TDXMeasurementError('Raw cache bundle hash mismatch', { failureClass: 'corrupt_cache' })
  }
  return { bundle: bundleFromResponses(responses, manifest), manifest }
}

export function assertReplayScope(options, manifest) {
  if (options.citiesExplicit && stableStringify(options.cities) !== stableStringify(manifest.cities)) {
    throw new TDXMeasurementError('Replay cities do not match verified manifest', { failureClass: 'replay_scope_mismatch' })
  }
  if (options.includeIntercityExplicit && options.includeIntercity !== manifest.includeIntercity) {
    throw new TDXMeasurementError('Replay InterCity scope does not match verified manifest', { failureClass: 'replay_scope_mismatch' })
  }
}

export function validateManifest(manifest) {
  if (!plainObject(manifest) || manifest.schemaVersion !== RAW_SCHEMA_VERSION) {
    throw new TDXMeasurementError('Raw cache manifest schema is invalid', { failureClass: 'corrupt_cache' })
  }
  if (!Array.isArray(manifest.cities) || !manifest.cities.length
    || manifest.cities.some((city) => typeof city !== 'string' || !city)
    || new Set(manifest.cities).size !== manifest.cities.length
    || typeof manifest.includeIntercity !== 'boolean'
    || typeof manifest.fetchedAt !== 'string'
    || !Array.isArray(manifest.endpoints)
    || typeof manifest.bundleContentHash !== 'string'
    || !/^[a-f0-9]{64}$/.test(manifest.bundleContentHash)) {
    throw new TDXMeasurementError('Raw cache manifest metadata is invalid', { failureClass: 'corrupt_cache' })
  }
  const specs = expectedEndpointSpecs(manifest.cities, manifest.includeIntercity)
  const expectedIds = new Set(specs.map((entry) => entry.endpointId))
  const seen = new Set()
  for (const entry of manifest.endpoints) {
    if (!plainObject(entry) || typeof entry.endpointId !== 'string' || seen.has(entry.endpointId)) {
      throw new TDXMeasurementError('Raw cache manifest has duplicate or invalid endpoints', { failureClass: 'corrupt_cache' })
    }
    seen.add(entry.endpointId)
    const spec = specs.find((candidate) => candidate.endpointId === entry.endpointId)
    if (!spec || !entryMatchesSpec(entry, spec)
      || !Number.isSafeInteger(entry.itemCount) || entry.itemCount < 0
      || !/^[a-f0-9]{64}$/.test(entry.contentHash)
      || (entry.maxUpdateTime !== null && typeof entry.maxUpdateTime !== 'string')) {
      throw corruptCache(entry, 'Raw cache endpoint metadata is invalid')
    }
  }
  if (seen.size !== expectedIds.size || [...expectedIds].some((id) => !seen.has(id))) {
    throw new TDXMeasurementError('Raw cache endpoint set is incomplete', { failureClass: 'corrupt_cache' })
  }
  if (manifest.endpoints.length !== specs.length) {
    throw new TDXMeasurementError('Raw cache endpoint set contains extras', { failureClass: 'corrupt_cache' })
  }
  return specs
}

export function createRawCacheManifest({ cities, includeIntercity, fetchedAt, responses }) {
  const endpoints = responses.map(({ payload: _payload, ...entry }) => entry)
    .sort((a, b) => a.endpointId.localeCompare(b.endpointId))
  const manifest = {
    schemaVersion: RAW_SCHEMA_VERSION,
    fetchedAt,
    cities: [...cities],
    includeIntercity,
    endpoints,
    bundleContentHash: null,
  }
  manifest.bundleContentHash = computeBundleHash(manifest)
  return manifest
}

export function computeBundleHash(manifest) {
  return contentHash({
    schemaVersion: manifest.schemaVersion,
    fetchedAt: manifest.fetchedAt,
    cities: manifest.cities,
    includeIntercity: manifest.includeIntercity,
    endpoints: [...manifest.endpoints]
      .sort((a, b) => a.endpointId.localeCompare(b.endpointId))
      .map((entry) => ({
        endpointId: entry.endpointId,
        scope: entry.scope,
        city: entry.city,
        category: entry.category,
        fileName: entry.fileName,
        contentHash: entry.contentHash,
        itemCount: entry.itemCount,
        maxUpdateTime: entry.maxUpdateTime,
      })),
  })
}

function bundleFromResponses(responses, manifest) {
  const byId = new Map(responses.map((entry) => [entry.endpointId, entry.payload]))
  const sources = []
  for (const city of manifest.cities) {
    sources.push({
      scope: 'city',
      city,
      stopOfRoute: byId.get(endpointId('city', city, 'stop-of-route')),
      shapes: byId.get(endpointId('city', city, 'shape')),
    })
  }
  if (manifest.includeIntercity) {
    sources.push({
      scope: 'intercity',
      city: null,
      stopOfRoute: byId.get(endpointId('intercity', null, 'stop-of-route')),
      shapes: byId.get(endpointId('intercity', null, 'shape')),
    })
  }
  if (sources.some((source) => !Array.isArray(source.stopOfRoute) || !Array.isArray(source.shapes))) {
    throw new TDXMeasurementError('Raw cache endpoint payload is missing', { failureClass: 'corrupt_cache' })
  }
  return { schemaVersion: RAW_SCHEMA_VERSION, fetchedAt: manifest.fetchedAt, sources }
}

async function fetchToken({ clientId, clientSecret }, dependencies) {
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret })
  const data = await requestJsonWithRetry({
    endpointCategory: 'token', city: null, url: TOKEN_ENDPOINT,
    init: { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body },
    expectArray: false,
    ...dependencies,
  })
  if (!plainObject(data) || typeof data.access_token !== 'string' || !data.access_token) {
    throw safeError('token', null, null, 'invalid_schema', 0)
  }
  return data.access_token
}

async function fetchEndpointPayload(spec, token, dependencies) {
  return requestJsonWithRetry({
    endpointCategory: spec.category,
    city: spec.city,
    url: `${API_BASE}/${spec.path}?$format=JSON`,
    init: { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
    expectArray: true,
    ...dependencies,
  })
}

export async function requestJsonWithRetry({
  endpointCategory,
  city,
  url,
  init,
  fetcher,
  random,
  now,
  expectArray,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  workerFactory,
  monotonicNow = () => performance.now(),
  parseJson = parseJsonWithDeadline,
  onParseCleanupFailure,
}) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const deadlineAt = monotonicNow() + timeoutMs
    const controller = new AbortController()
    let timer = setTimeout(() => controller.abort(), timeoutMs)
    let response
    try {
      response = await fetcher(url, { ...init, signal: controller.signal })
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500
        if (!retryable || attempt === maxAttempts - 1) {
          throw safeError(endpointCategory, city, response.status, classifyHttp(response.status), attempt)
        }
        clearTimeout(timer)
        timer = null
        await sleep(backoffDelay(attempt, response.headers?.get?.('Retry-After') ?? null, random, now))
        continue
      }
      const text = await response.text()
      clearTimeout(timer)
      timer = null
      const data = await parseJson(text, {
        deadlineAt,
        monotonicNow,
        endpointCategory,
        city,
        httpStatus: response.status,
        retryCount: attempt,
        workerFactory,
        onCleanupFailure: onParseCleanupFailure,
      })
      if ((expectArray && !Array.isArray(data)) || (!expectArray && !plainObject(data))) {
        throw safeError(endpointCategory, city, response.status, 'invalid_schema', attempt)
      }
      return data
    } catch (error) {
      const final = attempt === maxAttempts - 1
      if (error instanceof TDXMeasurementError) {
        if (!final && retryableMeasurementFailure(error.details.failureClass)) {
          await sleep(backoffDelay(attempt, null, random, now))
          continue
        }
        throw error
      }
      if (final) throw safeError(endpointCategory, city, response?.status ?? null, classifyTransport(error), attempt)
      await sleep(backoffDelay(attempt, null, random, now))
    } finally {
      if (timer !== null) clearTimeout(timer)
    }
  }
  throw safeError(endpointCategory, city, null, 'retry_exhausted', maxAttempts - 1)
}

export async function parseJsonWithDeadline(text, {
  timeoutMs,
  deadlineAt = null,
  monotonicNow = () => performance.now(),
  endpointCategory = 'unknown',
  city = null,
  httpStatus = null,
  retryCount = 0,
  workerFactory = defaultWorkerFactory,
  terminationTimeoutMs = 1_000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onCleanupFailure = () => undefined,
  operationId = randomUUID(),
} = {}) {
  const startedAt = monotonicNow()
  const absoluteDeadline = Number.isFinite(deadlineAt)
    ? deadlineAt
    : Number.isFinite(timeoutMs) ? startedAt + timeoutMs : Number.NaN
  if (!Number.isFinite(absoluteDeadline) || absoluteDeadline - startedAt <= 0) {
    throw safeError(endpointCategory, city, httpStatus, 'timeout', retryCount)
  }

  let worker
  try {
    worker = workerFactory({ source: PARSE_WORKER_SOURCE, text })
  } catch {
    throw safeError(endpointCategory, city, httpStatus, 'parse_worker_error', retryCount)
  }

  const remainingAfterConstruction = absoluteDeadline - monotonicNow()
  if (remainingAfterConstruction <= 0) {
    requestWorkerTermination(worker, {
      terminationTimeoutMs,
      setTimer,
      clearTimer,
      onCleanupFailure,
      operationId,
    })
    throw safeError(endpointCategory, city, httpStatus, 'timeout', retryCount)
  }

  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false
    let timer = null

    const settle = ({ value, failureClass = null }) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimer(timer)
      worker.off('message', onMessage)
      worker.off('error', onError)
      worker.off('messageerror', onMessageError)
      worker.off('exit', onExit)
      if (failureClass !== null) {
        rejectPromise(safeError(endpointCategory, city, httpStatus, failureClass, retryCount))
      } else {
        resolvePromise(value)
      }
      requestWorkerTermination(worker, {
        terminationTimeoutMs,
        setTimer,
        clearTimer,
        onCleanupFailure,
        operationId,
      })
    }

    const settleFromWorker = (result) => {
      if (monotonicNow() >= absoluteDeadline) settle({ failureClass: 'timeout' })
      else settle(result)
    }
    const onMessage = (message) => {
      if (!plainObject(message) || typeof message.ok !== 'boolean') {
        settleFromWorker({ failureClass: 'parse_worker_message_error' })
        return
      }
      if (message.ok) settleFromWorker({ value: message.value })
      else settleFromWorker({ failureClass: message.failureClass === 'invalid_json' ? 'invalid_json' : 'parse_worker_error' })
    }
    const onError = () => settleFromWorker({ failureClass: 'parse_worker_error' })
    const onMessageError = () => settleFromWorker({ failureClass: 'parse_worker_message_error' })
    const onExit = () => {
      if (!settled) settleFromWorker({ failureClass: 'parse_worker_error' })
    }

    worker.once('message', onMessage)
    worker.once('error', onError)
    worker.once('messageerror', onMessageError)
    worker.once('exit', onExit)
    timer = setTimer(() => settle({ failureClass: 'timeout' }), remainingAfterConstruction)
  })
}

function defaultWorkerFactory({ source, text }) {
  return new Worker(source, {
    eval: true,
    workerData: text,
    env: {},
    execArgv: [],
    stdin: false,
    stdout: false,
    stderr: false,
  })
}

function requestWorkerTermination(worker, {
  terminationTimeoutMs,
  setTimer,
  clearTimer,
  onCleanupFailure,
  operationId,
}) {
  const boundedOperationId = boundedToken(operationId, 'parse-worker-operation')
  const boundedTimeout = Number.isFinite(terminationTimeoutMs) && terminationTimeoutMs >= 0
    ? terminationTimeoutMs
    : 1_000
  let finished = false
  let timer = null
  const finish = (failureClass = null) => {
    if (finished) return
    finished = true
    if (timer !== null) clearTimer(timer)
    if (failureClass === null) return
    try {
      onCleanupFailure({
        stage: 'parse-worker-termination',
        failureClass,
        operationId: boundedOperationId,
      })
    } catch {
      // The bounded cleanup observer is isolated from public request settlement.
    }
  }

  let termination
  try {
    termination = Promise.resolve(worker.terminate())
  } catch {
    finish('termination-error')
    return
  }
  timer = setTimer(() => finish('termination-timeout'), boundedTimeout)
  termination.then(
    () => finish(),
    () => finish('termination-error'),
  )
}

export function parseRetryAfter(value, now = new Date()) {
  if (value === null || value === undefined || value === '') return null
  if (/^(?:0|[1-9]\d*)$/.test(value)) return Number(value) * 1000
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return Math.max(0, date.getTime() - now.getTime())
}

function backoffDelay(attempt, retryAfter, random, now) {
  const retryAfterMs = parseRetryAfter(retryAfter, now())
  if (retryAfterMs !== null) return Math.min(30_000, retryAfterMs)
  const base = Math.min(30_000, 2 ** (attempt + 1) * 1000)
  return Math.round(base * (0.75 + random() * 0.5))
}

function endpointSpec(scope, city, category, path) {
  const id = endpointId(scope, city, category)
  return { endpointId: id, scope, city, category, path, fileName: `${id}.json` }
}
function endpointId(scope, city, category) {
  return scope === 'intercity' ? `intercity-${category}` : `city-${city}-${category}`
}
export function createRawCacheEntry(spec, payload) {
  return {
    endpointId: spec.endpointId,
    scope: spec.scope,
    city: spec.city,
    category: spec.category,
    fileName: spec.fileName,
    contentHash: contentHash(payload),
    itemCount: payload.length,
    maxUpdateTime: payloadMaxUpdateTime(payload),
  }
}
function entryMatchesSpec(entry, spec) {
  return entry.scope === spec.scope
    && entry.city === spec.city
    && entry.category === spec.category
    && entry.fileName === spec.fileName
    && isCanonicalFileName(entry.fileName)
}
function isCanonicalFileName(value) {
  return typeof value === 'string'
    && SAFE_FILE_NAME.test(value)
    && basename(value) === value
    && !isAbsolute(value)
    && !value.split(/[\\/]/).some((part) => part === '.' || part === '..')
}
async function resolveManifestFile(root, fileName) {
  if (!isCanonicalFileName(fileName)) throw new TDXMeasurementError('Raw cache path is invalid', { failureClass: 'corrupt_cache' })
  const file = resolve(root, fileName)
  const rel = relative(root, file)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new TDXMeasurementError('Raw cache path escapes its root', { failureClass: 'corrupt_cache' })
  }
  await assertRegularFileNoSymlink(file, root)
  return file
}
async function assertDirectoryNoSymlink(path) {
  const stat = await lstat(path).catch(() => null)
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new TDXMeasurementError('Raw cache root is not a trusted directory', { failureClass: 'corrupt_cache' })
  }
}
async function assertRegularFileNoSymlink(path, root) {
  const stat = await lstat(path).catch(() => null)
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    throw new TDXMeasurementError('Raw cache entry is not a regular file', { failureClass: 'corrupt_cache' })
  }
  const resolvedRoot = await realpath(root)
  const resolvedFile = await realpath(path)
  const rel = relative(resolvedRoot, resolvedFile)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new TDXMeasurementError('Raw cache entry escapes its root', { failureClass: 'corrupt_cache' })
  }
}
async function assertMissing(path) {
  try {
    await lstat(path)
    throw new TDXMeasurementError('Raw cache target already exists', { failureClass: 'cache_target_exists' })
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
}
async function syncDirectory(path) {
  const handle = await open(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}
function payloadMaxUpdateTime(payload) {
  return payload.map((item) => typeof item?.UpdateTime === 'string' ? item.UpdateTime : null)
    .filter(Boolean).sort().at(-1) ?? null
}
function corruptCache(entry, message) {
  return new TDXMeasurementError(message, {
    endpointCategory: entry?.category ?? 'unknown',
    city: entry?.city ?? null,
    failureClass: 'corrupt_cache',
  })
}
function retryableMeasurementFailure(failureClass) {
  return ['timeout', 'parse_worker_error', 'parse_worker_message_error', 'parse_worker_termination_error'].includes(failureClass)
}
function classifyTransport(error) { return error?.name === 'AbortError' ? 'timeout' : 'transport' }
function classifyHttp(status) { return status === 429 ? 'rate_limited' : status >= 500 ? 'upstream_5xx' : 'upstream_4xx' }
function safeError(endpointCategory, city, httpStatus, failureClass, retryCount) {
  return new TDXMeasurementError('TDX measurement request failed', {
    endpointCategory, city, httpStatus, failureClass, retryCount,
  })
}
export function safeErrorRecord(error) {
  if (error instanceof TDXMeasurementError) return { ...error.details }
  if (error?.code === 'TDX_MEASUREMENT_ERROR' && error?.details) {
    return {
      ...error.details,
      ...(Array.isArray(error.cleanupFailures) ? { cleanupFailures: error.cleanupFailures } : {}),
    }
  }
  if (error?.code === 'UNSUPPORTED_MATCHER_REVISION') {
    return { endpointCategory: 'matcher', city: null, httpStatus: null, failureClass: 'unsupported_matcher_revision', retryCount: 0, timestamp: new Date().toISOString() }
  }
  if (error?.code === 'MEASUREMENT_COLLECTOR_ERROR') {
    return { endpointCategory: 'measurement', city: null, httpStatus: null, failureClass: 'collector_failure', retryCount: 0, timestamp: new Date().toISOString(), ...(Array.isArray(error.cleanupFailures) ? { cleanupFailures: error.cleanupFailures } : {}) }
  }
  if (error?.code === 'MEASUREMENT_CLEANUP_ERROR' || Array.isArray(error?.cleanupFailures)) {
    return { endpointCategory: 'measurement', city: null, httpStatus: null, failureClass: 'cleanup_failure', retryCount: 0, timestamp: new Date().toISOString(), ...(Array.isArray(error.cleanupFailures) ? { cleanupFailures: error.cleanupFailures } : {}) }
  }
  return { endpointCategory: 'unknown', city: null, httpStatus: null, failureClass: 'unexpected', retryCount: 0, timestamp: new Date().toISOString() }
}
export function assertRedacted(value, secrets) {
  const serialized = typeof value === 'string' ? value : stableStringify(value)
  for (const secret of ['Authorization', ...secrets.filter(Boolean)]) {
    if (serialized.includes(secret)) throw new Error('Sensitive value leaked into measurement output')
  }
}
function boundedToken(value, fallback) {
  if (typeof value !== 'string') return fallback
  const token = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
  return token || fallback
}
function plainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) }
async function mapConcurrent(items, concurrency, worker) {
  if (!Number.isSafeInteger(concurrency) || concurrency <= 0) throw new RangeError('concurrency must be positive')
  const results = new Array(items.length)
  let nextIndex = 0
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = nextIndex++
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  })
  const settlements = await Promise.allSettled(runners)
  const failure = settlements.find((entry) => entry.status === 'rejected')
  if (failure) throw failure.reason
  return results
}
