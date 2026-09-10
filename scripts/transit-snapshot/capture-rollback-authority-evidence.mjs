import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AwsClient } from 'aws4fetch'
import { loadOperationalResources } from '../instance/operational-resources.mjs'
import { readBoundedResponseJson } from './active-probe.mjs'
import { readManifestJson } from './manifest-read-limit.mjs'
import { parseContentLength } from './r2-metadata.mjs'
import {
  bindRollbackRoutingAuthority,
  readRollbackRoutingAuthority,
} from './rollback-routing-authority.mjs'
import { queryD1 } from './window-d1.mjs'

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const STATE_MAX_BYTES = 64 * 1024
const AUTHORITY_MODES = new Set(['legacy-d1', 'legacy-backfill', 'root-bound'])

export function nativeRootBoundPublicationsRequired(activeMode, previousMode) {
  if (!AUTHORITY_MODES.has(activeMode) || !AUTHORITY_MODES.has(previousMode)) {
    throw new Error('Rollback authority evidence returned an unknown authority mode')
  }
  if (activeMode !== 'root-bound') return 2
  return previousMode === 'root-bound' ? 0 : 1
}

export function summarizeAuthorityWindow({ activeVersion, previousVersion, activeMode, previousMode }) {
  if (!safeId(activeVersion) || !safeId(previousVersion) || activeVersion === previousVersion) {
    throw new Error('Rollback authority evidence requires distinct safe active and previous versions')
  }
  if (!AUTHORITY_MODES.has(activeMode) || !AUTHORITY_MODES.has(previousMode)) {
    throw new Error('Rollback authority evidence returned an unknown authority mode')
  }
  return Object.freeze({
    activeVersion,
    previousVersion,
    activeAuthorityMode: activeMode,
    previousAuthorityMode: previousMode,
    rollbackTargetAuthorityMode: previousMode,
    rootBoundRollbackWindow: activeMode === 'root-bound' && previousMode === 'root-bound',
    nativeRootBoundPublicationsRequired: nativeRootBoundPublicationsRequired(activeMode, previousMode),
  })
}

export async function captureRollbackAuthorityEvidence({
  city = 'Taichung',
  env = process.env,
  now = () => new Date(),
  readWindow = () => createWindowReader({ city, env })(),
  reportPath = env.ROLLBACK_AUTHORITY_EVIDENCE_REPORT ?? 'rollback-authority-evidence.json',
} = {}) {
  if (city !== 'Taichung') throw new Error('Rollback authority evidence is intentionally restricted to Taichung')
  const window = summarizeAuthorityWindow(await readWindow())
  const report = Object.freeze({
    schemaVersion: 1,
    kind: 'snapshot-rollback-authority-window',
    city,
    sourceCommit: safeText(env.GITHUB_SHA),
    workflowRunId: safeText(env.GITHUB_RUN_ID),
    workflowRunAttempt: safeText(env.GITHUB_RUN_ATTEMPT),
    capturedAt: now().toISOString(),
    ...window,
  })
  await writeReport(reportPath, report)
  return report
}

function createWindowReader({ city, env }) {
  const resources = loadOperationalResources()
  const accountId = required(env.CLOUDFLARE_ACCOUNT_ID, 'CLOUDFLARE_ACCOUNT_ID')
  const apiToken = required(env.CLOUDFLARE_API_TOKEN, 'CLOUDFLARE_API_TOKEN')
  const databaseId = required(env.TRANSIT_DATABASE_ID ?? resources.d1DatabaseId, 'TRANSIT_DATABASE_ID')
  const bucket = required(env.TRANSIT_R2_BUCKET_NAME ?? resources.r2BucketName, 'TRANSIT_R2_BUCKET_NAME')
  const accessKeyId = required(env.R2_ACCESS_KEY_ID, 'R2_ACCESS_KEY_ID')
  const secretAccessKey = required(env.R2_SECRET_ACCESS_KEY, 'R2_SECRET_ACCESS_KEY')
  const r2 = createR2Adapter({ accountId, bucket, accessKeyId, secretAccessKey })

  return async function readWindow() {
    const [authorityRows, state] = await Promise.all([
      queryD1({
        accountId,
        apiToken,
        databaseId,
        fetchImpl: fetch,
        sql: 'SELECT active_version FROM dataset_versions WHERE city_code = ? LIMIT 1',
        params: [city],
      }),
      r2.getJson(`snapshots/state/${city}.json`, STATE_MAX_BYTES),
    ])
    const d1Active = safeId(authorityRows[0]?.active_version)
    const activeVersion = safeId(state?.version)
    const previousVersion = safeId(state?.previousVersion)
    if (!d1Active || !activeVersion || !previousVersion || d1Active !== activeVersion) {
      throw new Error('Rollback authority evidence found an invalid or mismatched active pointer')
    }

    const [activeMode, previousMode] = await Promise.all([
      readVersionAuthorityMode({ city, version: activeVersion, r2 }),
      readVersionAuthorityMode({ city, version: previousVersion, r2 }),
    ])
    return { activeVersion, previousVersion, activeMode, previousMode }
  }
}

async function readVersionAuthorityMode({ city, version, r2 }) {
  const authority = await readRollbackRoutingAuthority({ city, version, r2 })
  const prefix = `snapshots/${version}/cities/${city}/`
  const manifest = await r2.getManifest(`${prefix}manifest.json`)
  if (!manifest) throw new Error('Rollback authority evidence snapshot manifest is unavailable')
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
    if (!response.ok) throw new Error('Rollback authority evidence R2 metadata read failed')
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
      throw new Error('Rollback authority evidence R2 JSON read failed')
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
      throw new Error('Rollback authority evidence R2 artifact read failed')
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
    throw new Error('Rollback authority evidence R2 artifact exceeded declared byte limit')
  }
  const reader = response.body.getReader()
  const chunks = []
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > maximumBytes) {
        throw new Error('Rollback authority evidence R2 artifact exceeded read byte limit')
      }
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

async function writeReport(path, report) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
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

async function main() {
  const city = process.argv[2] ?? 'Taichung'
  try {
    const report = await captureRollbackAuthorityEvidence({ city })
    console.log(JSON.stringify({
      event: 'snapshot_rollback_authority_evidence',
      city: report.city,
      activeVersion: report.activeVersion,
      previousVersion: report.previousVersion,
      rollbackTargetAuthorityMode: report.rollbackTargetAuthorityMode,
      rootBoundRollbackWindow: report.rootBoundRollbackWindow,
      nativeRootBoundPublicationsRequired: report.nativeRootBoundPublicationsRequired,
    }))
  } catch (error) {
    console.error(JSON.stringify({
      event: 'snapshot_rollback_authority_evidence_failed',
      city: city === 'Taichung' ? city : null,
      message: error instanceof Error ? error.message : String(error),
    }))
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
