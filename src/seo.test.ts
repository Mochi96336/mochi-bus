import { describe, expect, it } from 'vitest'
import {
  canonicalUrl,
  renderWebsiteStructuredData,
  siteName,
  siteSocialImage,
  siteTitle,
} from './seo'

describe('configured SEO identity', () => {
  it('keeps the reference instance canonical origin while preserving path and query', () => {
    expect(canonicalUrl('https://preview.example/map?city=Chiayi#route'))
      .toBe('https://bus.moc96336.com/map?city=Chiayi')
  })

  it('derives titles, social image, and structured data from the production manifest', () => {
    expect(siteName).toBe('Mochi Bus')
    expect(siteTitle).toBe('Mochi Bus｜台灣公車地圖與到站看板')
    expect(siteSocialImage).toBe('https://bus.moc96336.com/apple-touch-icon.png')

    const markup = renderWebsiteStructuredData()
    expect(markup).toContain('"name":"Mochi Bus"')
    expect(markup).toContain('"url":"https://bus.moc96336.com/"')
    expect(markup).not.toContain('preview.example')
  })
})
