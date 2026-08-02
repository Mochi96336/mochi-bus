import { writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { chromium } from '@playwright/test'
import { loadOperationalResources } from '../instance/operational-resources.mjs'
import {
  networkPrefixMatches,
  readBoundedResponseText,
} from '../transit-snapshot/active-probe.mjs'
import {
  ReleaseSmokeError,
  createReleaseSmokeEvent,
  discoverAssetGraph,
  runPostDeploySmoke,
  safeReleaseSmokeDiagnostic,
  validateArrivalsContract,
  validateReleaseIdentity,
  validateRouteContract,
  validateRoutesContract,
} from './post-deploy.mjs'

const REPORT_PATH = 'release-smoke-report.json'
const HTTP_TIMEOUT_MS = 20_000
const MAX_PAGE_BYTES = 1_048_576
const MAX_ASSET_BYTES = 4_194_304
const MAX_JSON_BYTES = 2_097_152
const NETWORK_PREFIX_BYTES = 65_536
const BROWSER_RELEASE_TIMEOUT_MS = 60_000
const BROWSER_RELEASE_POLL_MS = 5_000
const FULL_RELEASE_SHA = /^[0-9a-f]{40}$/
const SAFE_RELEASE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SECONDARY_CITY_CANARIES = Object.freeze(['Chiayi'])
const STATIC_PAGES = Object.freeze([
  Object.freeze({ path: '/', selector: '.eta-page' }),
  Object.freeze({ path: '/setup', selector: '.setup-page #board-list' }),
])
const HASHED_ASSET = /^\/assets\/[^/?]+-[A-Za-z0-9_-]{6,}\.(?:js|css)$/

export async function main(env = process.env) {
  const expectedSha = env.EXPECTED_RELEASE_SHA
  const smokeStartedAt = Date.now()
  try {
    const resources = loadOperationalResources()
    const targets = resolveReleaseSmokeTargets(resources)
    const origin = productionOrigin(env.RELEASE_SMOKE_ORIGIN ?? resources.publicOrigin)
    const token = smokeToken(env, expectedSha)
    const report = await runPostDeploySmoke({
      expectedSha,
      readRelease: () => readRelease(origin, token),
      probeHttp: ({ phase }) => probeHttpSurface({ origin, token, phase, targets }),
      probeBrowser: ({ releaseSha, workerVersionId }) => probeFreshBrowser({
        origin, token, releaseSha, workerVersionId, targets,
      }),
      propagationTimeoutMs: duration(env.RELEASE_SMOKE_PROPAGATION_MS, 300_000),
      pollIntervalMs: duration(env.RELEASE_SMOKE_POLL_MS, 10_000, false),
      observationWindowMs: duration(env.RELEASE_SMOKE_OBSERVATION_MS, 600_000),
      observationIntervalMs: duration(env.RELEASE_SMOKE_OBSERVATION_POLL_MS, 60_000, false),
    })
    await writeReport(report)
    console.log(JSON.stringify(createReleaseSmokeEvent({
      result: 'success',
      releaseSha: report.releaseSha,
      workerVersionId: report.workerVersionId,
      workerCreatedAt: report.workerCreatedAt,
      durationMs: Date.parse(report.completedAt) - Date.parse(report.startedAt),
    })))
  } catch (error) {
    const diagnostic = safeReleaseSmokeDiagnostic(error, expectedSha)
    await writeReport({ schemaVersion: 1, ...diagnostic })
    const event = diagnostic.releaseSha === null
      ? diagnostic
      : createReleaseSmokeEvent({
          result: 'error',
          releaseSha: diagnostic.releaseSha,
          workerVersionId: null,
          workerCreatedAt: null,
          durationMs: Math.max(0, Date.now() - smokeStartedAt),
          failureClass: diagnostic.failureClass,
        })
    console.error(JSON.stringify(event))
    process.exitCode = 1
  }
}

export function resolveReleaseSmokeTargets(resources) {
  const enabledCities = resources?.enabledCities
  const defaultCity = resources?.defaultCity
  const demoQuery = resources?.demoQuery
  if (!Array.isArray(enabledCities) || enabledCities.length === 0
    || enabledCities.some((city) => typeof city !== 'string' || city.length === 0)
    || new Set(enabledCities).size !== enabledCities.length
    || typeof defaultCity !== 'string' || !enabledCities.includes(defaultCity)
    || !(demoQuery === null || (demoQuery && typeof demoQuery === 'object'
      && typeof demoQuery.city === 'string' && enabledCities.includes(demoQuery.city)
      && typeof demoQuery.routeName === 'string' && demoQuery.routeName.length > 0))) {
    throw new ReleaseSmokeError('release_identity_invalid')
  }

  const detailCity = demoQuery?.city ?? defaultCity
  const cities = []
  for (const city of [
    detailCity,
    ...SECONDARY_CITY_CANARIES.filter((candidate) => enabledCities.includes(candidate)),
    defaultCity,
    ...enabledCities,
  ]) {
    if (!cities.includes(city)) cities.push(city)
    if (cities.length === Math.min(2, enabledCities.length)) break
  }
  const pages = Object.freeze([
    ...STATIC_PAGES,
    Object.freeze({
      path: `/map?city=${encodeURIComponent(defaultCity)}`,
      selector: '#map-app',
      bootSelector: '.leaflet-container',
    }),
  ])

  return Object.freeze({
    cities: Object.freeze(cities),
    defaultCity,
    detailCity,
    routeName: demoQuery?.routeName ?? null,
    pages,
  })
}

export function selectCatalogueRouteSample(routes, routeName = null) {
  if (!routes || !Array.isArray(routes.routes)
    || !(routeName === null || (typeof routeName === 'string' && routeName.length > 0))) {
    throw new ReleaseSmokeError('route_sample_missing')
  }
  const validRoutes = routes.routes.filter((candidate) => candidate
    && typeof candidate.routeName === 'string' && candidate.routeName.length > 0
    && typeof candidate.routeUid === 'string' && candidate.routeUid.length > 0)
  const selectedRouteName = routeName
    ?? [...new Set(validRoutes.map((candidate) => candidate.routeName))].sort()[0]
  if (!selectedRouteName) throw new ReleaseSmokeError('route_sample_missing')
  const routeUids = [...new Set(validRoutes
    .filter((candidate) => candidate.routeName === selectedRouteName)
    .map((candidate) => candidate.routeUid))].sort()
  if (routeUids.length === 0) throw new ReleaseSmokeError('route_sample_missing')
  return Object.freeze({ routeName: selectedRouteName, routeUids: Object.freeze(routeUids) })
}

export function validateCatalogueRouteContract(value, city, sample) {
  if (!sample || typeof sample.routeName !== 'string'
    || !Array.isArray(sample.routeUids) || sample.routeUids.length === 0) {
    throw new ReleaseSmokeError('route_contract_invalid')
  }
  for (const routeUid of sample.routeUids) {
    try {
      return validateRouteContract(value, city, { routeName: sample.routeName, routeUid })
    } catch (error) {
      if (!(error instanceof ReleaseSmokeError) || error.code !== 'route_contract_invalid') throw error
    }
  }
  throw new ReleaseSmokeError('route_contract_invalid')
}

export async function waitForBrowserReleaseIdentity({
  expectedSha,
  expectedWorkerVersionId,
  readRelease,
  now = () => Date.now(),
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  timeoutMs = BROWSER_RELEASE_TIMEOUT_MS,
  pollIntervalMs = BROWSER_RELEASE_POLL_MS,
}) {
  if (!FULL_RELEASE_SHA.test(String(expectedSha ?? ''))
    || typeof expectedWorkerVersionId !== 'string'
    || !SAFE_RELEASE_IDENTIFIER.test(expectedWorkerVersionId)
    || typeof readRelease !== 'function'
    || typeof now !== 'function'
    || typeof sleep !== 'function'
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 0
    || !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1) {
    throw new ReleaseSmokeError('release_identity_invalid')
  }

  const deadline = now() + timeoutMs
  let mismatchObserved = false
  while (true) {
    try {
      const identity = validateReleaseIdentity(await readRelease(), expectedSha)
      if (identity.workerVersionId === expectedWorkerVersionId) return identity
      mismatchObserved = true
    } catch (error) {
      if (error instanceof ReleaseSmokeError && error.code === 'release_not_observed') {
        mismatchObserved = true
      }
    }

    if (now() >= deadline) {
      throw new ReleaseSmokeError(mismatchObserved
        ? 'release_propagation_timeout'
        : 'release_observation_failed')
    }
    await sleep(Math.min(pollIntervalMs, deadline - now()))
  }
}

async function readRelease(origin, token) {
  return readJson(origin, addProbe('/api/v1/health/release', token, 'release'), 65_536, 'release_observation_failed')
}

async function probeHttpSurface({ origin, token, phase, targets }) {
  const assetCache = new Map()
  const allAssets = new Set()
  for (const page of targets.pages) {
    const response = await readText(origin, addProbe(page.path, token, phase), MAX_PAGE_BYTES, 'page_http_failed')
    if (!response.contentType.includes('text/html')
      || !/^<!doctype html>/i.test(response.body.trimStart())
      || !/<title>[^<]+<\/title>/i.test(response.body)) {
      throw new ReleaseSmokeError('page_contract_invalid')
    }
    const graph = await discoverAssetGraph({
      html: response.body,
      maxAssets: 64,
      readAsset: async (path) => {
        if (!assetCache.has(path)) {
          assetCache.set(path, await readStaticAsset(origin, path))
        }
        return assetCache.get(path)
      },
    })
    graph.forEach((path) => allAssets.add(path))
  }
  if (![...allAssets].some((path) => HASHED_ASSET.test(path))) {
    throw new ReleaseSmokeError('hashed_asset_missing')
  }

  const routesByCity = new Map()
  for (const city of targets.cities) {
    const routes = validateRoutesContract(await readJson(
      origin,
      addProbe(`/api/v1/map/routes?city=${encodeURIComponent(city)}`, token, `${phase}-${city}`),
      MAX_JSON_BYTES,
      'routes_contract_invalid',
    ), city)
    routesByCity.set(city, routes)
    const prefix = await readPrefix(
      origin,
      addProbe(`/api/v1/map/network?city=${encodeURIComponent(city)}`, token, `${phase}-${city}`),
      NETWORK_PREFIX_BYTES,
      'network_contract_invalid',
    )
    if (!networkPrefixMatches(prefix, city, routes.snapshotVersion)) {
      throw new ReleaseSmokeError('network_contract_invalid')
    }
  }

  const detailRoutes = routesByCity.get(targets.detailCity)
  const route = selectCatalogueRouteSample(detailRoutes, targets.routeName)
  const detail = await readJson(
    origin,
    addProbe(`/api/v1/map/route?city=${encodeURIComponent(targets.detailCity)}&route=${encodeURIComponent(route.routeName)}`, token, `${phase}-route`),
    MAX_JSON_BYTES,
    'route_http_failed',
  )
  const variant = validateCatalogueRouteContract(detail, targets.detailCity, route)
  const stopUid = variant.stops.features[0].properties.stopUid
  const place = await readJson(
    origin,
    addProbe(`/api/v1/map/stop-place?city=${encodeURIComponent(targets.detailCity)}&stopUid=${encodeURIComponent(stopUid)}`, token, `${phase}-place`),
    MAX_JSON_BYTES,
    'degraded_contract_invalid',
  )
  if (!place?.place || typeof place.place.placeId !== 'string' || place.place.placeId.length === 0) {
    throw new ReleaseSmokeError('degraded_contract_invalid')
  }
  const arrivals = validateArrivalsContract(await readJson(
    origin,
    addProbe(`/api/v1/map/place/${encodeURIComponent(place.place.placeId)}/arrivals?city=${encodeURIComponent(targets.detailCity)}`, token, `${phase}-arrivals`),
    MAX_JSON_BYTES,
    'degraded_contract_invalid',
  ), targets.detailCity, detailRoutes.snapshotVersion)

  return Object.freeze({
    phase,
    pages: targets.pages.length,
    assets: allAssets.size,
    hashedAssets: [...allAssets].filter((path) => HASHED_ASSET.test(path)).length,
    cities: targets.cities.length,
    degradedObserved: arrivals.warning !== null,
  })
}

async function probeFreshBrowser({ origin, token, releaseSha, workerVersionId, targets }) {
  let browser
  const totals = { pageErrors: 0, consoleErrors: 0, chunkFailures: 0 }
  const browserReleasePath = addProbe('/api/v1/health/release', token, 'browser-release')
  try {
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({
      baseURL: origin,
      locale: 'zh-TW',
      serviceWorkers: 'block',
    })
    for (const target of targets.pages) {
      const page = await context.newPage()
      await waitForBrowserReleaseIdentity({
        expectedSha: releaseSha,
        expectedWorkerVersionId: workerVersionId,
        readRelease: async () => {
          try {
            const response = await page.goto(browserReleasePath, {
              waitUntil: 'commit',
              timeout: 10_000,
            })
            if (!response || response.status() < 200 || response.status() >= 300) return null
            return response.json()
          } catch {
            return null
          }
        },
      })

      page.on('pageerror', () => { totals.pageErrors += 1 })
      page.on('console', (message) => {
        if (message.type() === 'error') totals.consoleErrors += 1
      })
      page.on('requestfailed', (request) => {
        try {
          const url = new URL(request.url())
          if (url.origin === origin
            && /^\/assets\/.+\.(?:js|css)$/.test(url.pathname)) totals.chunkFailures += 1
        } catch {
          totals.chunkFailures += 1
        }
      })
      const response = await page.goto(addProbe(target.path, token, 'browser'), {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      })
      if (!response || response.status() < 200 || response.status() >= 300) {
        throw new ReleaseSmokeError('browser_boot_failed')
      }
      await page.locator(target.selector).waitFor({ state: 'visible', timeout: 30_000 })
      if (target.bootSelector) {
        await page.locator(target.bootSelector).waitFor({ state: 'visible', timeout: 30_000 })
      }
      const ready = await page.evaluate(() => ({
        readyState: document.readyState,
        title: document.title,
      }))
      if (!['interactive', 'complete'].includes(ready.readyState) || !ready.title) {
        throw new ReleaseSmokeError('browser_boot_failed')
      }
      await page.close()
    }
    await context.close()
  } catch (error) {
    if (error instanceof ReleaseSmokeError) throw error
    throw new ReleaseSmokeError('browser_boot_failed')
  } finally {
    await browser?.close().catch(() => undefined)
  }
  if (totals.pageErrors > 0) throw new ReleaseSmokeError('browser_page_error')
  if (totals.consoleErrors > 0) throw new ReleaseSmokeError('browser_console_error')
  if (totals.chunkFailures > 0) throw new ReleaseSmokeError('browser_chunk_load_failed')
  return Object.freeze({ pages: targets.pages.length, ...totals })
}

async function readStaticAsset(origin, path) {
  const response = await readText(origin, path, MAX_ASSET_BYTES, 'asset_http_failed')
  const extension = path.split('.').at(-1)?.toLowerCase()
  if ((extension === 'js' && !response.contentType.includes('javascript'))
    || (extension === 'css' && !response.contentType.includes('text/css'))
    || response.contentType.includes('text/html')) {
    throw new ReleaseSmokeError('asset_contract_invalid')
  }
  return response
}

async function readJson(origin, path, maximumBytes, failureClass) {
  const response = await readText(origin, path, maximumBytes, failureClass)
  if (!response.contentType.includes('json')) throw new ReleaseSmokeError(failureClass)
  try {
    return JSON.parse(response.body)
  } catch {
    throw new ReleaseSmokeError(failureClass)
  }
}

async function readText(origin, path, maximumBytes, failureClass) {
  let response
  try {
    response = await fetch(new URL(path, origin), {
      headers: {
        'Cache-Control': 'no-cache',
        'User-Agent': 'mochi-bus-release-smoke/1',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
  } catch {
    throw new ReleaseSmokeError(failureClass)
  }
  if (!response.ok) throw new ReleaseSmokeError(failureClass)
  try {
    return Object.freeze({
      contentType: response.headers.get('Content-Type')?.toLowerCase() ?? '',
      body: await readBoundedResponseText(response, maximumBytes),
    })
  } catch {
    throw new ReleaseSmokeError(failureClass)
  }
}

async function readPrefix(origin, path, maximumBytes, failureClass) {
  let response
  try {
    response = await fetch(new URL(path, origin), {
      headers: {
        'Cache-Control': 'no-cache',
        'User-Agent': 'mochi-bus-release-smoke/1',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
  } catch {
    throw new ReleaseSmokeError(failureClass)
  }
  if (!response.ok || !response.body) throw new ReleaseSmokeError(failureClass)
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
      text += decoder.decode(chunk, { stream: bytes < maximumBytes })
      if (chunk.byteLength < value.byteLength) break
    }
  } catch {
    throw new ReleaseSmokeError(failureClass)
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  if (!text) throw new ReleaseSmokeError(failureClass)
  return text
}

function addProbe(path, token, phase) {
  const url = new URL(path, 'https://release-smoke.invalid')
  url.searchParams.set('release_smoke', `${token}:${phase}`)
  return `${url.pathname}${url.search}`
}

function productionOrigin(value) {
  if (!value) throw new ReleaseSmokeError('release_identity_invalid')
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new ReleaseSmokeError('release_identity_invalid')
  }
  return url.origin
}

function smokeToken(env, expectedSha) {
  const run = String(env.GITHUB_RUN_ID ?? 'local').replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 48)
  const sha = typeof expectedSha === 'string' ? expectedSha.slice(0, 12) : 'unknown'
  return `${run || 'local'}:${sha}`
}

function duration(value, fallback, allowZero = true) {
  if (value === undefined || value === '') return fallback
  const number = Number(value)
  if (!Number.isSafeInteger(number) || (allowZero ? number < 0 : number < 1)) {
    throw new ReleaseSmokeError('release_identity_invalid')
  }
  return number
}

async function writeReport(report) {
  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
