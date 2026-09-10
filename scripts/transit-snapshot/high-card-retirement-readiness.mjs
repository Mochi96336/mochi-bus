import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AwsClient } from 'aws4fetch'
import { loadOperationalResources } from '../instance/operational-resources.mjs'
import { readBoundedResponseJson } from './active-probe.mjs'
import { readManifestJson } from './manifest-read-limit.mjs'
import { parseContentLength } from './r2-metadata.mjs'
import {
  routingCompletionManifestKeys,
} from './routing-authority-contract.mjs'
import {
  bindRollbackRoutingAuthority,
  readRollbackRoutingAuthority,
} from './rollback-routing-authority.mjs'
import { queryD1 } from './window-d1.mjs'

export const HIGH_CARD_RETIREMENT_REPORT_SCHEMA_VERSION = 2
const DEFAULT_REPORT_PATH = join('.transit-snapshot', 'high-card-retirement-readiness.json')
const STATE_MAX_BYTES = 64 * 1024
const SAFE_CITY = /^[A-Za-z][A-Za-z0-9]{0,63}$/
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const MAX_PUBLISHED_CITIES = 256
const COMPLETE_ROUTING_MANIFEST_COUNT = 4
const AUTHORITY_MODES = new Set(['legacy-d1', 'legacy-partial', 'legacy-backfill', 'root-bound'])

export async function collectHighCardRetirementReadiness({
  env = process.env,
  now = () => new Date(),
  listPublishedVersions = () => readPublishedVersions(env),
  readWindow = ({ city, activeVersion }) => readAuthorityWindow({ city, activeVersion, env }),
} = {}) {
  const published = normalizePublishedVersions(await listPublishedVersions())
  const cities = []

  // Read sequentially on purpose. This proof is operator evidence, not a latency-
  // sensitive request path, and bounded sequential R2 reads avoid creating a
  // burst across every retained city merely to decide whether cleanup is safe.
  for (const item of published) {
    const observed = summarizeRetainedAuthorityWindow(await readWindow(item))
    if (observed.activeVersion !== item.activeVersion) {
      throw new Error(`Retirement readiness active pointer changed for ${item.city}`)
    }
    cities.push(Object.freeze({ city: item.city, ...observed }))
  }

  const blockingCities = cities
    .filter((city) => !city.rootBoundRollbackWindow)
    .map((city) => Object.freeze({
      city: city.city,
      activeVersion: city.activeVersion,
      previousVersion: city.previousVersion,
      activeAuthorityMode: city.activeAuthorityMode,
      previousAuthorityMode: city.previousAuthorityMode,
      activeRoutingManifestCount: city.activeRoutingManifestCount,
      previousRoutingManifestCount: city.previousRoutingManifestCount,
      nativeRootBoundPublicationsRequired: city.nativeRootBoundPublicationsRequired,
    }))

  return Object.freeze({
    schemaVersion: HIGH_CARD_RETIREMENT_REPORT_SCHEMA_VERSION,
    kind: 'snapshot-high-card-d1-retirement-readiness',
    sourceCommit: safeText(env.GITHUB_SHA),
    workflowRunId: safeText(env.GITHUB_RUN_ID),
    workflowRunAttempt: safeText(env.GITHUB_RUN_ATTEMPT),
    generatedAt: now().toISOString(),
    cityCount: cities.length,
    rootBoundCityCount: cities.length - blockingCities.length,
    rootBoundAuthorityReady: blockingCities.length === 0,
    blockingCities: Object.freeze(blockingCities),
    cities: Object.freeze(cities),
  })
}

export function summarizeRetainedAuthorityWindow({
  activeVersion,
  previousVersion,
  activeAuthority,
  previousAuthority,
} = {}) {
  const active = normalizeAuthorityAssessment(activeAuthority, 'active')
  const previous = normalizeAuthorityAssessment(previousAuthority, 'previous')
  if (!safeId(activeVersion) || !safeId(previousVersion) || activeVersion === previousVersion) {
    throw new Error('Retirement readiness requires a distinct safe retained window')
  }
  const rootBoundRollbackWindow = active.mode === 'root-bound' && previous.mode === 'root-bound'
  const nativeRootBoundPublicationsRequired = active.mode === 'root-bound'
    ? (previous.mode === 'root-bound' ? 0 : 1)
    : 2
  return Object.freeze({
    activeVersion,
    previousVersion,
    activeAuthorityMode: active.mode,
    previousAuthorityMode: previous.mode,
    rollbackTargetAuthorityMode: previous.mode,
    activeRoutingManifestCount: active.routingManifestCount,
    previousRoutingManifestCount: previous.routingManifestCount,
    rootBoundRollbackWindow,
    nativeRootBoundPublicationsRequired,
  })
}

export function classifyRoutingAuthorityPresence({ keys, heads, manifestArtifacts } = {}) {
  if (!Array.isArray(keys) || keys.length !== COMPLETE_ROUTING_MANIFEST_COUNT
    || !Array.isArray(heads) || heads.length !== keys.length) {
    throw new Error('Retirement readiness routing authority observation is invalid')
  }
  const presentCount = heads.filter(Boolean).length
  const rootArtifacts = new Set(Array.isArray(manifestArtifacts)
    ? manifestArtifacts.map((entry) => entry?.key).filter((key) => typeof key === 'string')
    : [])
  const rootBindingCount = keys.filter((key) => rootArtifacts.has(key)).length

  if (rootBindingCount !== 0 && rootBindingCount !== keys.length) {
    throw new Error('Retirement readiness root manifest has a partial routing authority binding')
  }
  if (rootBindingCount === keys.length && presentCount !== keys.length) {
    throw new Error('Retirement readiness root-bound routing authority is missing')
  }
  if (presentCount === 0) {
    return Object.freeze({ mode: 'legacy-d1', routingManifestCount: 0 })
  }
  if (presentCount < keys.length) {
    return Object.freeze({ mode: 'legacy-partial', routingManifestCount: presentCount })
  }
  return null
}

export function normalizePublishedVersions(rows) {
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > MAX_PUBLISHED_CITIES) {
    throw new Error('Retirement readiness requires a bounded non-empty published city set')
  }
  const seen = new Set()
  const normalized = rows.map((row) => {
    const city = safeCity(row?.city_code)
    const activeVersion = safeId(row?.active_version)
    if (!city || !activeVersion || seen.has(city)) {
      throw new Error('Retirement readiness published city set is invalid')
    }
    seen.add(city)
    return Object.freeze({ city, activeVersion })
  })
  normalized.sort((left, right) => left.city.localeCompare(right.city))
  return Object.freeze(normalized)
}

async function readPublishedVersions(env) {
  const resources = loadOperationalResources()
  return queryD1({
    accountId: required(env.CLOUDFLARE_ACCOUNT_ID, 'CLOUDFLARE_ACCOUNT_ID'),
    apiToken: required(env.CLOUDFLARE_API_TOKEN, 'CLOUDFLARE_API_TOKEN'),
    databaseId: required(env.TRANSIT_DATABASE_ID ?? resources.d1DatabaseId, 'TRANSIT_DATABASE_ID'),
    fetchImpl: fetch,
    sql: 'SELECT city_code, active_version FROM dataset_versions ORDER BY city_code',
    params: [],
  })
}

async function readAuthorityWindow({ city, activeVersion, env }) {
  const resources = loadOperationalResources()
  const accountId = required(env.CLOUDFLARE_ACCOUNT_ID, 'CLOUDFLARE_ACCOUNT_ID')
  const bucket = required(env.TRANSIT_R2_BUCKET_NAME ?? resources.r2BucketName, 'TRANSIT_R2_BUCKET_NAME')
  const accessKeyId = required(env.R2_ACCESS_KEY_ID, 'R2_ACCESS_KEY_ID')
  const secretAccessKey = required(env.R2_SECRET_ACCESS_KEY, 'R2_SECRET_ACCESS_KEY')
  const r2 = createR2Adapter({ accountId, bucket, accessKeyId, secretAccessKey })
  const state = await r2.getJson(`snapshots/state/${city}.json`, STATE_MAX_BYTES)
  const stateActive = safeId(state?.version)
  const previousVersion = safeId(state?.previousVersion)
  if (!stateActive || !previousVersion || stateActive !== activeVersion || stateActive === previousVersion) {
    throw new Error(`Retirement readiness found an invalid or mismatched retained window for ${city}`)
  }

  const [activeAuthority, previousAuthority] = await Promise.all([
    readVersionAuthorityAssessment({ city, version: stateActive, r2 }),
    readVersionAuthorityAssessment({ city, version: previousVersion, r2 }),
  ])
  return { activeVersion: stateActive, previousVersion, activeAuthority, previousAuthority }
}

async function readVersionAuthorityAssessment({ city, version, r2 }) {
  const keys = routingCompletionManifestKeys(version, city)
  const prefix = `snapshots/${version}/cities/${city}/`
  const [heads, manifest] = await Promise.all([
    Promise.all(keys.map((key) => r2.head(key))),
    r2.getManifest(`${prefix}manifest.json`),
  ])
  if (!manifest) throw new Error(`Retirement readiness snapshot manifest is unavailable for ${city}`)

  const preclassified = classifyRoutingAuthorityPresence({
    keys,
    heads,
    manifestArtifacts: manifest.artifacts,
  })
  if (preclassified) return preclassified

  // A complete set must still pass the production rollback authority parser,
  // sample fingerprint check, and root-binding check before it can be called
  // legacy-backfill or root-bound. Presence alone never upgrades authority.
  const authority = await readRollbackRoutingAuthority({ city, version, r2 })
  const mode = bindRollbackRoutingAuthority(manifest.artifacts, authority)
  return Object.freeze({ mode, routingManifestCount: COMPLETE_ROUTING_MANIFEST_COUNT })
}

function normalizeAuthorityAssessment(value, role) {
  const mode = value?.mode
  const count = value?.routingManifestCount
  if (!AUTHORITY_MODES.has(mode) || !Number.isSafeInteger(count) || count < 0 || count > COMPLETE_ROUTING_MANIFEST_COUNT) {
    throw new Error(`Retirement readiness ${role} authority assessment is invalid`)
  }
  if ((mode === 'legacy-d1' && count !== 0)
    || (mode === 'legacy-partial' && (count === 0 || count === COMPLETE_ROUTING_MANIFEST_COUNT))
    || ((mode === 'legacy-backfill' || mode === 'root-bound') && count !== COMPLETE_ROUTING_MANIFEST_COUNT)) {
    throw new Error(`Retirement readiness ${role} authority assessment is inconsistent`)
  }
  return Object.freeze({ mode, routingManifestCount: count })
}

function createR2Adapter({ accountId, bucket, accessKeyId, secretAccessKey }) {
  const client = new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' })
  const baseUrl = `https://${accountId}.r2.cloudflarestorage.com/${bucket}`
  const objectUrl = (key) => `${baseUrl}/${key.split('/').map(encodeURIComponent).join('/')}`

  async function head(key) {
    const response = await client.fetch(objectUrl(key), { method: 'HEAD' })
    await response.body?.cancel().catch(() => undefined)
    if (response.status === 404) return null
    if (!response.ok) throw new Error('Retirement readiness R2 metadata read failed')
    return { size: parseContentLength(response.headers.get('Content-Length')) }
  }

  async function getJson(key, maximumBytes) {
    const response = await client.fetch(objectUrl(key))
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined)
      return null
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error('Retirement readiness R2 JSON read failed')
    }
    return readBoundedResponseJson(response, maximumBytes)
  }

  async function getBytes(key, maximumBytes) {
    const response = await client.fetch(objectUrl(key))
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined)
      return null
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error('Retirement readiness R2 artifact read failed')
    }
    return readBoundedBytes(response, maximumBytes)
  }

  return Object.freeze({
    head,
    getJson,
    getBytes,
    getManifest: (key) => readManifestJson({ key, head, getJson }),
  })
}

async function readBoundedBytes(response, maximumBytes) {
  const declared = parseContentLength(response.headers.get('Content-Length'))
  if (declared !== null && declared > maximumBytes) {
    await response.body.cancel().catch(() => undefined)
    throw new Error('Retirement readiness R2 artifact exceeded declared byte limit')
  }
  const reader = response.body.getReader()
  const chunks = []
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > maximumBytes) throw new Error('Retirement readiness R2 artifact exceeded read byte limit')
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  const merged = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return merged
}

async function writeReport(report, env) {
  const path = env.SNAPSHOT_HIGH_CARD_RETIREMENT_REPORT || DEFAULT_REPORT_PATH
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  if (env.GITHUB_STEP_SUMMARY) {
    const blockerRows = report.blockingCities.length
      ? report.blockingCities.map((city) => `| ${city.city} | ${city.activeAuthorityMode} (${city.activeRoutingManifestCount}/4) | ${city.previousAuthorityMode} (${city.previousRoutingManifestCount}/4) | ${city.nativeRootBoundPublicationsRequired} |`)
      : ['| — | — | — | 0 |']
    await appendFile(env.GITHUB_STEP_SUMMARY, [
      '## Legacy high-card D1 retirement authority readiness',
      '',
      `Published cities: ${report.cityCount}; root-bound retained windows: ${report.rootBoundCityCount}; authority ready: ${report.rootBoundAuthorityReady}.`,
      '',
      '> This proves only the retained rollback-authority prerequisite. Cleanup still requires the separate #249 acceptance evidence and explicit mutation authorization.',
      '',
      '| Blocking city | Active authority | Previous authority | Native publications still required |',
      '| --- | --- | --- | ---: |',
      ...blockerRows,
      '',
    ].join('\n'))
  }
  return path
}

async function main(env = process.env) {
  const report = await collectHighCardRetirementReadiness({ env })
  const reportPath = await writeReport(report, env)
  console.log(JSON.stringify({
    event: 'snapshot_high_card_retirement_readiness',
    reportPath,
    cityCount: report.cityCount,
    rootBoundCityCount: report.rootBoundCityCount,
    rootBoundAuthorityReady: report.rootBoundAuthorityReady,
    blockingCities: report.blockingCities.map((city) => ({
      city: city.city,
      activeAuthorityMode: city.activeAuthorityMode,
      previousAuthorityMode: city.previousAuthorityMode,
      activeRoutingManifestCount: city.activeRoutingManifestCount,
      previousRoutingManifestCount: city.previousRoutingManifestCount,
      nativeRootBoundPublicationsRequired: city.nativeRootBoundPublicationsRequired,
    })),
  }))
}

function safeCity(value) {
  return typeof value === 'string' && SAFE_CITY.test(value) ? value : null
}

function safeId(value) {
  return typeof value === 'string' && SAFE_ID.test(value) ? value : null
}

function safeText(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,160}$/.test(value) ? value : null
}

function required(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`)
  return value.trim()
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify({
      event: 'snapshot_high_card_retirement_readiness_failed',
      message: error instanceof Error ? error.message : String(error),
    }))
    process.exitCode = 1
  })
}
