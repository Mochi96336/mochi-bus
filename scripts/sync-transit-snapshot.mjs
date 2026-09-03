import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { loadOperationalResources } from './instance/operational-resources.mjs'
import { validateSnapshot } from './transit-snapshot/validate.mjs'
import { createStopPlaceRegistry } from './transit-snapshot/stop-place-registry.mjs'
import { patternStopPlaceMismatchQuery } from './transit-snapshot/snapshot-invariants.mjs'
import { manifestReadLimit, readManifestJson } from './transit-snapshot/manifest-read-limit.mjs'
import { parseContentLength } from './transit-snapshot/r2-metadata.mjs'
import { publishWithRollback } from './transit-snapshot/publish-gate.mjs'
import { isSupportedBusDirection } from './transit-snapshot/direction.mjs'
import { retainRoutesWithPatterns } from './transit-snapshot/route-catalogue.mjs'
import { assertArtifactIntegrity, criticalArtifacts, sameArtifactManifest, sameMetrics } from './transit-snapshot/artifact-integrity.mjs'
import { snapshotProbeMarker, snapshotProgressMarker, snapshotTerminalMarker } from './transit-snapshot/window-contract.mjs'
import {
  probeActiveSnapshot,
  readBoundedResponseJson,
  readBoundedResponseText,
} from './transit-snapshot/active-probe.mjs'
import { reserveScheduledD1Budget } from './transit-snapshot/d1-write-budget.mjs'
import { queryD1 as queryD1Rest } from './transit-snapshot/window-d1.mjs'

const CITY = process.argv[2] ?? 'Chiayi'
const operationalResources = loadOperationalResources()
const DATABASE = process.env.TRANSIT_D1_DATABASE_NAME ?? operationalResources.d1DatabaseName
const DATABASE_ID = process.env.TRANSIT_DATABASE_ID ?? operationalResources.d1DatabaseId
const BUCKET = process.env.TRANSIT_R2_BUCKET_NAME ?? operationalResources.r2BucketName
const PUBLIC_ORIGIN = process.env.SNAPSHOT_SMOKE_BASE_URL ?? operationalResources.publicOrigin
if (!DATABASE_ID) throw new Error('Snapshot publisher requires a provisioned D1 database ID')
if (!PUBLIC_ORIGIN) throw new Error('Snapshot publisher requires a fixed public origin or SNAPSHOT_SMOKE_BASE_URL')
const outputRoot = join('.transit-snapshot', CITY)
const workerVars = await readVars('.dev.vars')
const snapshotVars = await readVars('.snapshot.env')
const tdxClientId = process.env.TDX_CLIENT_ID ?? workerVars.TDX_CLIENT_ID
const tdxClientSecret = process.env.TDX_CLIENT_SECRET ?? workerVars.TDX_CLIENT_SECRET
if (!tdxClientId || !tdxClientSecret) {
  throw new Error('Missing TDX_CLIENT_ID or TDX_CLIENT_SECRET in the environment or .dev.vars')
}
// R2 物件走 S3 相容 API直接 PUT/DELETE:wrangler CLI 每個物件要 spawn 一個 process,
// 大城市數萬個物件會跑不完(GitHub Actions 單 job 上限 6 小時)。
const r2 = await createR2Client()
if (!r2) {
  console.warn('R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / CLOUDFLARE_ACCOUNT_ID 未設定,'
    + '改用 wrangler CLI 逐物件上傳(僅適合小城市,大城市會非常慢)。')
}

const TDX_REQUEST_TIMEOUT_MS = 15_000
const TDX_MAX_ATTEMPTS = 5

// header 缺席時 `Response.headers.get()` 回傳 null,`Number(null)` 卻是 0——
// 舊寫法會被 `Number.isFinite(0)` 判定為「有效的 0 秒」,對著還在限流的
// TDX 立刻重打。缺席一律當成「沒有建議值」,交給下面的指數退避。
function parseRetryAfterSeconds(response) {
  const header = response.headers.get('Retry-After')
  if (header === null) return null
  const seconds = Number(header)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TDX_REQUEST_TIMEOUT_MS)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

// token 端點原本連一次逾時/斷線都扛不住,一失敗就整個城市中止;
// 現在跟資料端點共用同一套「逾時／斷線／429 都可重試,其餘狀態碼直接失敗」邏輯。
async function fetchWithRetry(url, options, describe) {
  for (let attempt = 0; attempt < TDX_MAX_ATTEMPTS; attempt += 1) {
    let response
    try {
      response = await fetchWithTimeout(url, options)
    } catch (error) {
      if (attempt === TDX_MAX_ATTEMPTS - 1) {
        throw new Error(`${describe} failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 2 ** (attempt + 1) * 1000))
      continue
    }
    if (response.ok) return response
    if (response.status !== 429 || attempt === TDX_MAX_ATTEMPTS - 1) {
      throw new Error(`${describe} failed (${response.status})`)
    }
    const retryAfterSeconds = parseRetryAfterSeconds(response)
    const delay = retryAfterSeconds !== null ? Math.min(30, retryAfterSeconds) * 1000 : 2 ** (attempt + 1) * 1000
    await new Promise((resolve) => setTimeout(resolve, delay))
  }
  throw new Error(`${describe} retry exhausted`)
}

const tokenResponse = await fetchWithRetry(
  'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token',
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: tdxClientId,
      client_secret: tdxClientSecret,
    }),
  },
  'TDX token request',
)
const token = (await tokenResponse.json()).access_token
const base = `https://tdx.transportdata.tw/api/basic/v2/Bus`
const tdxGet = async (path) => {
  const response = await fetchWithRetry(`${base}/${path}?$format=JSON`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  }, `TDX ${path}`)
  return response.json()
}
const get = (resource) => tdxGet(`${resource}/City/${CITY}`)

const routeItems = await get('Route')
const stopOfRouteItems = await get('StopOfRoute')
const shapeItems = await get('Shape')
const scheduleItems = await get('Schedule')

// 公路客運(InterCity 端點,RouteUID 為 THB 開頭)在不少縣市就是日常公車:
// 苗栗的 City 端點只有 27 個站位,公路客運卻有 733 站。把「至少一站落在本縣市」的
// 客運路線整條攤進本縣市快照——站位靠 normalizeName+200m 跟市區站牌自然合併,
// 跨縣市的站照樣保留,路線頁才有完整站序(代價是跨縣市路線會在多個城市重複存)。
// 站牌屬於哪個縣市以 TDX 的 LocationCityCode 為準(實測 19,191 站零缺漏)。
const LOCATION_CITY_CODES = {
  Taipei: 'TPE', NewTaipei: 'NWT', Taoyuan: 'TAO', Keelung: 'KEE',
  Hsinchu: 'HSZ', HsinchuCounty: 'HSQ', MiaoliCounty: 'MIA', Taichung: 'TXG',
  ChanghuaCounty: 'CHA', NantouCounty: 'NAN', YunlinCounty: 'YUN',
  Chiayi: 'CYI', ChiayiCounty: 'CYQ', Tainan: 'TNN', Kaohsiung: 'KHH',
  PingtungCounty: 'PIF', YilanCounty: 'ILA', HualienCounty: 'HUA', TaitungCounty: 'TTT',
  PenghuCounty: 'PEN', KinmenCounty: 'KIN', LienchiangCounty: 'LIE',
}
{
  const locationCode = LOCATION_CITY_CODES[CITY]
  if (!locationCode) throw new Error(`未知的城市代碼 ${CITY},無法對應 LocationCityCode`)
  const intercityStops = await tdxGet('Stop/InterCity')
  const cityStopUids = new Set(intercityStops
    .filter((stop) => stop.StopUID && stop.LocationCityCode === locationCode)
    .map((stop) => stop.StopUID))
  if (cityStopUids.size) {
    const intercityStopOfRoute = await tdxGet('StopOfRoute/InterCity')
    const routeUids = new Set(intercityStopOfRoute
      .filter((item) => item.RouteUID && item.Stops?.some((stop) => cityStopUids.has(stop.StopUID)))
      .map((item) => item.RouteUID))
    if (routeUids.size) {
      const [intercityRoutes, intercityShapes, intercitySchedules] = await Promise.all([
        tdxGet('Route/InterCity'), tdxGet('Shape/InterCity'), tdxGet('Schedule/InterCity'),
      ])
      routeItems.push(...intercityRoutes.filter((item) => routeUids.has(item.RouteUID)))
      stopOfRouteItems.push(...intercityStopOfRoute.filter((item) => routeUids.has(item.RouteUID)))
      shapeItems.push(...intercityShapes.filter((item) => routeUids.has(item.RouteUID)))
      scheduleItems.push(...intercitySchedules.filter((item) => routeUids.has(item.RouteUID)))
      console.log(JSON.stringify({ city: CITY, intercityRoutes: routeUids.size, intercityStopsInCity: cityStopUids.size }))
    }
  }
}

// 內容沒變就跳過整次匯入:D1 免費方案每天只有 10 萬列寫入額度,
// 多數縣市的路線資料幾週才變一次,沒必要每次全量重匯。
const stateKey = `snapshots/state/${CITY}.json`
const contentHash = hashContent([routeItems, stopOfRouteItems, shapeItems, scheduleItems])
const lastSourceCheckAt = new Date().toISOString()
console.log(JSON.stringify(snapshotProgressMarker(CITY, 'source_compare', { lastSourceCheckAt })))
const previousState = r2 ? await s3GetJson(stateKey) : null
const previousPublishedAt = validSnapshotTimestamp(previousState?.publishedAt)
console.log(JSON.stringify(snapshotProgressMarker(CITY, 'source_compare', {
  lastSourceCheckAt,
  lastPublishedAt: previousPublishedAt,
})))
if (previousState && process.env.SNAPSHOT_FORCE !== '1') {
  if (previousState?.contentHash === contentHash) {
    const probe = await probeActiveSnapshot({
      city: CITY,
      windowId: process.env.SNAPSHOT_WINDOW_ID ?? `local:${CITY}:${lastSourceCheckAt.slice(0, 10)}`,
      state: previousState,
      query: queryActiveProbeD1,
      r2: {
        getManifest: s3GetManifest,
        getJson: s3GetJson,
        head: s3HeadObject,
        readPrefix: s3ReadPrefix,
      },
      publicApi: { getJson: fetchProbePublicJson },
    })
    console.log(JSON.stringify(snapshotProbeMarker(probe)))
    if (probe.activeProbeResult === 'error') {
      throw new Error('Unchanged active snapshot probe failed')
    }
    console.log(JSON.stringify(snapshotTerminalMarker(CITY, 'unchanged', {
      lastSourceCheckAt,
      lastPublishedAt: previousPublishedAt,
      activeVersion: probe.activeVersion,
      previousVersion: probe.previousVersion,
    })))
    console.log(JSON.stringify({ city: CITY, skipped: true, reason: 'unchanged', version: previousState.version }))
    process.exit(0)
  }
}

// Budget only after the exact source hash says this city really changed. Large
// unchanged cities still run their normal health probe and consume no publish
// reservation. The ledger is shared by sequential city publishers in one job.
if (process.env.SNAPSHOT_D1_WRITE_BUDGET) {
  const budget = await reserveScheduledD1Budget({
    city: CITY,
    env: process.env,
    readState: async () => previousState,
  })
  console.log(JSON.stringify({ event: 'snapshot_d1_write_budget', action: 'reserve', ...budget }))
  if (!budget.allowed) {
    console.error(JSON.stringify({
      event: 'snapshot_d1_write_budget_deferred',
      city: CITY,
      ...budget.decision,
    }))
    process.exit(2)
  }
}

// 放在 hash 檢查之後:跳過未變更城市時不用花這次遠端 D1 查詢
console.log(JSON.stringify(snapshotProgressMarker(CITY, 'active_pointer_read', { lastSourceCheckAt })))
const existingRows = queryExistingSnapshots()
console.log(JSON.stringify(snapshotProgressMarker(CITY, 'local_validation', { lastSourceCheckAt })))
const version = new Date().toISOString().replace(/[-:.]/g, '')
const shapeDir = join(outputRoot, 'shapes')
const scheduleDir = join(outputRoot, 'schedules')
const placeDir = join(outputRoot, 'places')
await rm(outputRoot, { recursive: true, force: true })
await mkdir(shapeDir, { recursive: true })
await mkdir(scheduleDir, { recursive: true })
await mkdir(placeDir, { recursive: true })

const routeByUid = new Map()
for (const item of routeItems) {
  if (!item.RouteUID || !item.RouteName?.Zh_tw) continue
  routeByUid.set(item.RouteUID, {
    uid: item.RouteUID,
    name: item.RouteName.Zh_tw,
    departure: item.DepartureStopNameZh ?? null,
    destination: item.DestinationStopNameZh ?? null,
  })
}

const shapesByIdentity = new Map()
for (const item of shapeItems) {
  if (!item.RouteUID || !isSupportedBusDirection(item.Direction) || !item.EncodedPolyline) continue
  const key = `${item.RouteUID}:${item.Direction}`
  const list = shapesByIdentity.get(key) ?? []
  list.push(item)
  shapesByIdentity.set(key, list)
}

const schedulesByRouteUid = new Map()
for (const item of scheduleItems) {
  if (!item.RouteUID || !routeByUid.has(item.RouteUID)) continue
  const list = schedulesByRouteUid.get(item.RouteUID) ?? []
  list.push(item)
  schedulesByRouteUid.set(item.RouteUID, list)
}
for (const route of routeByUid.values()) {
  const schedules = schedulesByRouteUid.get(route.uid) ?? []
  schedulesByRouteUid.set(route.uid, schedules)
  await writeFile(join(scheduleDir, `${route.uid}.json`), JSON.stringify(schedules))
}

const patterns = []
const stopPlaceRegistry = createStopPlaceRegistry({
  city: CITY, normalizeName, hash, distanceMeters,
})
const { stops, places, patternStops } = stopPlaceRegistry
const usedShapes = new Map()
for (const item of stopOfRouteItems) {
  if (!item.RouteUID || !isSupportedBusDirection(item.Direction) || !item.Stops?.length) continue
  const route = routeByUid.get(item.RouteUID)
  if (!route) continue
  const identity = `${item.RouteUID}:${item.Direction}`
  const shapeIndex = usedShapes.get(identity) ?? 0
  const shape = (shapesByIdentity.get(identity) ?? [])[shapeIndex] ?? (shapesByIdentity.get(identity) ?? [])[0]
  usedShapes.set(identity, shapeIndex + 1)
  if (!shape) continue
  const validStops = item.Stops.filter((stop) => stop.StopUID && stop.StopName?.Zh_tw
    && Number.isFinite(stop.StopPosition?.PositionLat) && Number.isFinite(stop.StopPosition?.PositionLon))
  if (validStops.length < 2) continue
  const patternId = `${item.SubRouteUID ?? item.RouteUID}:${item.Direction}:${shapeIndex}`
  const safeId = encodeURIComponent(patternId)
  const shapeKey = `snapshots/${version}/cities/${CITY}/shapes/${patternId}.json`
  const first = validStops[0].StopName.Zh_tw
  const last = validStops.at(-1).StopName.Zh_tw
  const shapeFeature = {
    type: 'Feature',
    properties: { routeUid: item.RouteUID, direction: item.Direction },
    geometry: { type: 'LineString', coordinates: decodePolyline(shape.EncodedPolyline) },
  }
  patterns.push({
    id: patternId, routeUid: item.RouteUID, subrouteUid: item.SubRouteUID ?? null,
    subrouteName: item.SubRouteName?.Zh_tw ?? route.name, direction: item.Direction,
    departure: first, destination: last, shapeKey, updatedAt: shape.UpdateTime ?? null, shapeFeature,
  })
  await writeFile(join(shapeDir, `${safeId}.json`), JSON.stringify(shapeFeature))

  for (const stop of validStops) stopPlaceRegistry.addOccurrence({ patternId, stop })
}
const removedRouteUids = retainRoutesWithPatterns({
  routes: routeByUid,
  schedules: schedulesByRouteUid,
  patterns,
})
if (removedRouteUids.length) {
  console.warn(JSON.stringify({
    city: CITY,
    warning: 'routes-without-pattern-removed',
    count: removedRouteUids.length,
  }))
}
for (const warning of stopPlaceRegistry.duplicateWarnings()) {
  console.warn(JSON.stringify({ city: CITY, warning: 'duplicate-stop-observation', ...warning }))
}

const patternById = new Map(patterns.map((pattern) => [pattern.id, pattern]))
const placeBundles = new Map([...places.values()].map((place) => [place.id, {
  version,
  placeId: place.id,
  name: place.name,
  routes: [],
}]))
const seenPlaceRoutes = new Set()
for (const item of patternStops) {
  const pattern = patternById.get(item.patternId)
  const stop = stops.get(item.stopUid)
  const bundle = placeBundles.get(item.placeId)
  if (!pattern || !stop || !bundle) continue
  const identity = `${item.placeId}:${pattern.id}:${item.stopUid}`
  if (seenPlaceRoutes.has(identity)) continue
  seenPlaceRoutes.add(identity)
  const routeSchedules = schedulesByRouteUid.get(pattern.routeUid) ?? []
  const sameDirection = routeSchedules.filter((schedule) => schedule.Direction === pattern.direction)
  const exactSchedules = sameDirection.filter((schedule) =>
    !pattern.subrouteUid || !schedule.SubRouteUID || schedule.SubRouteUID === pattern.subrouteUid)
  // 雙北的 Schedule 常只掛在代表支線(或缺方向):262 有 8 個支線×方向組合,
  // 班表卻只覆蓋其中 4 個。自己的班表拿不到就借同路線同方向其他支線的當估計,
  // 顯示端本來就標成「預估」;不借的話這些站會整排「暫無資訊」,明明是高頻車。
  const matchingSchedules = exactSchedules.length ? exactSchedules : sameDirection
  const schedules = matchingSchedules.map((schedule) => ({
    SubRouteUID: schedule.SubRouteUID,
    Direction: schedule.Direction,
    Timetables: (schedule.Timetables ?? []).map((timetable) => {
      const atThisStop = (timetable.StopTimes ?? []).filter((time) => time.StopUID === item.stopUid)
      // 有些縣市(如台南)每班次只提供起點發車時間,本站過濾後會全空;
      // 保留起點那筆,讓網頁端退回用「發車時間」估計,不然整站會變「暫無資訊」。
      const stopTimes = atThisStop.length ? atThisStop : (timetable.StopTimes ?? [])
        .slice()
        .sort((a, b) => (a.StopSequence ?? 0) - (b.StopSequence ?? 0))
        .slice(0, 1)
      return { ServiceDay: timetable.ServiceDay, StopTimes: stopTimes }
    }).filter((timetable) => timetable.StopTimes.length),
    // 班距制(雙北)不分站別,原樣保留給網頁端估「N–M 分一班」
    Frequencys: (schedule.Frequencys ?? []).map((frequency) => ({
      StartTime: frequency.StartTime,
      EndTime: frequency.EndTime,
      MinHeadwayMins: frequency.MinHeadwayMins,
      MaxHeadwayMins: frequency.MaxHeadwayMins,
      ServiceDay: frequency.ServiceDay,
    })),
  })).filter((schedule) => schedule.Timetables.length || schedule.Frequencys.length)
  bundle.routes.push({
    routeUid: pattern.routeUid,
    routeName: routeByUid.get(pattern.routeUid).name,
    variantKey: pattern.id,
    direction: pattern.direction,
    label: `${pattern.departure} → ${pattern.destination}`,
    subRouteUid: pattern.subrouteUid ?? undefined,
    subRouteName: pattern.subrouteName,
    stopUid: item.stopUid,
    stopSequence: item.sequence,
    stopName: stop.name,
    schedules,
  })
}
for (const bundle of placeBundles.values()) {
  await writeFile(join(placeDir, `${encodeURIComponent(bundle.placeId)}.json`), JSON.stringify(bundle))
}

const sql = []
sql.push('PRAGMA foreign_keys=OFF;')
for (const route of routeByUid.values()) sql.push(`INSERT OR REPLACE INTO routes VALUES (${values(version, CITY, route.uid, route.name, route.departure, route.destination)});`)
for (const pattern of patterns) sql.push(`INSERT OR REPLACE INTO patterns VALUES (${values(version, pattern.id, CITY, pattern.routeUid, pattern.subrouteUid, pattern.subrouteName, pattern.direction, pattern.departure, pattern.destination, pattern.shapeKey, pattern.updatedAt)});`)
for (const place of places.values()) sql.push(`INSERT OR REPLACE INTO stop_places VALUES (${values(version, place.id, CITY, place.name, place.lat, place.lon)});`)
for (const stop of stops.values()) sql.push(`INSERT OR REPLACE INTO stops VALUES (${values(version, stop.uid, CITY, stop.name, stop.normalized, stop.lat, stop.lon, stop.placeId)});`)
for (const item of patternStops) sql.push(`INSERT OR REPLACE INTO pattern_stops VALUES (${values(version, item.patternId, item.stopUid, item.placeId, item.sequence)});`)
// 大城市單檔數萬條 statement 會觸發 D1 大交易的內部錯誤(object reset),
// 分塊依序執行。安全性:啟用新版本的 dataset_versions upsert 在最後一塊,
// 中途失敗只會留下未啟用的孤兒列,線上仍由舊版本服務,重跑即可。
const SQL_CHUNK_STATEMENTS = 5000
const sqlFiles = []
for (let start = 0; start < sql.length; start += SQL_CHUNK_STATEMENTS) {
  const file = join(outputRoot, `import-${String(sqlFiles.length).padStart(2, '0')}.sql`)
  await writeFile(file, sql.slice(start, start + SQL_CHUNK_STATEMENTS).join('\n'))
  sqlFiles.push(file)
}

const networkKey = `snapshots/${version}/cities/${CITY}/network.json`
const networkFile = join(outputRoot, 'network.json')
// schemaVersion/city直接寫進檔案:API 端把這個物件原樣串流給瀏覽器
// (雙北 35MB+ 在 Worker 內 parse+stringify 會撞記憶體上限),不再有機會補欄位。
// 全路網 geometry 統一使用 8m Douglas-Peucker 容差。50m 雖可顯著縮小 payload，
// 但會犧牲路網線形的視覺正確性，因此不再用於正式 snapshot。細節路線圖使用的
// shapes/*.json 不經過這段全路網簡化。
const NETWORK_LOD_TOLERANCE_METERS = 8
const network = {
  schemaVersion: 1,
  city: CITY,
  version,
  routes: patterns.map((pattern) => ({
    routeName: routeByUid.get(pattern.routeUid).name,
    variantKey: pattern.id,
    label: `${pattern.departure} → ${pattern.destination}`,
    shape: {
      ...pattern.shapeFeature,
      geometry: {
        ...pattern.shapeFeature.geometry,
        coordinates: simplifyLine(pattern.shapeFeature.geometry.coordinates, NETWORK_LOD_TOLERANCE_METERS),
      },
    },
  })),
  places: [...places.values()].map((place) => ({
    placeId: place.id, name: place.name, latitude: place.lat, longitude: place.lon,
  })),
}
await writeFile(networkFile, JSON.stringify(network))

const validation = validateSnapshot({
  city: CITY, version, routes: routeByUid, patterns, stops, places, patternStops,
  schedules: schedulesByRouteUid, placeBundles, network,
}, previousState)
console.log(JSON.stringify({ city: CITY, version, phase: 'local-validation', ...validation }))

const artifactTasks = [
  ...patterns.map((pattern) => ({
    key: pattern.shapeKey,
    file: join(shapeDir, `${encodeURIComponent(pattern.id)}.json`),
    contentType: 'application/geo+json',
  })),
  ...[...routeByUid.values()].map((route) => ({
    key: `snapshots/${version}/cities/${CITY}/schedules/${route.uid}.json`,
    file: join(scheduleDir, `${route.uid}.json`),
    contentType: 'application/json',
  })),
  ...[...placeBundles.values()].map((bundle) => ({
    key: `snapshots/${version}/cities/${CITY}/places/${bundle.placeId}.json`,
    file: join(placeDir, `${encodeURIComponent(bundle.placeId)}.json`),
    contentType: 'application/json',
  })),
  { key: networkKey, file: networkFile, contentType: 'application/json' },
]
const manifestKey = `snapshots/${version}/cities/${CITY}/manifest.json`
const manifestFile = join(outputRoot, 'manifest.json')
const manifest = await createArtifactManifest(artifactTasks, validation.counts, validation.quality)
await writeFile(manifestFile, JSON.stringify(manifest))
artifactTasks.push({ key: manifestKey, file: manifestFile, contentType: 'application/json' })

const previousVersion = existingRows.active[0]?.active_version ?? null
const importedAt = new Date().toISOString()
const publishedState = {
  schemaVersion: 2,
  contentHash,
  version,
  previousVersion,
  manifestKey,
  counts: validation.counts,
  quality: validation.quality,
  generatedAt: importedAt,
  publishedAt: importedAt,
  source: 'TDX',
  workflowRun: process.env.GITHUB_RUN_ID ?? null,
}
const smokePattern = patterns[0]
const smokeTarget = {
  counts: validation.counts,
  routeName: routeByUid.get(smokePattern.routeUid).name,
  patternId: smokePattern.id,
  placeId: patternStops.find((item) => item.patternId === smokePattern.id).placeId,
}

function validSnapshotTimestamp(value) {
  if (typeof value !== 'string') return undefined
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString()
}
const allVersions = [
  ...existingRows.routes, ...existingRows.patterns, ...existingRows.places,
].map((row) => row.version)
const retainedPreviousVersion = previousVersion ?? [...new Set(allVersions)].sort().at(-1)
const versionsToDelete = new Set(allVersions.filter((item) => item !== retainedPreviousVersion))
const cleanupFile = versionsToDelete.size ? join(outputRoot, 'cleanup.sql') : null
if (versionsToDelete.size) {
  const cleanupSql = [
    `DELETE FROM pattern_stops WHERE version IN (${[...versionsToDelete].map(sqlValue).join(',')});`,
    `DELETE FROM stops WHERE city_code=${sqlValue(CITY)} AND version IN (${[...versionsToDelete].map(sqlValue).join(',')});`,
    `DELETE FROM stop_places WHERE city_code=${sqlValue(CITY)} AND version IN (${[...versionsToDelete].map(sqlValue).join(',')});`,
    `DELETE FROM patterns WHERE city_code=${sqlValue(CITY)} AND version IN (${[...versionsToDelete].map(sqlValue).join(',')});`,
    `DELETE FROM routes WHERE city_code=${sqlValue(CITY)} AND version IN (${[...versionsToDelete].map(sqlValue).join(',')});`,
  ]
  await writeFile(cleanupFile, cleanupSql.join('\n'))
}
const obsoleteObjectKeys = [...new Set([
  ...existingRows.patterns.filter((item) => versionsToDelete.has(item.version))
    .map((item) => `snapshots/${item.version}/cities/${CITY}/shapes/${item.pattern_id}.json`),
  ...existingRows.routes.filter((item) => versionsToDelete.has(item.version))
    .map((item) => `snapshots/${item.version}/cities/${CITY}/schedules/${item.route_uid}.json`),
  ...existingRows.places.filter((item) => versionsToDelete.has(item.version))
    .map((item) => `snapshots/${item.version}/cities/${CITY}/places/${item.place_id}.json`),
  ...[...versionsToDelete].map((oldVersion) => `snapshots/${oldVersion}/cities/${CITY}/network.json`),
  ...[...versionsToDelete].map((oldVersion) => `snapshots/${oldVersion}/cities/${CITY}/manifest.json`),
])]
let publishedProbe = null
try {
  await publishWithRollback({
    targetVersion: version,
    previousVersion,
    stage: async () => {
      console.log(JSON.stringify(snapshotProgressMarker(CITY, 'stage', { lastSourceCheckAt, previousVersion })))
      await putObjects(artifactTasks)
      for (const file of sqlFiles) await runD1(file)
    },
    validate: () => {
      console.log(JSON.stringify(snapshotProgressMarker(CITY, 'remote_validation', { lastSourceCheckAt, previousVersion })))
      return validateRemoteSnapshot(version, validation.counts, validation.quality, manifestKey, manifest)
    },
    activate: () => {
      console.log(JSON.stringify(snapshotProgressMarker(CITY, 'activate', { lastSourceCheckAt, previousVersion })))
      return guardedActivateSnapshot(previousVersion, version, importedAt)
    },
    smoke: async () => {
      console.log(JSON.stringify(snapshotProgressMarker(CITY, 'smoke', { lastSourceCheckAt, previousVersion })))
      await smokePublishedSnapshot(version, smokeTarget)
      publishedProbe = await probeActiveSnapshot({
        city: CITY,
        windowId: process.env.SNAPSHOT_WINDOW_ID ?? `local:${CITY}:${lastSourceCheckAt.slice(0, 10)}`,
        state: publishedState,
        query: queryActiveProbeD1,
        r2: {
          getManifest: s3GetManifest,
          getJson: s3GetJson,
          head: s3HeadObject,
          readPrefix: s3ReadPrefix,
        },
        publicApi: { getJson: fetchProbePublicJson },
      })
      console.log(JSON.stringify(snapshotProbeMarker(publishedProbe)))
      if (publishedProbe.activeProbeResult === 'error') throw new Error('Published active snapshot probe failed')
    },
    rollback: async (targetVersion, rejectedVersion) => {
      console.log(JSON.stringify(snapshotProgressMarker(CITY, 'rollback', { lastSourceCheckAt, previousVersion })))
      const restored = guardedActivateSnapshot(rejectedVersion, targetVersion, new Date().toISOString(), false)
      if (!restored) return false
      console.error(JSON.stringify({ city: CITY, version, phase: 'rollback', restoredVersion: targetVersion }))
      // Rollback 成功後,terminal failure 的根因仍是 smoke,不是把恢復動作誤報成失敗原因。
      console.log(JSON.stringify(snapshotProgressMarker(CITY, 'smoke', { lastSourceCheckAt, previousVersion })))
      return true
    },
    finalize: async () => {
      console.log(JSON.stringify(snapshotProgressMarker(CITY, 'finalize', { lastSourceCheckAt, previousVersion })))
      if (!r2) throw new Error('Snapshot state writer unavailable')
      await s3Request('PUT', stateKey, JSON.stringify({
        ...publishedState,
        publishedAt: new Date().toISOString(),
      }), 'application/json')
    },
    cleanup: async () => {
      console.log(JSON.stringify(snapshotProgressMarker(CITY, 'cleanup', { lastSourceCheckAt, previousVersion })))
      if (cleanupFile) await runD1(cleanupFile)
      await deleteObjects(obsoleteObjectKeys)
    },
  })
} catch (error) {
  const outcome = typeof error?.code === 'string' ? error.code : 'unknown'
  console.error(JSON.stringify({ event: 'snapshot_publish_failure', city: CITY, version, outcome }))
  process.exit(1)
}
if (!publishedProbe) throw new Error('Published active snapshot probe missing')
console.log(JSON.stringify(snapshotTerminalMarker(CITY, 'published', {
  lastSourceCheckAt,
  activeVersion: version,
  previousVersion,
})))
console.log(JSON.stringify({ city: CITY, version, previousVersion, phase: 'published', ...validation.counts }))

function values(...items) { return items.map(sqlValue).join(', ') }
function sqlValue(value) {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number') return String(value)
  return `'${String(value).replaceAll("'", "''")}'`
}
// 必須跟 src/infrastructure/transit/snapshot-repository.ts 的 normalizeStopName 完全一致。
// 「臺→台」與「火車站/車站→站、去結尾站」是為了讓公路客運與市區公車的同站異名收斂:
// 雙冬站⇄雙冬、新竹火車站⇄新竹站、高鐵臺中站⇄高鐵台中站(實測南投漏接 -30%)。
function normalizeName(value) {
  return value.normalize('NFKC').replace(/[\s()（）]/g, '').toLowerCase()
    .replaceAll('臺', '台')
    .replace(/火車站|車站/g, '站')
    .replace(/站$/, '')
}
function hash(value) {
  let result = 2166136261
  for (const char of value) result = Math.imul(result ^ char.charCodeAt(0), 16777619)
  return (result >>> 0).toString(36)
}
function distanceMeters(lat1, lon1, lat2, lon2) {
  const radius = 6_371_000; const radians = (value) => value * Math.PI / 180
  const deltaLat = radians(lat2 - lat1); const deltaLon = radians(lon2 - lon1)
  const a = Math.sin(deltaLat / 2) ** 2 + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(deltaLon / 2) ** 2
  return 2 * radius * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}
// Douglas-Peucker 折線簡化,容差單位是公尺。平面近似:緯度 1 度 ≈ 111,320m,
// 經度依線段起點的緯度縮放;台灣尺度下這個近似對公尺級容差的誤差可忽略。
function simplifyLine(coordinates, toleranceMeters) {
  if (coordinates.length <= 2) return coordinates
  const latScale = 111_320
  const lonScale = 111_320 * Math.cos(coordinates[0][1] * Math.PI / 180)
  const points = coordinates.map(([lon, lat]) => [lon * lonScale, lat * latScale])
  const keep = new Uint8Array(coordinates.length)
  keep[0] = keep[coordinates.length - 1] = 1
  const stack = [[0, coordinates.length - 1]]
  while (stack.length) {
    const [start, end] = stack.pop()
    const [x1, y1] = points[start]
    const [x2, y2] = points[end]
    const dx = x2 - x1
    const dy = y2 - y1
    const lengthSquared = dx * dx + dy * dy
    let maxDistance = 0
    let maxIndex = start
    for (let i = start + 1; i < end; i += 1) {
      const [x, y] = points[i]
      // 點到「線段」的距離(不是無限直線):公車路線常折返,端點重合時
      // lengthSquared 為 0,直線距離公式會除以零
      const t = lengthSquared === 0 ? 0
        : Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / lengthSquared))
      const distance = Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy))
      if (distance > maxDistance) {
        maxDistance = distance
        maxIndex = i
      }
    }
    if (maxDistance > toleranceMeters) {
      keep[maxIndex] = 1
      stack.push([start, maxIndex], [maxIndex, end])
    }
  }
  return coordinates.filter((_, index) => keep[index])
}
function decodePolyline(encoded) {
  const coordinates = []; let index = 0; let latitude = 0; let longitude = 0
  while (index < encoded.length) {
    const next = () => { let result = 0; let shift = 0; let byte; do { byte = encoded.charCodeAt(index++) - 63; result |= (byte & 31) << shift; shift += 5 } while (byte >= 32); return (result & 1) ? ~(result >> 1) : result >> 1 }
    latitude += next(); longitude += next(); coordinates.push([longitude / 1e5, latitude / 1e5])
  }
  return coordinates
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
    const index = line.indexOf('='); return [line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^['"]|['"]$/g, '')]
  }))
}
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`${command} failed (${result.error?.message ?? result.status})`)
}
// D1 大匯入偶發 internal error 且官方明示可安全重試(失敗會 rollback)
async function runD1(file) {
  for (let attempt = 1; ; attempt += 1) {
    const result = spawnSync(process.execPath, [
      'node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', DATABASE, '--remote', '--file', file,
    ], { stdio: 'inherit' })
    if (result.status === 0) return
    if (attempt >= 3) throw new Error(`d1 execute ${file} failed (${result.error?.message ?? result.status})`)
    console.warn(`d1 execute ${file} 失敗,${attempt * 10} 秒後重試 (${attempt}/3)`)
    await new Promise((resolve) => setTimeout(resolve, attempt * 10_000))
  }
}
async function createR2Client() {
  const accessKeyId = process.env.R2_ACCESS_KEY_ID ?? snapshotVars.R2_ACCESS_KEY_ID ?? workerVars.R2_ACCESS_KEY_ID
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY ?? snapshotVars.R2_SECRET_ACCESS_KEY ?? workerVars.R2_SECRET_ACCESS_KEY
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? snapshotVars.CLOUDFLARE_ACCOUNT_ID ?? workerVars.CLOUDFLARE_ACCOUNT_ID
  const usesLegacyWorkerVars = [
    ['R2_ACCESS_KEY_ID', accessKeyId],
    ['R2_SECRET_ACCESS_KEY', secretAccessKey],
    ['CLOUDFLARE_ACCOUNT_ID', accountId],
  ].some(([name, value]) => value && !process.env[name] && !snapshotVars[name] && workerVars[name])
  if (usesLegacyWorkerVars) {
    console.warn('Snapshot publisher credentials in .dev.vars are deprecated; move them to .snapshot.env.')
  }
  if (!accessKeyId || !secretAccessKey || !accountId) return null
  const { AwsClient } = await import('aws4fetch')
  return {
    client: new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' }),
    baseUrl: `https://${accountId}.r2.cloudflarestorage.com/${BUCKET}`,
  }
}
function hashContent(payloads) {
  // 快照產出格式的版本:bundle/network 的結構有改就 +1,
  // 讓所有城市自動重匯,不會被「內容未變更」跳過而留著舊格式。
  // 4:place bundle 的班表比對加入「借同方向其他支線」的 fallback。
  // 5:normalizeName 加「臺→台、車站→站、去結尾站」,placeId 全部重算。
  // 6:network.json 內建 schemaVersion/city(API 改原樣串流)+ shape 簡化瘦身。
  // 7:manifest/state 加入品質指標，所有城市重跑新版 gate 後才可沿用 unchanged 快取。
  // 8:StopUID 首次觀測決定 canonical place，後續 route occurrence 重用該 placeId。
  // 9:route catalogue 只保留至少有一個有效 pattern 的 route。
  const SNAPSHOT_FORMAT = 9
  // UpdateTime/VersionID 這類欄位在 TDX 重新發佈時會變動,但不影響我們匯入的內容,
  // 納入 hash 會讓「跳過未變更城市」幾乎永遠不生效。
  const volatileKeys = new Set(['UpdateTime', 'SrcUpdateTime', 'SrcTransTime', 'VersionID'])
  const stable = JSON.stringify(payloads, (key, value) => volatileKeys.has(key) ? undefined : value)
  return createHash('sha256').update(`format:${SNAPSHOT_FORMAT}\n`).update(stable).digest('hex')
}
async function createArtifactManifest(tasks, counts, quality) {
  const artifacts = []
  for (const task of tasks) {
    const body = await readFile(task.file)
    artifacts.push({
      key: task.key,
      bytes: body.byteLength,
      sha256: createHash('sha256').update(body).digest('hex'),
      contentType: task.contentType,
    })
  }
  return {
    schemaVersion: 2, city: CITY, version, contentHash,
    generatedAt: new Date().toISOString(), source: 'TDX',
    workflowRun: process.env.GITHUB_RUN_ID ?? null,
    counts, quality, artifacts,
  }
}
async function validateRemoteSnapshot(targetVersion, expectedCounts, expectedQuality, manifestKey, expectedManifest) {
  const result = queryRemoteD1([
    `SELECT COUNT(*) AS count FROM routes WHERE version=${sqlValue(targetVersion)} AND city_code=${sqlValue(CITY)}`,
    `SELECT COUNT(*) AS count FROM patterns WHERE version=${sqlValue(targetVersion)} AND city_code=${sqlValue(CITY)}`,
    `SELECT COUNT(*) AS count FROM stops WHERE version=${sqlValue(targetVersion)} AND city_code=${sqlValue(CITY)}`,
    `SELECT COUNT(*) AS count FROM stop_places WHERE version=${sqlValue(targetVersion)} AND city_code=${sqlValue(CITY)}`,
    `SELECT COUNT(*) AS count FROM pattern_stops WHERE version=${sqlValue(targetVersion)}`,
    `SELECT
      (SELECT COUNT(*) FROM patterns p LEFT JOIN routes r ON r.version=p.version AND r.route_uid=p.route_uid WHERE p.version=${sqlValue(targetVersion)} AND r.route_uid IS NULL)
      + (SELECT COUNT(*) FROM stops s LEFT JOIN stop_places sp ON sp.version=s.version AND sp.place_id=s.place_id WHERE s.version=${sqlValue(targetVersion)} AND sp.place_id IS NULL)
      + (SELECT COUNT(*) FROM pattern_stops ps LEFT JOIN patterns p ON p.version=ps.version AND p.pattern_id=ps.pattern_id LEFT JOIN stops s ON s.version=ps.version AND s.stop_uid=ps.stop_uid LEFT JOIN stop_places sp ON sp.version=ps.version AND sp.place_id=ps.place_id WHERE ps.version=${sqlValue(targetVersion)} AND (p.pattern_id IS NULL OR s.stop_uid IS NULL OR sp.place_id IS NULL)) AS count`,
    `SELECT COUNT(*) AS count FROM (
      SELECT p.pattern_id FROM patterns p
      LEFT JOIN pattern_stops ps ON ps.version=p.version AND ps.pattern_id=p.pattern_id
      WHERE p.version=${sqlValue(targetVersion)} AND p.city_code=${sqlValue(CITY)}
      GROUP BY p.pattern_id HAVING COUNT(ps.stop_uid) < 2
    )`,
    `SELECT COUNT(*) AS count FROM routes r
      WHERE r.version=${sqlValue(targetVersion)} AND r.city_code=${sqlValue(CITY)}
      AND NOT EXISTS (
        SELECT 1 FROM patterns p
        WHERE p.version=r.version AND p.city_code=r.city_code AND p.route_uid=r.route_uid
      )`,
    patternStopPlaceMismatchQuery(targetVersion),
  ].join(';'))
  const actual = {
    routes: Number(result[0]?.results?.[0]?.count),
    patterns: Number(result[1]?.results?.[0]?.count),
    stops: Number(result[2]?.results?.[0]?.count),
    places: Number(result[3]?.results?.[0]?.count),
    patternStops: Number(result[4]?.results?.[0]?.count),
  }
  for (const [name, expected] of Object.entries(expectedCounts)) {
    if (name in actual && actual[name] !== expected) {
      throw new Error(`Remote D1 ${name} count mismatch: ${actual[name]} != ${expected}`)
    }
  }
  const dangling = Number(result[5]?.results?.[0]?.count)
  if (dangling !== 0) throw new Error(`Remote D1 contains ${dangling} dangling snapshot references`)
  const shortPatterns = Number(result[6]?.results?.[0]?.count)
  if (shortPatterns !== 0) throw new Error(`Remote D1 contains ${shortPatterns} patterns with fewer than two stops`)
  const orphanRoutes = Number(result[7]?.results?.[0]?.count)
  if (orphanRoutes !== 0) throw new Error(`Remote D1 contains ${orphanRoutes} routes without patterns`)
  const placeMismatches = Number(result[8]?.results?.[0]?.count)
  if (placeMismatches !== 0) {
    throw new Error(`Remote D1 contains ${placeMismatches} pattern stop place mismatches`)
  }
  if (r2) {
    const remoteManifest = await s3GetJson(manifestKey, manifestReadLimit(expectedManifest))
    if (remoteManifest?.schemaVersion !== 2
      || remoteManifest?.version !== targetVersion
      || remoteManifest?.contentHash !== contentHash
      || !sameMetrics(remoteManifest.counts, expectedCounts)
      || !sameMetrics(remoteManifest.quality, expectedQuality)
      || !sameArtifactManifest(remoteManifest.artifacts, expectedManifest.artifacts)) {
      throw new Error('Remote R2 manifest does not match the staged snapshot')
    }
    await verifyCriticalR2Artifacts(remoteManifest.artifacts, targetVersion)
  }
  console.log(JSON.stringify({ city: CITY, version: targetVersion, phase: 'remote-validation', counts: actual, quality: expectedQuality }))
}
async function smokePublishedSnapshot(targetVersion, target) {
  const cacheBust = `snapshot=${encodeURIComponent(targetVersion)}`
  let lastError
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    try {
      const routes = await fetchPublicJson(`${PUBLIC_ORIGIN}/api/v1/map/routes?city=${encodeURIComponent(CITY)}&${cacheBust}`)
      if (routes.source !== 'snapshot' || routes.snapshotVersion !== targetVersion
        || !Array.isArray(routes.routes) || routes.routes.length !== target.counts.routes) {
        throw new Error(`unexpected route catalogue for active snapshot ${routes.snapshotVersion ?? 'missing'}`)
      }

      const route = await fetchPublicJson(`${PUBLIC_ORIGIN}/api/v1/map/route?city=${encodeURIComponent(CITY)}&route=${encodeURIComponent(target.routeName)}&${cacheBust}`)
      const variant = Array.isArray(route.variants)
        ? route.variants.find((item) => item.variantKey === target.patternId)
        : undefined
      if (route.source !== 'snapshot' || !variant || variant.stops?.features?.length < 2) {
        throw new Error(`public route detail is missing pattern ${target.patternId}`)
      }

      const place = await fetchPublicJson(`${PUBLIC_ORIGIN}/api/v1/map/place/${encodeURIComponent(target.placeId)}/routes?city=${encodeURIComponent(CITY)}&${cacheBust}`)
      if (!Array.isArray(place.routes) || !place.routes.some((item) => item.variantKey === target.patternId)) {
        throw new Error(`public place bundle is missing pattern ${target.patternId}`)
      }

      await assertPublicNetworkVersion(`${PUBLIC_ORIGIN}/api/v1/map/network?city=${encodeURIComponent(CITY)}&${cacheBust}`, targetVersion)
      console.log(JSON.stringify({
        city: CITY, version: targetVersion, phase: 'public-smoke',
        routes: routes.routes.length, patternId: target.patternId, placeId: target.placeId,
      }))
      return
    } catch (error) {
      lastError = error
      if (attempt < 12) await new Promise((resolve) => setTimeout(resolve, 10_000))
    }
  }
  throw new Error(`Public snapshot smoke failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

async function fetchPublicJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000), cache: 'no-store' })
  if (!response.ok) {
    await response.arrayBuffer()
    throw new Error(`HTTP ${response.status} for ${new URL(url).pathname}`)
  }
  return await readBoundedResponseJson(response, 2 * 1024 * 1024)
}
async function fetchProbePublicJson(path) {
  const response = await fetch(new URL(path, PUBLIC_ORIGIN), {
    signal: AbortSignal.timeout(15_000),
    cache: 'no-store',
  })
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error('Public snapshot probe request failed')
  }
  return readBoundedResponseJson(response, 2 * 1024 * 1024)
}

async function assertPublicNetworkVersion(url, targetVersion) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000), cache: 'no-store' })
  if (!response.ok || !response.body) {
    await response.arrayBuffer()
    throw new Error(`HTTP ${response.status} for public network`)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let prefix = ''
  try {
    while (prefix.length < 65_536) {
      const { done, value } = await reader.read()
      if (done) break
      prefix += decoder.decode(value, { stream: true })
      if (prefix.includes(`"version":${JSON.stringify(targetVersion)}`)) return
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  throw new Error(`public network does not expose active version ${targetVersion}`)
}

async function verifyCriticalR2Artifacts(artifacts, targetVersion) {
  const prefix = `snapshots/${targetVersion}/cities/${CITY}/`
  await mapParallel(criticalArtifacts(artifacts, prefix), 4, verifyR2Artifact)
}

async function verifyR2Artifact(artifact) {
  const response = await r2.client.fetch(objectUrl(artifact.key))
  if (!response.ok) {
    await response.arrayBuffer()
    throw new Error(`R2 GET ${artifact.key} failed (${response.status})`)
  }
  assertArtifactIntegrity(artifact, await response.arrayBuffer())
}
async function s3GetManifest(key) {
  return readManifestJson({ key, head: s3HeadObject, getJson: s3GetJson })
}
async function s3GetJson(key, maximumBytes = 1024 * 1024) {
  const response = await r2.client.fetch(objectUrl(key))
  if (response.status === 404) {
    await response.arrayBuffer()
    return null
  }
  if (!response.ok) {
    await response.arrayBuffer()
    throw new Error(`R2 GET ${key} failed (${response.status})`)
  }
  return await readBoundedResponseJson(response, maximumBytes)
}
async function s3HeadObject(key) {
  const response = await r2.client.fetch(objectUrl(key), { method: 'HEAD' })
  await response.body?.cancel().catch(() => undefined)
  if (response.status === 404) return null
  if (!response.ok) throw new Error('R2 snapshot probe HEAD failed')
  const size = parseContentLength(response.headers.get('Content-Length'))
  return { size, etag: response.headers.get('ETag') }
}
async function s3ReadPrefix(key, maximumBytes) {
  const response = await r2.client.fetch(objectUrl(key), {
    headers: { Range: `bytes=0-${maximumBytes - 1}` },
  })
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error('R2 snapshot probe range read failed')
  }
  return readBoundedResponseText(response, maximumBytes)
}
function objectUrl(key) {
  // key 內含 ':' 等字元,SigV4 的 canonical URI 要求 percent-encoding,
  // 逐段編碼讓簽章與 R2 端的正規化結果一致。
  return `${r2.baseUrl}/${key.split('/').map(encodeURIComponent).join('/')}`
}
async function s3Request(method, key, body, contentType) {
  for (let attempt = 1; ; attempt += 1) {
    const outcome = await r2.client.fetch(objectUrl(key), {
      method, body, headers: contentType ? { 'Content-Type': contentType } : undefined,
    }).then(async (response) => {
      await response.arrayBuffer()
      if (response.ok || (method === 'DELETE' && response.status === 404)) return {}
      return {
        error: new Error(`R2 ${method} ${key} failed (${response.status})`),
        retryable: response.status >= 500 || response.status === 429,
      }
    }).catch((error) => ({ error, retryable: true }))
    if (!outcome.error) return
    if (!outcome.retryable || attempt >= 4) throw outcome.error
    await new Promise((resolve) => setTimeout(resolve, 500 * attempt))
  }
}
async function putObjects(tasks) {
  if (r2) {
    await mapParallel(tasks, 32, async (task) =>
      s3Request('PUT', task.key, await readFile(task.file), task.contentType))
    return
  }
  await mapParallel(tasks, 6, (task) => spawnWrangler([
    'r2', 'object', 'put', `${BUCKET}/${task.key}`, '--remote', '--file', task.file, '--content-type', task.contentType,
  ]))
}
async function deleteObjects(keys) {
  if (r2) {
    await mapParallel(keys, 32, (key) => s3Request('DELETE', key))
    return
  }
  await mapParallel(keys, 6, (key) => spawnWrangler(['r2', 'object', 'delete', `${BUCKET}/${key}`, '--remote']))
}
function spawnWrangler(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', ...args], { stdio: 'ignore' })
    child.on('error', reject)
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`wrangler ${args[0]} failed (${code})`)))
  })
}
async function mapParallel(items, concurrency, worker) {
  let index = 0
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) await worker(items[index++])
  })
  await Promise.all(runners)
}
function queryExistingSnapshots() {
  // 三張表各自平掃,不 join:R2 的三類物件 key 分別只依賴一張表
  // (schedules←routes、shapes←patterns、place bundles←stop_places),
  // 舊版的三表 LEFT JOIN + DISTINCT 用不到索引前綴,台南規模單次要掃 700 萬列。
  const cityLiteral = `'${CITY.replaceAll("'", "''")}'`
  const sql = [
    `SELECT DISTINCT version, route_uid FROM routes WHERE city_code=${cityLiteral}`,
    `SELECT DISTINCT version, pattern_id FROM patterns WHERE city_code=${cityLiteral}`,
    `SELECT DISTINCT version, place_id FROM stop_places WHERE city_code=${cityLiteral}`,
    `SELECT active_version FROM dataset_versions WHERE city_code=${cityLiteral}`,
  ].join(';')
  const payload = queryRemoteD1(sql)
  return {
    routes: payload[0]?.results ?? [],
    patterns: payload[1]?.results ?? [],
    places: payload[2]?.results ?? [],
    active: payload[3]?.results ?? [],
  }
}
function guardedActivateSnapshot(expectedVersion, targetVersion, changedAt, updateSource = true) {
  const assignments = updateSource
    ? `active_version=${sqlValue(targetVersion)}, source_updated_at=${sqlValue(changedAt)}, imported_at=${sqlValue(changedAt)}`
    : `active_version=${sqlValue(targetVersion)}, imported_at=${sqlValue(changedAt)}`
  const statement = expectedVersion
    ? `UPDATE dataset_versions SET ${assignments} WHERE city_code=${sqlValue(CITY)} AND active_version=${sqlValue(expectedVersion)} RETURNING active_version`
    : `INSERT INTO dataset_versions(city_code, active_version, source_updated_at, imported_at) VALUES (${values(CITY, targetVersion, changedAt, changedAt)}) ON CONFLICT(city_code) DO NOTHING RETURNING active_version`
  const result = queryRemoteD1(statement)
  return result[0]?.results?.[0]?.active_version === targetVersion
}
function queryRemoteD1(sql) {
  const result = spawnSync(process.execPath, [
    'node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', DATABASE,
    '--remote', '--json', '--command', sql,
  // 大城市的既有列表 JSON 會超過 spawnSync 預設 1MB 的 maxBuffer,截斷會讓 JSON.parse 爆掉
  ], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (result.status !== 0) throw new Error('Unable to query remote D1')
  try {
    return JSON.parse(result.stdout)
  } catch {
    throw new Error('Unable to parse remote D1 result')
  }
}
async function queryActiveProbeD1(sql, params) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? snapshotVars.CLOUDFLARE_ACCOUNT_ID ?? workerVars.CLOUDFLARE_ACCOUNT_ID
  const apiToken = process.env.CLOUDFLARE_API_TOKEN ?? snapshotVars.CLOUDFLARE_API_TOKEN ?? workerVars.CLOUDFLARE_API_TOKEN
  if (accountId && apiToken) {
    return queryD1Rest({
      accountId,
      apiToken,
      databaseId: DATABASE_ID,
      fetchImpl: fetch,
      sql,
      params,
    })
  }
  // Local publishing may authenticate Wrangler interactively instead of carrying an API token.
  // Inputs are already strict city/version/sample values; use the existing remote CLI as fallback.
  const bound = bindSqlParameters(sql, params)
  return queryRemoteD1(bound)[0]?.results ?? []
}
function bindSqlParameters(sql, params) {
  let index = 0
  const bound = sql.replaceAll('?', () => {
    if (index >= params.length) throw new Error('Snapshot probe SQL parameter mismatch')
    return sqlValue(params[index++])
  })
  if (index !== params.length) throw new Error('Snapshot probe SQL parameter mismatch')
  return bound
}
