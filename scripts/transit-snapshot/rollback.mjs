import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { loadOperationalResources } from '../instance/operational-resources.mjs'
import { assertArtifactIntegrity } from './artifact-integrity.mjs'
import { readManifestJson } from './manifest-read-limit.mjs'
import { executeReconcile, executeRollback, safeOperationDiagnostic } from './rollback-operations.mjs'
import { networkPrefixMatches, readBoundedResponseJson, readBoundedResponseText } from './active-probe.mjs'
import { parseContentLength } from './r2-metadata.mjs'

const operationalResources = loadOperationalResources()
const DATABASE = process.env.TRANSIT_D1_DATABASE_NAME ?? operationalResources.d1DatabaseName
const BUCKET = process.env.TRANSIT_R2_BUCKET_NAME ?? operationalResources.r2BucketName
const PUBLIC_ORIGIN = process.env.SNAPSHOT_SMOKE_BASE_URL ?? operationalResources.publicOrigin
const MAX_EXACT_ARTIFACT_BYTES = 16 * 1024 * 1024
const PUBLIC_JSON_LIMIT = 2 * 1024 * 1024

await main()

async function main() {
  const parsed = parseArguments(process.argv.slice(2))
  if (!parsed) {
    console.error(JSON.stringify({
      event: 'snapshot_authority_operation', operation: 'unknown', city: null,
      outcome: 'invalid_arguments', activeVersion: null, previousVersion: null, targetVersion: null,
    }))
    process.exitCode = 1
    return
  }
  const { operation, city } = parsed
  try {
    const vars = await loadVariables()
    const r2 = await createR2Adapter(vars)
    const stateKey = `snapshots/state/${city}.json`
    const options = {
      city,
      readAuthority: () => readAuthority(city),
      readState: () => r2.getJson(stateKey),
      validateVersion: (version) => validateVersion({ city, version, r2 }),
      writeState: (state) => r2.putJson(stateKey, state),
    }
    const result = operation === 'rollback'
      ? await executeRollback({
        ...options,
        targetVersion: parsed.targetVersion,
        transition: ({ expectedVersion, targetVersion }) => transitionAuthority(city, expectedVersion, targetVersion),
        smoke: ({ version, evidence }) => smokeVersion({ city, version, evidence, baseUrl: PUBLIC_ORIGIN }),
      })
      : await executeReconcile({ ...options, explicitPrevious: parsed.previousVersion })
    console.log(JSON.stringify({ event: 'snapshot_authority_operation', ...result }))
  } catch (error) {
    console.error(JSON.stringify(safeOperationDiagnostic(error, operation, city)))
    process.exitCode = 1
  }
}

function parseArguments(args) {
  if (args.some((arg) => arg.startsWith('--'))) return null
  if (args[0] === 'reconcile') {
    if (!safeIdentifier(args[1]) || args.length > 3) return null
    return { operation: 'reconcile', city: args[1], previousVersion: args[2] }
  }
  if (!safeIdentifier(args[0]) || args.length > 2) return null
  return { operation: 'rollback', city: args[0], targetVersion: args[1] }
}

async function loadVariables() {
  const [snapshotVars, workerVars] = await Promise.all([
    readVars('.snapshot.env'),
    readVars('.dev.vars'),
  ])
  return { ...workerVars, ...snapshotVars, ...process.env }
}

async function createR2Adapter(vars) {
  const accountId = vars.CLOUDFLARE_ACCOUNT_ID
  const accessKeyId = vars.R2_ACCESS_KEY_ID
  const secretAccessKey = vars.R2_SECRET_ACCESS_KEY
  if (!accountId || !accessKeyId || !secretAccessKey) throw new Error('Snapshot credentials unavailable')
  const { AwsClient } = await import('aws4fetch')
  const client = new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' })
  const baseUrl = `https://${accountId}.r2.cloudflarestorage.com/${BUCKET}`
  const objectUrl = (key) => `${baseUrl}/${key.split('/').map(encodeURIComponent).join('/')}`

  async function head(key) {
    const response = await client.fetch(objectUrl(key), { method: 'HEAD' })
    await response.body?.cancel().catch(() => undefined)
    if (response.status === 404) return null
    if (!response.ok) throw new Error('R2 metadata read failed')
    return { size: parseContentLength(response.headers.get('Content-Length')) }
  }

  async function getJson(key, maximumBytes = 1024 * 1024) {
    const response = await client.fetch(objectUrl(key))
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined)
      return null
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error('R2 JSON read failed')
    }
    return readBoundedResponseJson(response, maximumBytes)
  }

  async function readPrefix(key, maximumBytes) {
    const response = await client.fetch(objectUrl(key), {
      headers: { Range: `bytes=0-${maximumBytes - 1}` },
    })
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error('R2 prefix read failed')
    }
    return readBoundedResponseText(response, maximumBytes)
  }

  async function getBytes(key, maximumBytes) {
    const response = await client.fetch(objectUrl(key))
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error('R2 artifact read failed')
    }
    return readBoundedBytes(response, maximumBytes)
  }

  async function putJson(key, value) {
    const response = await client.fetch(objectUrl(key), {
      method: 'PUT',
      body: JSON.stringify(value),
      headers: { 'Content-Type': 'application/json' },
    })
    await response.body?.cancel().catch(() => undefined)
    if (!response.ok) throw new Error('R2 state write failed')
  }

  return Object.freeze({
    head,
    getJson,
    getManifest: (key) => readManifestJson({ key, head, getJson }),
    readPrefix,
    getBytes,
    putJson,
  })
}

function readAuthority(city) {
  const result = queryD1(`SELECT active_version, imported_at FROM dataset_versions WHERE city_code=${sql(city)} LIMIT 1`)
  const row = result[0]?.results?.[0]
  return {
    activeVersion: typeof row?.active_version === 'string' ? row.active_version : null,
    importedAt: typeof row?.imported_at === 'string' ? row.imported_at : null,
  }
}

function transitionAuthority(city, expectedVersion, targetVersion) {
  const importedAt = new Date().toISOString()
  const result = queryD1(`UPDATE dataset_versions
SET active_version=${sql(targetVersion)}, imported_at=${sql(importedAt)}
WHERE city_code=${sql(city)} AND active_version=${sql(expectedVersion)}
RETURNING active_version`)
  return result[0]?.results?.[0]?.active_version === targetVersion
}

async function validateVersion({ city, version, r2 }) {
  const result = queryD1([
    `SELECT
      (SELECT COUNT(*) FROM routes WHERE version=${sql(version)} AND city_code=${sql(city)}) AS routes,
      (SELECT COUNT(*) FROM patterns WHERE version=${sql(version)} AND city_code=${sql(city)}) AS patterns,
      (SELECT COUNT(*) FROM stops WHERE version=${sql(version)} AND city_code=${sql(city)}) AS stops,
      (SELECT COUNT(*) FROM stop_places WHERE version=${sql(version)} AND city_code=${sql(city)}) AS places,
      (SELECT COUNT(*) FROM pattern_stops ps JOIN patterns p ON p.version=ps.version AND p.pattern_id=ps.pattern_id
        WHERE ps.version=${sql(version)} AND p.city_code=${sql(city)}) AS pattern_stops`,
    `SELECT
      (SELECT COUNT(*) FROM patterns p LEFT JOIN routes r
        ON r.version=p.version AND r.city_code=p.city_code AND r.route_uid=p.route_uid
        WHERE p.version=${sql(version)} AND p.city_code=${sql(city)} AND r.route_uid IS NULL)
      + (SELECT COUNT(*) FROM stops s LEFT JOIN stop_places sp
        ON sp.version=s.version AND sp.city_code=s.city_code AND sp.place_id=s.place_id
        WHERE s.version=${sql(version)} AND s.city_code=${sql(city)} AND sp.place_id IS NULL)
      + (SELECT COUNT(*) FROM pattern_stops ps
        LEFT JOIN patterns p ON p.version=ps.version AND p.pattern_id=ps.pattern_id
        LEFT JOIN stops s ON s.version=ps.version AND s.stop_uid=ps.stop_uid
        LEFT JOIN stop_places sp ON sp.version=ps.version AND sp.place_id=ps.place_id
        WHERE ps.version=${sql(version)} AND (p.pattern_id IS NULL OR s.stop_uid IS NULL OR sp.place_id IS NULL)) AS count`,
    `SELECT COUNT(*) AS count FROM (
      SELECT p.pattern_id FROM patterns p
      LEFT JOIN pattern_stops ps ON ps.version=p.version AND ps.pattern_id=p.pattern_id
      WHERE p.version=${sql(version)} AND p.city_code=${sql(city)}
      GROUP BY p.pattern_id HAVING COUNT(ps.stop_uid) < 2
    )`,
    `SELECT COUNT(*) AS count FROM routes r
      WHERE r.version=${sql(version)} AND r.city_code=${sql(city)}
      AND NOT EXISTS (SELECT 1 FROM patterns p
        WHERE p.version=r.version AND p.city_code=r.city_code AND p.route_uid=r.route_uid)`,
    `SELECT COUNT(*) AS count FROM pattern_stops ps
      JOIN patterns p ON p.version=ps.version AND p.pattern_id=ps.pattern_id
      JOIN stops s ON s.version=ps.version AND s.stop_uid=ps.stop_uid
      WHERE ps.version=${sql(version)} AND p.city_code=${sql(city)} AND ps.place_id <> s.place_id`,
    `SELECT p.pattern_id, p.route_uid, r.route_name, p.shape_key,
      (SELECT ps.place_id FROM pattern_stops ps
        WHERE ps.version=p.version AND ps.pattern_id=p.pattern_id
        ORDER BY ps.stop_sequence, ps.place_id LIMIT 1) AS place_id
      FROM patterns p
      JOIN routes r ON r.version=p.version AND r.city_code=p.city_code AND r.route_uid=p.route_uid
      WHERE p.version=${sql(version)} AND p.city_code=${sql(city)}
      AND EXISTS (SELECT 1 FROM pattern_stops ps WHERE ps.version=p.version AND ps.pattern_id=p.pattern_id)
      ORDER BY p.pattern_id, p.route_uid LIMIT 1`,
  ].join(';'))
  const countRow = result[0]?.results?.[0]
  const sample = result[5]?.results?.[0]
  if (!countRow || !sample || !['pattern_id', 'route_uid', 'route_name', 'shape_key', 'place_id']
    .every((field) => typeof sample[field] === 'string' && sample[field].length > 0)) {
    throw new Error('Snapshot validation evidence unavailable')
  }
  const counts = {
    routes: Number(countRow.routes),
    patterns: Number(countRow.patterns),
    stops: Number(countRow.stops),
    places: Number(countRow.places),
    patternStops: Number(countRow.pattern_stops),
  }
  const integrity = {
    dangling: Number(result[1]?.results?.[0]?.count),
    shortPatterns: Number(result[2]?.results?.[0]?.count),
    orphanRoutes: Number(result[3]?.results?.[0]?.count),
    placeMismatches: Number(result[4]?.results?.[0]?.count),
  }
  const prefix = `snapshots/${version}/cities/${city}/`
  const manifest = await r2.getManifest(`${prefix}manifest.json`)
  if (!manifest) throw new Error('Snapshot manifest unavailable')
  const byKey = new Map(Array.isArray(manifest.artifacts)
    ? manifest.artifacts.map((artifact) => [artifact?.key, artifact]) : [])
  const networkVerified = await verifyNetwork({
    city, version, r2, artifact: byKey.get(`${prefix}network.json`), key: `${prefix}network.json`,
  })
  const exactArtifacts = [
    [sample.shape_key, byKey.get(sample.shape_key)],
    [`${prefix}schedules/${sample.route_uid}.json`, byKey.get(`${prefix}schedules/${sample.route_uid}.json`)],
    [`${prefix}places/${sample.place_id}.json`, byKey.get(`${prefix}places/${sample.place_id}.json`)],
  ]
  for (const [key, artifact] of exactArtifacts) await verifyExactArtifact(r2, key, artifact)
  return {
    city, version, counts, integrity, manifest,
    networkVerified,
    sampleArtifactsVerified: true,
    sample: Object.freeze({
      patternId: sample.pattern_id,
      routeUid: sample.route_uid,
      routeName: sample.route_name,
      placeId: sample.place_id,
    }),
  }
}

async function verifyNetwork({ city, version, r2, artifact, key }) {
  if (!validArtifact(artifact, key)) return false
  const metadata = await r2.head(key)
  if (!metadata || (metadata.size !== null && metadata.size !== artifact.bytes)) return false
  const prefix = await r2.readPrefix(key, 65_536)
  return networkPrefixMatches(prefix, city, version)
}

async function verifyExactArtifact(r2, key, artifact) {
  if (!validArtifact(artifact, key) || artifact.bytes > MAX_EXACT_ARTIFACT_BYTES) {
    throw new Error('Snapshot exact artifact metadata invalid')
  }
  const body = await r2.getBytes(key, artifact.bytes)
  assertArtifactIntegrity(artifact, body)
}

function validArtifact(artifact, key) {
  return artifact?.key === key
    && Number.isSafeInteger(artifact.bytes) && artifact.bytes > 0
    && typeof artifact.sha256 === 'string' && /^[a-f0-9]{64}$/.test(artifact.sha256)
}

async function smokeVersion({ city, version, evidence, baseUrl }) {
  if (!baseUrl) throw new Error('Snapshot rollback smoke requires a fixed public origin')
  let succeeded = false
  for (let attempt = 1; attempt <= 12 && !succeeded; attempt += 1) {
    try {
      const cacheBust = `snapshot=${encodeURIComponent(version)}`
      const routes = await fetchPublicJson(baseUrl, `/api/v1/map/routes?city=${encodeURIComponent(city)}&${cacheBust}`)
      if (routes?.source !== 'snapshot' || routes?.snapshotVersion !== version
        || !Array.isArray(routes.routes) || routes.routes.length !== evidence.counts.routes) throw new Error('routes')
      const route = await fetchPublicJson(baseUrl,
        `/api/v1/map/route?city=${encodeURIComponent(city)}&route=${encodeURIComponent(evidence.sample.routeName)}&routeUid=${encodeURIComponent(evidence.sample.routeUid)}&patternId=${encodeURIComponent(evidence.sample.patternId)}&${cacheBust}`)
      const variant = Array.isArray(route?.variants)
        ? route.variants.find((item) => item?.variantKey === evidence.sample.patternId
          && item?.routeUid === evidence.sample.routeUid) : null
      if (route?.source !== 'snapshot' || route?.snapshotVersion !== version
        || !variant || !Array.isArray(variant.stops?.features) || variant.stops.features.length < 2) throw new Error('route')
      const place = await fetchPublicJson(baseUrl,
        `/api/v1/map/place/${encodeURIComponent(evidence.sample.placeId)}/arrivals?city=${encodeURIComponent(city)}&${cacheBust}`)
      if (place?.snapshotVersion !== version || place?.scheduleSource !== 'place-bundle'
        || !Array.isArray(place.routes)
        || !place.routes.some((item) => item?.variantKey === evidence.sample.patternId
          && item?.routeUid === evidence.sample.routeUid)) throw new Error('place')
      await verifyPublicNetwork(baseUrl, city, version)
      succeeded = true
    } catch {
      if (attempt < 12) await new Promise((resolve) => setTimeout(resolve, 10_000))
    }
  }
  if (!succeeded) throw new Error('Snapshot public smoke failed')
}

async function fetchPublicJson(baseUrl, path) {
  const response = await fetch(new URL(path, baseUrl), {
    cache: 'no-store', signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error('Snapshot public request failed')
  }
  return readBoundedResponseJson(response, PUBLIC_JSON_LIMIT)
}

async function verifyPublicNetwork(baseUrl, city, version) {
  const response = await fetch(new URL(
    `/api/v1/map/network?city=${encodeURIComponent(city)}&snapshot=${encodeURIComponent(version)}`,
    baseUrl,
  ), { cache: 'no-store', signal: AbortSignal.timeout(10_000) })
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error('Snapshot public network failed')
  }
  const prefix = await readResponsePrefix(response, 65_536)
  if (!networkPrefixMatches(prefix, city, version)) throw new Error('Snapshot public network version mismatch')
}

async function readResponsePrefix(response, maximumBytes) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let bytes = 0
  try {
    while (bytes < maximumBytes) {
      const { done, value } = await reader.read()
      if (done) break
      const remaining = maximumBytes - bytes
      const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value
      bytes += chunk.byteLength
      text += decoder.decode(chunk, { stream: true })
      if (networkMetadataComplete(text)) break
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  return text
}

function networkMetadataComplete(value) {
  const compact = value.replace(/\s/g, '')
  return /^\{"schemaVersion":1,"city":"[^"]+","version":"[^"]+",/.test(compact)
}

async function readBoundedBytes(response, maximumBytes) {
  const declared = parseContentLength(response.headers.get('Content-Length'))
  if (declared !== null && declared > maximumBytes) {
    await response.body.cancel().catch(() => undefined)
    throw new Error('Snapshot artifact exceeds declared bound')
  }
  const reader = response.body.getReader()
  const chunks = []
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > maximumBytes) throw new Error('Snapshot artifact exceeds read bound')
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

function queryD1(command) {
  const result = spawnSync(process.execPath, [
    'node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', DATABASE,
    '--remote', '--json', '--command', command,
  ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  if (result.status !== 0) throw new Error('D1 snapshot command failed')
  let payload
  try {
    payload = JSON.parse(result.stdout)
  } catch {
    throw new Error('D1 snapshot command returned invalid JSON')
  }
  if (!Array.isArray(payload) || payload.some((item) => !Array.isArray(item?.results))) {
    throw new Error('D1 snapshot command returned invalid result')
  }
  return payload
}

function sql(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

function safeIdentifier(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
}

async function readVars(file) {
  let content
  try {
    content = await readFile(file, 'utf8')
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return {}
    throw error
  }
  return Object.fromEntries(content.split(/\r?\n/).filter((line) => line && !line.startsWith('#')).map((line) => {
    const index = line.indexOf('=')
    return [line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^['"]|['"]$/g, '')]
  }))
}
