import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AwsClient } from 'aws4fetch'
import { loadOperationalResources } from '../instance/operational-resources.mjs'
import { readBoundedResponseJson } from './active-probe.mjs'
import { summarizeAuthorityWindow } from './capture-rollback-authority-evidence.mjs'
import { readManifestJson } from './manifest-read-limit.mjs'
import { parseContentLength } from './r2-metadata.mjs'
import {
  bindRollbackRoutingAuthority,
  readRollbackRoutingAuthority,
} from './rollback-routing-authority.mjs'
import { queryD1 } from './window-d1.mjs'

export const HIGH_CARD_RETIREMENT_REPORT_SCHEMA_VERSION = 1
const DEFAULT_REPORT_PATH = join('.transit-snapshot', 'high-card-retirement-readiness.json')
const STATE_MAX_BYTES = 64 * 1024
const SAFE_CITY = /^[A-Za-z][A-Za-z0-9]{0,63}$/
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const MAX_PUBLISHED_CITIES = 256

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
    const observed = await readWindow(item)
    const summary = summarizeAuthorityWindow(observed)
    if (summary.activeVersion !== item.activeVersion) {
      throw new Error(`Retirement readiness active pointer changed for ${item.city}`)
    }
    cities.push(Object.freeze({ city: item.city, ...summary }))
  }

  const blockingCities = cities
    .filter((city) => !city.rootBoundRollbackWindow)
    .map((city) => Object.freeze({
      city: city.city,
      activeVersion: city.activeVersion,
      previousVersion: city.previousVersion,
      activeAuthorityMode: city.activeAuthorityMode,
      previousAuthorityMode: city.previousAuthorityMode,
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

  const [activeMode, previousMode] = await Promise.all([
    readVersionAuthorityMode({ city, version: stateActive, r2 }),
    readVersionAuthorityMode({ city, version: previousVersion, r2 }),
  ])
  return { activeVersion: stateActive, previousVersion, activeMode, previousMode }
}

async function readVersionAuthorityMode({ city, version, r2 }) {
  const authority = await readRollbackRoutingAuthority({ city, version, r2 })
  const prefix = `snapshots/${version}/cities/${city}/`
  const manifest = await r2.getManifest(`${prefix}manifest.json`)
  if (!manifest) throw new Error(`Retirement readiness snapshot manifest is unavailable for ${city}`)
  return bindRollbackRoutingAuthority(manifest.artifacts, authority)
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
      ? report.blockingCities.map((city) => `| ${city.city} | ${city.activeAuthorityMode} | ${city.previousAuthorityMode} | ${city.nativeRootBoundPublicationsRequired} |`)
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
