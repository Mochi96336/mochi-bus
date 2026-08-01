import {
  canonicalOriginPolicy,
  instanceOrigin,
  siteName,
} from './instance-runtime'

export { siteName }
export const siteTitle = `${siteName}｜台灣公車地圖與到站看板`
export const siteSearchDescription = '台灣公車地圖與到站看板。查看常用站牌到站時間、探索全城路網、站牌路線與即時車輛位置。'
export const siteSocialDescription = '先看懂城市的公車路網，再決定怎麼搭車。'

export function siteOrigin(requestUrl?: string): string {
  return instanceOrigin(requestUrl)
}

export function socialImageUrl(requestUrl?: string): string {
  return `${siteOrigin(requestUrl)}/apple-touch-icon.png`
}

// 固定正式網域可以在建置時給完整絕對網址；request 模式必須等到真的收到
// 請求才知道 origin，沒有請求上下文的舊呼叫點先保留同源相對路徑，絕不退回
// 作者的 production 網域。
export const siteSocialImage = canonicalOriginPolicy === 'request'
  ? '/apple-touch-icon.png'
  : socialImageUrl()

// canonical/og:url 依 instance policy 決定：operator 可固定正式網域，starter
// 則跟隨實際 request origin。兩者都只保留 path/query，不保留 fragment。
export function canonicalUrl(requestUrl: string): string {
  const url = new URL(requestUrl)
  return `${siteOrigin(requestUrl)}${url.pathname}${url.search}`
}

export function renderWebsiteStructuredData(requestUrl?: string): string {
  const origin = canonicalOriginPolicy === 'request' && !requestUrl
    ? undefined
    : siteOrigin(requestUrl)
  const websiteStructuredData = {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: siteName,
    alternateName: `${siteName} 台灣公車地圖`,
    ...(origin ? { url: `${origin}/` } : {}),
    description: siteSearchDescription,
    inLanguage: 'zh-TW',
  }
  return `<script type="application/ld+json">${JSON.stringify(websiteStructuredData)}</script>`
}
