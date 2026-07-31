import { describe, expect, it } from 'vitest'
import { renderMapPage } from './map-page'
import { siteSearchDescription, siteSocialDescription, siteSocialImage, siteTitle } from './seo'
import { renderETAPage, renderRoutePage, renderSetupPage } from './ui'

const query = {
  city: 'Taipei',
  routeName: '307',
  stopName: '捷運西門站',
  stopUid: 'TPE213044',
  direction: 0 as const,
}

const requestUrl = 'https://bus.moc96336.com/bus?route=307&stop=%E6%8D%B7%E9%81%8B%E8%A5%BF%E9%96%80%E7%AB%99'

describe('SEO metadata', () => {
  it('renders homepage title, description, and site-name structured data', () => {
    const html = renderETAPage({ query, useLocalBoard: true, requestUrl })

    expect(html).toContain(`<title>${siteTitle}</title>`)
    expect(html).toContain(`<meta name="description" content="${siteSearchDescription}">`)
    expect(html).toContain(`<meta property="og:description" content="${siteSocialDescription}">`)
    expect(html).toContain('<meta property="og:site_name" content="Mochi Bus">')
    expect(html).toContain('<link rel="icon" href="/icon.svg" type="image/svg+xml">')
    expect(html).toContain('<link rel="icon" href="/favicon.ico" sizes="any">')
    expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png">')
    expect(html).toContain('<script type="application/ld+json">')
    expect(html).toContain('"@type":"WebSite"')
    expect(html).toContain('"name":"Mochi Bus"')
    expect(html).toContain('"alternateName":"Mochi Bus 台灣公車地圖"')
  })

  it('renders one semantic heading for the ETA page', () => {
    const html = renderETAPage({ query, useLocalBoard: false, requestUrl })

    expect(html).toContain('<h1 class="eyebrow" id="board-title">307 在 捷運西門站 的到站時間</h1>')
  })

  it('uses the route/stop-specific description for shareable pages, not the generic one', () => {
    const html = renderETAPage({ query, useLocalBoard: false, requestUrl })

    expect(html).toContain('<meta name="description" content="307 在捷運西門站的即時到站時間">')
    expect(html).not.toContain(`<meta name="description" content="${siteSearchDescription}">`)
  })

  it('renders a server-side heading for map pages', () => {
    const html = renderMapPage({ heading: '台北市公車地圖' })

    expect(html).toContain('<h1 class="map-page-title">台北市公車地圖</h1>')
  })

  it('makes persistent BYOK storage an explicit setup-page opt-in', () => {
    const html = renderSetupPage([['Taipei', '臺北']], requestUrl)

    expect(html).toContain('<label for="tdx-client-id">Client ID</label>')
    expect(html).toContain('<label for="tdx-client-secret">Client Secret</label>')
    expect(html).toContain('id="tdx-remember" type="checkbox"')
    expect(html).toContain('不勾選則關閉分頁後移除')
    expect(html).toContain('Mochi Bus Worker 不會收到 Client Secret')
  })

  // 互動邏輯(記住於此裝置 vs 只保留在此分頁、legacy migration 提示)已搬到
  // web/setup/main.ts,交給 Vite 建置與 TypeScript 檢查(ARCH-001);伺服器只
  // 負責掛上建好的 script,不再把行為字串直接嵌進 HTML 裡斷言。
  it('loads the setup page interactivity as a built module script, not an inline literal', () => {
    const html = renderSetupPage([['Taipei', '臺北']], requestUrl)

    expect(html).toContain('<script type="module" src="/assets/setup.js"></script>')
    expect(html).not.toContain("tdxRemember.checked?'device':'session'")
  })

  it('keeps the setup page (per-device local data) out of search indexes', () => {
    const html = renderSetupPage([['Taipei', '臺北']], requestUrl)

    expect(html).toContain('<meta name="robots" content="noindex">')
  })

  it('keeps informational disclosures neutral instead of styling them as primary actions', () => {
    const html = renderSetupPage([['Taipei', '臺北']], requestUrl)

    expect(html).toContain('.advanced-panel>summary,.glossary summary{color:var(--text-muted)}')
  })

  it('fades marquee text at fixed sign edges without masking the sign surface', () => {
    const html = renderETAPage({ query, useLocalBoard: true, requestUrl })

    expect(html).toContain('class="onboard-sign-text"')
    expect(html).toContain('.onboard-sign-text{position:relative;z-index:1;overflow:hidden;-webkit-mask-image:linear-gradient')
    expect(html).toContain('#000 32px')
    expect(html).not.toMatch(/\.onboard-sign\{[^}]*mask-image/)
    expect(html).not.toContain('.onboard-sign::before')
  })

  it('does not noindex the shareable ETA and map pages', () => {
    expect(renderETAPage({ query, useLocalBoard: true, requestUrl })).not.toContain('name="robots"')
    expect(renderMapPage({ heading: '台北市公車地圖' })).not.toContain('name="robots"')
  })

  it('gives chat-app link previews an image and Twitter Card metadata', () => {
    const eta = renderETAPage({ query, useLocalBoard: true, requestUrl })
    const map = renderMapPage({ heading: '台北市公車地圖' })

    for (const html of [eta, map]) {
      expect(html).toContain(`<meta property="og:image" content="${siteSocialImage}">`)
      expect(html).toContain('<meta name="twitter:card" content="summary">')
      expect(html).toContain(`<meta name="twitter:description" content="${siteSocialDescription}">`)
      expect(html).toContain(`<meta name="twitter:image" content="${siteSocialImage}">`)
    }
  })

  it('normalizes canonical and og:url to the production origin regardless of request host, per route/stop and per query', () => {
    const eta = renderETAPage({ query, useLocalBoard: false, requestUrl: 'http://localhost:8787/bus?route=307&stop=foo' })
    expect(eta).toContain('<link rel="canonical" href="https://bus.moc96336.com/bus?route=307&amp;stop=foo">')
    expect(eta).toContain('<meta property="og:url" content="https://bus.moc96336.com/bus?route=307&amp;stop=foo">')

    const setup = renderSetupPage([['Taipei', '臺北']], 'https://bus.moc96336.com/setup')
    expect(setup).toContain('<link rel="canonical" href="https://bus.moc96336.com/setup">')

    const map = renderMapPage({ heading: '台北市公車地圖', requestUrl: 'https://bus.moc96336.com/map?city=Taipei' })
    expect(map).toContain('<link rel="canonical" href="https://bus.moc96336.com/map?city=Taipei">')
    expect(map).toContain('<meta property="og:url" content="https://bus.moc96336.com/map?city=Taipei">')

    const mapDefault = renderMapPage({ heading: '台灣公車地圖' })
    expect(mapDefault).toContain('<link rel="canonical" href="https://bus.moc96336.com/map">')
  })
})

describe('route page', () => {
  const detail = {
    routeName: '307',
    direction: 0 as const,
    label: '板橋 → 撫遠街',
    stops: [
      { stopUid: 'TPE1', stopName: '板橋公車站', sequence: 1, selected: false, etaLabel: '12 分', etaTone: 'live' as const },
      { stopUid: 'TPE213044', stopName: '捷運西門站', sequence: 2, selected: true, etaLabel: '即將進站', etaTone: 'urgent' as const },
      { stopUid: 'TPE3', stopName: '撫遠街', sequence: 3, selected: false, etaLabel: null, etaTone: 'muted' as const },
    ],
  }

  it('states the direction once instead of repeating the badge route number', () => {
    const html = renderRoutePage(query, detail, requestUrl)

    expect(html).toContain('<span class="route-badge">307</span>')
    expect(html).toContain('<h1>板橋 → 撫遠街</h1>')
    expect(html).not.toContain('<h1>307 · 板橋 → 撫遠街</h1>')
  })

  it('goes back to the shareable cover page without a JavaScript URL', () => {
    const html = renderRoutePage(query, detail, requestUrl)

    expect(html).not.toContain('javascript:history.back()')
    expect(html).toMatch(/<a class="back-link" href="\/bus\?[^"]*route=307[^"]*">/)
  })

  it('keeps selection and ETA tones on separate visual planes', () => {
    const html = renderRoutePage(query, detail, requestUrl)

    expect(html).toContain('<span class="route-eta live">12 分</span>')
    expect(html).toContain('<span class="route-eta urgent">即將進站</span>')
    expect(html).toContain('<span class="route-eta muted"></span>')
    expect(html).toContain('<em>你的站牌</em>')
  })
})

describe('ETA bootstrap', () => {
  function bootstrapFrom(html: string): Record<string, unknown> {
    const match = html.match(/<script id="eta-bootstrap" type="application\/json">([\s\S]*?)<\/script>/)
    if (!match) throw new Error('missing ETA bootstrap')
    return JSON.parse(match[1]) as Record<string, unknown>
  }

  it('renders a typed bootstrap and external ETA entry for homepage and shared pages', () => {
    const homepage = renderETAPage({ query, useLocalBoard: true, requestUrl })
    const shared = renderETAPage({ query, useLocalBoard: false, requestUrl })

    for (const [html, local] of [[homepage, true], [shared, false]] as const) {
      expect(html).toContain('id="eta-bootstrap"')
      expect(html).toContain('type="application/json"')
      expect(html).toContain('<script type="module" src="/assets/eta.js"></script>')
      expect(html).not.toContain("import { activeBoardId")
      expect(html).not.toContain("from '/assets/boards.js'")
      expect(html).not.toContain('function refreshBoard()')
      expect(html).not.toContain("serviceWorker.register('/sw.js')")
      const bootstrap = bootstrapFrom(html)
      expect(bootstrap).toHaveProperty('initialBoard')
      expect(bootstrap).toHaveProperty('useLocalBoard', local)
      expect(bootstrap).toHaveProperty('tdxWarningMessages')
    }
  })

  it('escapes bootstrap JSON so a stop name cannot close the script element', () => {
    const maliciousQuery = {
      ...query,
      stopName: '</script><script>globalThis.pwned=true</script>',
    }
    const html = renderETAPage({ query: maliciousQuery, useLocalBoard: true, requestUrl })

    expect(html).not.toContain('</script><script>globalThis.pwned=true</script>')
    expect(html).toContain('\\u003c/script\\u003e\\u003cscript\\u003eglobalThis.pwned=true\\u003c/script\\u003e')
    expect(bootstrapFrom(html)).toMatchObject({ initialBoard: { title: maliciousQuery.stopName } })
  })

  it('keeps the server-rendered row, notice, and updated timestamp in the page shell', () => {
    const html = renderETAPage({
      query,
      result: {
        routeName: query.routeName,
        stopName: query.stopName,
        stopUid: query.stopUid,
        direction: query.direction,
        estimateSeconds: 120,
        minutes: 2,
        label: '約 2 分',
        stopStatus: 0,
        statusLabel: '正常',
        dataTime: '2026-07-13T07:00:00+08:00',
        fetchedAt: '2026-07-13T07:00:01+08:00',
        stale: false,
        source: 'realtime',
      },
      useLocalBoard: false,
      requestUrl,
    })

    expect(html).toContain('class="bus-eta urgent"')
    expect(html).toContain('<span class="eta-prefix">約</span><span class="eta-value">2</span><span class="eta-suffix">分</span>')
    expect(html).toContain('id="notice" aria-live="polite"></p>')
    expect(html).toContain('id="updated">資料 07:00:00</span>')
  })
})

describe('live region contract', () => {
  // 抽屜與封面看板都會整塊 replaceChildren。容器級 aria-live 會把整份內容重播一次,
  // 也讓內部的 role="status" 變成巢狀 live region。宣告一律交給專屬的小節點。
  const liveRegionPattern = /<([a-z]+)([^>]*\b(?:aria-live|role="status")[^>]*)>/g

  function liveRegions(html: string): string[] {
    return [...html.matchAll(liveRegionPattern)].map((match) => match[0])
  }

  it('keeps the map drawer out of live regions and announces through #map-status', () => {
    const html = renderMapPage({ heading: '台北市公車地圖' })

    expect(html).toContain('<aside id="map-drawer" class="map-drawer"></aside>')
    expect(html).toContain('<div id="map-status" class="map-status" aria-live="polite">')
    expect(liveRegions(html)).toHaveLength(1)
  })

  it('keeps the cover section out of live regions but keeps the notice announcing', () => {
    const html = renderETAPage({ query, useLocalBoard: true, requestUrl })

    expect(html).toContain('<section class="cover">')
    expect(html).not.toContain('class="cover" aria-live')
    expect(html).toContain('id="notice" aria-live="polite"')
  })

  it('gives the homepage a dedicated refresh status node outside the cover', () => {
    const html = renderETAPage({ query, useLocalBoard: true, requestUrl })
    const footer = html.slice(html.indexOf('<footer class="eta-footer">'))

    expect(footer).toContain('id="refresh-status" role="status" aria-live="polite"')
    expect(html).toContain('.visually-hidden{position:absolute')
  })

  it('never nests a live region inside another live region', () => {
    for (const html of [
      renderMapPage({ heading: '台北市公車地圖' }),
      renderETAPage({ query, useLocalBoard: true, requestUrl }),
      renderETAPage({ query, useLocalBoard: false, requestUrl }),
      renderSetupPage([['Taipei', '臺北市']], requestUrl),
    ]) {
      // 逐個 live region 開標籤往後掃到自身的結束標籤,確認區間內沒有第二個 live region。
      for (const match of html.matchAll(liveRegionPattern)) {
        const tag = match[1]
        const start = (match.index ?? 0) + match[0].length
        const end = html.indexOf(`</${tag}>`, start)
        expect(end).toBeGreaterThan(-1)
        expect(liveRegions(html.slice(start, end))).toEqual([])
      }
    }
  })
})
