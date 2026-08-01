import { Hono, type Context } from 'hono'
import { getRoutePageWithFallback } from '../application/route-page'
import {
  defaultBusQuery,
  defaultCity,
  enabledCities,
  requireEnabledCity,
  supportedCityCodes,
} from '../config'
import {
  canonicalBusPath,
  parseBusQuery,
  toBusSearchParams,
  type BusQuery,
} from '../domain/bus-query'
import { embedRoutePageIdentity } from '../domain/route-page-identity'
import {
  getCommuteETA,
  getRouteCatalog,
  getRouteStopGroups,
  getStopRouteSuggestions,
  QueryResolutionError,
  resolveBusQuery,
  TDXServiceError,
  tdxWarningFromError,
  tdxWarningMessages,
  withTDXBackgroundTasks,
  withUserTDXAccessToken,
  type TDXEnv,
  type TDXWarning,
} from '../lib/tdx'
import { appIcon, renderAmbiguousPage, renderErrorPage, renderETAPage, renderRoutePage, renderSetupPage } from '../ui'
import { presentBusApiError } from '../presentation/api-error'
import { presentPageError, publicErrorMessage } from '../presentation/page-error'
import {
  getSnapshotRouteCatalog,
  getStopPlaceByStopUid,
  type TransitBindings,
} from '../infrastructure/transit/snapshot-repository'
import { enabledMapCities } from '../config/map-cities'
import { siteSearchDescription } from '../seo'
import {
  optionalQueryString,
  parseTdxAccessToken,
  requiredQueryString,
} from '../lib/api-input'

type Env = { Bindings: TDXEnv & TransitBindings }
const bus = new Hono<Env>()

// 瀏覽器直接向 TDX 換 token；Worker 只接收短效 token，永遠不接觸 Client Secret。
const tdxEnv = (c: Context<Env>) => {
  const env = withUserTDXAccessToken(c.env, parseTdxAccessToken(c.req.header('Authorization')))
  try {
    const executionCtx = c.executionCtx
    return withTDXBackgroundTasks(env, (promise) => executionCtx.waitUntil(promise))
  } catch {
    return env
  }
}

bus.get('/', async (c) => renderETA(c, defaultBusQuery, true, true, homeNotice(c)))

bus.get('/bus', async (c) => {
  if (!hasBusQuery(c)) return c.redirect('/')

  try {
    const query = parseRequestQuery(c)
    const resolved = await resolveBusQuery(tdxEnv(c), query)
    if (!query.stopUid
      || query.stopName !== resolved.stopName
      || query.routeUid !== resolved.routeUid
      || query.subRouteUid !== resolved.subRouteUid) {
      return c.redirect(canonicalBusPath(resolved), 302)
    }
    return renderETA(c, resolved, false, true)
  } catch (error) {
    if (error instanceof QueryResolutionError && error.candidates.length > 1) {
      const query = parseRequestQuery(c)
      return c.html(renderAmbiguousPage(query, error.candidates, c.req.url), 409, pageHeaders)
    }
    if (error instanceof TDXServiceError) {
      // TDX 掛掉(額度用完/頻率超限/連不上)時不丟錯誤頁:URL 帶齊識別碼就先信它、
      // 跳過站牌驗證照常渲染,已存書籤還能看時刻表 fallback;資訊不足的查詢才回首頁並帶提示。
      const query = parseRequestQuery(c)
      if (query.stopUid && query.stopName) return renderETA(c, query, false, true)
      return redirectHomeWithTDXNotice(c, error)
    }
    return renderPageError(c, error)
  }
})

bus.get('/setup', (c) => c.html(renderSetupPage(enabledCities, c.req.url), 200, pageHeaders))

export type RoutePageHandlerDependencies = {
  getRoutePageWithFallback: typeof getRoutePageWithFallback
}

const defaultRoutePageHandlerDependencies: RoutePageHandlerDependencies = {
  getRoutePageWithFallback,
}

export function createRoutePageHandler(
  dependencies: RoutePageHandlerDependencies = defaultRoutePageHandlerDependencies,
) {
  return async (c: Context<Env>) => {
    let query: BusQuery
    try {
      query = parseRequestQuery(c)
    } catch (error) {
      return renderPageError(c, error)
    }
    try {
      const page = await dependencies.getRoutePageWithFallback({
        tdx: tdxEnv(c),
        snapshot: c.env,
      }, query)
      return c.html(
        embedRoutePageIdentity(renderRoutePage(page.resolved, page.detail, c.req.url), page.detail),
        200,
        pageHeaders,
      )
    } catch (error) {
      return renderPageError(c, error)
    }
  }
}

bus.get('/route', createRoutePageHandler())

bus.get('/api/v1/eta', async (c) => {
  try {
    const env = tdxEnv(c)
    const query = parseRequestQuery(c)
    const resolved = query.stopUid && query.stopName
      ? query as BusQuery & { stopUid: string; stopName: string }
      : await resolveBusQuery(env, query)
    const result = await getCommuteETA(env, resolved)
    return c.json(result, 200, noStoreHeaders)
  } catch (error) {
    return jsonError(c, error)
  }
})

bus.get('/api/v1/stops', async (c) => {
  try {
    const city = requireEnabledCity(c.req.query('city')?.trim() || defaultCity)
    const routeName = requiredQueryString(c.req.query('route'), '公車路線', 40)
    const routeUid = optionalQueryString(c.req.query('routeUid'), 'RouteUID', 100)

    const groups = await getRouteStopGroups(tdxEnv(c), city, routeName, routeUid)
    return c.json({ schemaVersion: 2, city, routeName, routeUid: routeUid ?? null, groups }, 200, {
      'Cache-Control': 'public, max-age=300',
    })
  } catch (error) {
    return jsonError(c, error)
  }
})

bus.get('/api/v1/routes', async (c) => {
  try {
    const city = requireEnabledCity(c.req.query('city')?.trim() || defaultCity)
    // 快照目錄優先:除了省 TDX 額度,也只有它包含攤入本縣市的公路客運路線;
    // 沒建快照的縣市才退回 TDX 即時目錄(只有市區公車)。
    const snapshotRoutes = await getSnapshotRouteCatalog(c.env, city)
    const routes = snapshotRoutes.length ? snapshotRoutes : await getRouteCatalog(tdxEnv(c), city)
    // TDX 原始目錄已在 edge 快取；API schema 不交給瀏覽器長快取，避免舊欄位卡住 UI。
    return c.json({ schemaVersion: 2, city, routes }, 200, noStoreHeaders)
  } catch (error) {
    return jsonError(c, error)
  }
})

bus.get('/api/v1/stop-routes', async (c) => {
  try {
    const city = requireEnabledCity(c.req.query('city')?.trim() || defaultCity)
    const stopName = requiredQueryString(c.req.query('stop'), '站牌名稱', 80)
    const stopUid = optionalQueryString(c.req.query('stopUid'), 'StopUID', 100)
    const [buses, place] = await Promise.all([
      getStopRouteSuggestions(tdxEnv(c), city, stopName, stopUid),
      stopUid ? getStopPlaceByStopUid(c.env, city, stopUid) : Promise.resolve(null),
    ])
    return c.json({ city, stopName, place, buses }, 200, noStoreHeaders)
  } catch (error) {
    return jsonError(c, error)
  }
})

bus.get('/robots.txt', (c) => c.text([
  'User-agent: *',
  // API 是無限的查詢參數空間,別讓爬蟲在裡面亂逛
  'Disallow: /api/',
  `Sitemap: ${new URL('/sitemap.xml', c.req.url)}`,
  '',
].join('\n'), 200, { 'Cache-Control': 'public, max-age=86400' }))

bus.get('/sitemap.xml', (c) => {
  const origin = new URL(c.req.url).origin
  // 只列有意義的固定進入點與這個實例真正提供的縣市深連結。
  const urls = [
    '/',
    '/map',
    '/setup',
    ...enabledMapCities.map((city) => `/map?city=${city.code}`),
  ]
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${
    urls.map((path) => `  <url><loc>${origin}${path.replaceAll('&', '&amp;')}</loc></url>`).join('\n')
  }\n</urlset>`
  return c.body(body, 200, {
    'Content-Type': 'application/xml; charset=utf-8',
    'Cache-Control': 'public, max-age=86400',
  })
})

bus.get('/manifest.webmanifest', (c) => c.json({
  name: 'Mochi Bus',
  short_name: '公車到站',
  description: siteSearchDescription,
  start_url: '/',
  display: 'standalone',
  background_color: '#f7f2e8',
  theme_color: '#f7f2e8',
  icons: [
    { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
    { src: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png', purpose: 'any maskable' },
  ],
}, 200, {
  'Content-Type': 'application/manifest+json; charset=utf-8',
  'Cache-Control': 'public, max-age=86400',
}))

bus.get('/icon.svg', (c) => c.body(appIcon, 200, {
  'Content-Type': 'image/svg+xml; charset=utf-8',
  'Cache-Control': 'public, max-age=86400',
}))

bus.get('/sw.js', (c) => c.body(`
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(fetch(event.request).catch(() => new Response(
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>body{font-family:system-ui;padding:32px;background:#f7f2e8;color:#29251f}</style><h1>目前沒有網路</h1><p>到站時間要連線才拿得到，等訊號回來再試一次。</p>',
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  )));
});`, 200, {
  'Content-Type': 'text/javascript; charset=utf-8',
  'Cache-Control': 'no-cache',
  'Service-Worker-Allowed': '/',
}))

async function renderETA(
  c: Context<Env>,
  query: BusQuery,
  useLocalPreset: boolean,
  alreadyResolved = false,
  notice?: string,
) {
  const preResolved = query.stopUid && query.stopName
    ? query as BusQuery & { stopUid: string; stopName: string }
    : undefined
  // 首頁的看板內容一律由 eta.js 依 localStorage 重建,伺服器只出 skeleton;
  // 這裡抓 ETA 只會浪費 TDX 配額,還讓使用者先看到會被推翻的預設 307。
  if (useLocalPreset && preResolved) {
    return c.html(renderETAPage({ query: preResolved, notice, useLocalBoard: true, requestUrl: c.req.url }), 200, pageHeaders)
  }
  try {
    const env = tdxEnv(c)
    const resolved = alreadyResolved && preResolved ? preResolved : await resolveBusQuery(env, query)
    const result = await getCommuteETA(env, resolved)
    return c.html(renderETAPage({ query: resolved, result, notice, useLocalBoard: useLocalPreset, requestUrl: c.req.url }), 200, pageHeaders)
  } catch (error) {
    console.error('eta_page_failed', error)
    // 出錯也盡量渲染頁面本體(帶錯誤訊息),別讓 TDX 故障把整頁打成錯誤頁;
    // query 帶齊識別碼就直接用,不再打一次注定失敗的 resolveBusQuery。
    try {
      const resolved = preResolved ?? await resolveBusQuery(tdxEnv(c), query)
      return c.html(renderETAPage({ query: resolved, error: toPublicError(error), notice, useLocalBoard: useLocalPreset, requestUrl: c.req.url }), 200, pageHeaders)
    } catch {
      return renderPageError(c, error)
    }
  }
}

function parseRequestQuery(c: Context<Env>): BusQuery {
  const input = c.req.query()
  const city = requireEnabledCity(input.city || defaultCity)
  return parseBusQuery(
    { ...input, city },
    undefined,
    supportedCityCodes,
  )
}

function hasBusQuery(c: Context<Env>): boolean {
  return Boolean(c.req.query('route') || c.req.query('routeName'))
}

// 導回首頁時用 ?notice= 帶原因(值就是 TDXWarning),首頁據此顯示服務橫幅。
// `in` 會沿原型鏈找,`?notice=constructor` 這類使用者輸入會被誤判成合法 key,
// 取出的是 Object/Function 之類的原型成員而非字串,後面 escapeHTML() 對它
// 呼叫 .replaceAll 會直接丟 TypeError;改用 Object.hasOwn() 只認自身屬性。
export function resolveTDXNotice(value: string | undefined): string | undefined {
  return value && Object.hasOwn(tdxWarningMessages, value) ? tdxWarningMessages[value as TDXWarning] : undefined
}

function homeNotice(c: Context<Env>): string | undefined {
  return resolveTDXNotice(c.req.query('notice'))
}

function redirectHomeWithTDXNotice(c: Context<Env>, error: TDXServiceError) {
  return c.redirect(`/?notice=${tdxWarningFromError(error) ?? 'tdx-unavailable'}`, 302)
}

function renderPageError(c: Context<Env>, error: unknown) {
  const presentation = presentPageError(error, '/setup')
  const actionsHTML = presentation.actions
    .map(({ href, label }) => `<a href="${escapeHTML(href)}">${escapeHTML(label)}</a>`)
    .join('')
  return c.html(renderErrorPage({
    title: presentation.title,
    message: presentation.message,
    actionsHTML,
    requestUrl: c.req.url,
  }), presentation.status)
}

function jsonError(c: Context<Env>, error: unknown) {
  const presentation = presentBusApiError(error, c.req.header('Authorization'))
  if (presentation.shouldLog) console.error('bus_api_failed', error)
  return c.json(presentation.body, presentation.status, noStoreHeaders)
}

function toPublicError(error: unknown): string {
  return publicErrorMessage(error)
}

function escapeHTML(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;')
}

const noStoreHeaders = { 'Cache-Control': 'no-store' }
const pageHeaders = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
}

export default bus
