import { mapCities } from './config/map-cities'
import {
  canonicalUrl,
  renderWebsiteStructuredData,
  siteName,
  siteOrigin,
  siteSearchDescription,
  siteSocialDescription,
  socialImageUrl,
  siteTitle,
} from './seo'

export type MapPageMeta = {
  title?: string
  description?: string
  heading?: string
  requestUrl?: string
}

// 深連結(?route= / ?city=)由伺服器端組標題:社群/聊天軟體的爬蟲不跑 JS,
// SSR 給對標題,分享出去的預覽卡才看得出是哪條路線;頁內切換另由前端更新 document.title。
export function renderMapPage(meta: MapPageMeta = {}): string {
  const title = meta.title ?? siteTitle
  const description = meta.description ?? siteSearchDescription
  const heading = meta.heading ?? '台灣公車地圖'
  const canonical = meta.requestUrl ? canonicalUrl(meta.requestUrl) : `${siteOrigin()}/map`
  const socialImage = socialImageUrl(canonical)
  // 城市清單是靜態設定,直接內嵌成 bootstrap:main.ts 不用先打一次
  // /api/v1/map/cities 才能開始還原 URL,深連結少一趟往返就少一段閃現。
  const statusText = meta.heading ? `${meta.heading} · 正在載入…` : '選一個區域，看看公車如何穿過城市。'
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="theme-color" content="#e8e2d6" media="(prefers-color-scheme: light)">
  <meta name="theme-color" content="#1d1c19" media="(prefers-color-scheme: dark)">
  <meta name="description" content="${escapeHTML(description)}">
  <link rel="canonical" href="${escapeHTML(canonical)}">
  <meta property="og:title" content="${escapeHTML(title)}">
  <meta property="og:description" content="${escapeHTML(siteSocialDescription)}">
  <meta property="og:site_name" content="${escapeHTML(siteName)}">
  <meta property="og:url" content="${escapeHTML(canonical)}">
  <meta property="og:image" content="${escapeHTML(socialImage)}">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="${escapeHTML(title)}">
  <meta name="twitter:description" content="${escapeHTML(siteSocialDescription)}">
  <meta name="twitter:image" content="${escapeHTML(socialImage)}">
  ${renderWebsiteStructuredData(canonical)}
  <link rel="manifest" href="/manifest.webmanifest">
  <link rel="icon" href="/icon.svg" type="image/svg+xml">
  <link rel="icon" href="/favicon.ico" sizes="any">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <title>${escapeHTML(title)}</title>
  <link rel="stylesheet" href="/assets/map.css">
  <link rel="modulepreload" href="/assets/map.js">
  <link rel="modulepreload" href="/assets/boards.js">
  <link rel="preconnect" href="https://tile.openstreetmap.org" crossorigin>
</head>
<body>
  <div id="map-app">
    <h1 class="map-page-title">${escapeHTML(heading)}</h1>
    <div id="map" aria-label="公車路線地圖"></div>
    <header class="map-header">
      <a id="map-brand" href="/map" class="map-brand" title="回到全台總覽">MOCHI <span>MAP</span></a>
      <a class="quiet-button map-home" href="/">首頁</a>
    </header>
    <!-- 可見的狀態列必須立即更新(loading gate 的延遲窗靠它填補),宣告卻要延後
         合併,兩者無法共用同一個 aria-live 節點,因此拆開:toast 只負責看,
         #map-announcer 只負責唸。 -->
    <div id="map-status" class="map-status">${escapeHTML(statusText)}</div>
    <div id="map-announcer" class="visually-hidden" role="status" aria-live="polite"></div>
    <!-- Drawer 不是 live region:每次換 view 都會 replaceChildren 整個抽屜,
         容器級 aria-live 會朗讀整份內容,也讓內部的 role="status" 變成巢狀。
         導覽宣告一律經 #map-status。 -->
    <aside id="map-drawer" class="map-drawer"></aside>
  </div>
  <script id="map-bootstrap" type="application/json">${safeJSON({ cities: mapCities, siteName })}</script>
  <script type="module" src="/assets/map.js"></script>
</body>
</html>`
}

function escapeHTML(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;')
}

function safeJSON(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029')
}
