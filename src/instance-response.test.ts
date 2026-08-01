import { describe, expect, it } from 'vitest'
import {
  applyInstanceHtml,
  configuredDocumentTitle,
  rewriteManifestText,
  rewritePublicOrigin,
} from './instance-response'

const customIdentity = {
  siteName: 'Chiayi Transit',
  socialImage: 'https://chiayi.example/apple-touch-icon.png',
  structuredData: '<script type="application/ld+json">{"name":"Chiayi Transit","url":"https://chiayi.example/"}</script>',
} as const

describe('instance public response identity', () => {
  it('rewrites every legacy HTML identity surface and installs dynamic title normalization', () => {
    const html = `<!doctype html><html lang="zh-Hant"><head>
      <meta property="og:title" content="我的公車｜Mochi Bus">
      <meta property="og:site_name" content="Mochi Bus">
      <meta property="og:image" content="/apple-touch-icon.png">
      <meta name="twitter:title" content="我的公車｜Mochi Bus">
      <meta name="twitter:image" content="/apple-touch-icon.png">
      <script type="application/ld+json">{"name":"Mochi Bus"}</script>
      <title>我的公車｜Mochi Bus</title>
    </head><body><a class="brand" href="/">MOCHI <span>BUS</span></a></body></html>`

    const output = applyInstanceHtml(html, 'https://chiayi.example/setup', customIdentity)

    expect(output).toContain('<html data-site-name="Chiayi Transit" lang="zh-Hant">')
    expect(output).toContain('<title>我的公車｜Chiayi Transit</title>')
    expect(output).toContain('property="og:site_name" content="Chiayi Transit"')
    expect(output).toContain('property="og:image" content="https://chiayi.example/apple-touch-icon.png"')
    expect(output).toContain('name="twitter:image" content="https://chiayi.example/apple-touch-icon.png"')
    expect(output).toContain(customIdentity.structuredData)
    expect(output).toContain('<a class="brand" href="/">Chiayi Transit</a>')
    expect(output).toContain('data-instance-title-normalizer')
    expect(output).not.toContain('｜Mochi Bus')
  })

  it('keeps production titles stable and rewrites custom suffixes deterministically', () => {
    expect(configuredDocumentTitle('公車地圖｜Mochi Bus', 'Mochi Bus'))
      .toBe('公車地圖｜Mochi Bus')
    expect(configuredDocumentTitle('公車地圖｜Mochi Bus', 'Chiayi Transit'))
      .toBe('公車地圖｜Chiayi Transit')
  })

  it('derives manifest identity and canonical public-document origins', () => {
    expect(JSON.parse(rewriteManifestText('{"name":"Mochi Bus","start_url":"/"}', 'Chiayi Transit')))
      .toEqual({ name: 'Chiayi Transit', start_url: '/' })
    expect(rewritePublicOrigin(
      'Sitemap: https://preview.example/sitemap.xml',
      'https://preview.example/robots.txt',
      'https://chiayi.example',
    )).toBe('Sitemap: https://chiayi.example/sitemap.xml')
  })
})
