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

describe('instance homepage', () => {
  it('keeps the configured demo board when one exists', () => {
    const html = renderHomePage({
      demoQuery,
      defaultCity: 'Taipei',
      requestUrl: 'https://example.com/',
    })

    expect(html).toContain('"initialBoard":{"version":2')
    expect(html).toContain('"routeName":"307"')
  })

  it('publishes a null bootstrap and no placeholder route without a demo', () => {
    const html = renderHomePage({
      demoQuery: null,
      defaultCity: 'Chiayi',
      requestUrl: 'https://chiayi.example.com/',
    })

    expect(html).toContain('"initialBoard":null')
    expect(html).not.toContain('"routeName":""')
    expect(html).not.toContain('"stopUid":""')
  })
})
