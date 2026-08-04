import { describe, expect, it } from 'vitest'
import { renderHomePage } from './home-page'

const demoQuery = {
  city: 'Taipei',
  routeName: '307',
  stopName: '捷運西門站',
  stopUid: 'TPE213044',
  routeUid: 'TPE19108',
  direction: 0 as const,
}

function bootstrapFrom(html: string): Record<string, unknown> {
  const match = html.match(/<script id="eta-bootstrap" type="application\/json">([\s\S]*?)<\/script>/)
  if (!match) throw new Error('missing ETA bootstrap')
  return JSON.parse(match[1]) as Record<string, unknown>
}

describe('instance homepage', () => {
  it('keeps the configured demo board when one exists', () => {
    const html = renderHomePage({
      demoQuery,
      defaultCity: 'Taipei',
      requestUrl: 'https://example.com/',
    })

    expect(bootstrapFrom(html)).toMatchObject({
      initialBoard: { version: 2, title: '捷運西門站', buses: [{ routeName: '307' }] },
      useLocalBoard: true,
    })
  })

  it('publishes a first-class null bootstrap without manufacturing a route', () => {
    const html = renderHomePage({
      demoQuery: null,
      defaultCity: 'Chiayi',
      notice: '即時資料暫時無法更新',
      requestUrl: 'https://chiayi.example.com/',
    })

    expect(bootstrapFrom(html)).toMatchObject({ initialBoard: null, useLocalBoard: true })
    expect(html).toContain('href="/map?city=Chiayi"')
    expect(html).not.toContain('"routeName":""')
    expect(html).not.toContain('"stopUid":""')
  })

  it('validates and restores a saved frame before the deferred ETA module', () => {
    const html = renderHomePage({
      demoQuery: null,
      defaultCity: 'Taipei',
      requestUrl: 'https://example.com/',
    })

    const headBootstrap = html.indexOf('id="mochi-home-snapshot-first-paint"')
    const headEnd = html.indexOf('</head>')
    const inlineRestore = html.indexOf('id="mochi-home-snapshot-inline-restore"')
    const etaBootstrap = html.indexOf('id="eta-bootstrap"')
    const etaModule = html.indexOf('src="/assets/eta.js"')

    expect(headBootstrap).toBeGreaterThan(0)
    expect(headBootstrap).toBeLessThan(headEnd)
    expect(inlineRestore).toBeGreaterThan(headEnd)
    expect(inlineRestore).toBeLessThan(etaBootstrap)
    expect(etaBootstrap).toBeLessThan(etaModule)
    expect(html).toContain('__mochiHomeSnapshotCandidate')
    expect(html).toContain('data-mochi-home-snapshot-pending')
  })
})
