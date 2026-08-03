import { instanceOrigin, siteName } from './instance-runtime'
import { renderWebsiteStructuredData, socialImageUrl } from './seo'

const PRODUCT_SITE_NAME = 'Mochi Bus'

type InstanceHtmlIdentity = Readonly<{
  siteName: string
  socialImage: string
  structuredData: string
}>

export async function applyInstanceResponse(response: Response, requestUrl: string): Promise<Response> {
  const url = new URL(requestUrl)
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''

  if (contentType.includes('text/html')) {
    return replaceResponseBody(response, applyInstanceHtml(await response.text(), requestUrl))
  }

  if (url.pathname === '/manifest.webmanifest') {
    return replaceResponseBody(response, rewriteManifestText(await response.text()))
  }

  if (url.pathname === '/robots.txt' || url.pathname === '/sitemap.xml') {
    return replaceResponseBody(response, rewritePublicOrigin(await response.text(), requestUrl))
  }

  return response
}

export function applyInstanceHtml(
  html: string,
  requestUrl: string,
  identity: InstanceHtmlIdentity = {
    siteName,
    socialImage: socialImageUrl(requestUrl),
    structuredData: renderWebsiteStructuredData(requestUrl),
  },
): string {
  const escapedName = escapeHTML(identity.siteName)
  let result = setHtmlSiteName(html, escapedName)

  result = result
    .replace(/(<title>)([\s\S]*?)(<\/title>)/i, (_match, open, title, close) =>
      `${open}${configuredDocumentTitle(title, escapedName)}${close}`)
    .replace(/(<meta property="og:title" content=")([^"]*)(">)/gi, (_match, open, title, close) =>
      `${open}${configuredDocumentTitle(title, escapedName)}${close}`)
    .replace(/(<meta name="twitter:title" content=")([^"]*)(">)/gi, (_match, open, title, close) =>
      `${open}${configuredDocumentTitle(title, escapedName)}${close}`)
    .replace(/(<meta property="og:site_name" content=")[^"]*(">)/gi, `$1${escapedName}$2`)
    .replace(/(<meta property="og:image" content=")[^"]*(">)/gi, `$1${escapeHTML(identity.socialImage)}$2`)
    .replace(/(<meta name="twitter:image" content=")[^"]*(">)/gi, `$1${escapeHTML(identity.socialImage)}$2`)

  const structuredDataPattern = /<script type="application\/ld\+json">[\s\S]*?<\/script>/i
  result = structuredDataPattern.test(result)
    ? result.replace(structuredDataPattern, identity.structuredData)
    : result.replace('</head>', `${identity.structuredData}</head>`)

  if (identity.siteName !== PRODUCT_SITE_NAME) {
    result = result.replace(
      /(<a\b[^>]*\bclass="[^"]*\bbrand\b[^"]*"[^>]*>)[\s\S]*?(<\/a>)/gi,
      `$1${escapedName}$2`,
    )

    if (!result.includes('data-instance-title-normalizer')) {
      result = result.replace(
        '</body>',
        `<script data-instance-title-normalizer>${instanceTitleScript(identity.siteName)}</script></body>`,
      )
    }
  }

  return result
}

export function configuredDocumentTitle(title: string, configuredName: string): string {
  return configuredName === PRODUCT_SITE_NAME
    ? title
    : title.replaceAll(`｜${PRODUCT_SITE_NAME}`, `｜${configuredName}`)
}

export function rewriteManifestText(body: string, configuredName = siteName): string {
  try {
    const manifest = JSON.parse(body) as Record<string, unknown>
    return JSON.stringify({ ...manifest, name: configuredName })
  } catch {
    return body
  }
}

export function rewritePublicOrigin(
  body: string,
  requestUrl: string,
  canonicalOrigin = instanceOrigin(requestUrl),
): string {
  return body.replaceAll(new URL(requestUrl).origin, canonicalOrigin)
}

export function instanceTitleScript(configuredName: string): string {
  const name = safeScriptJSON(configuredName)
  const productName = safeScriptJSON(PRODUCT_SITE_NAME)
  return `(function(n,p){var t=document.querySelector('title');if(!t||n===p)return;var f=function(){var v=document.title;var x=v.split('｜'+p).join('｜'+n);if(x!==v)document.title=x;};new MutationObserver(f).observe(t,{childList:true,characterData:true,subtree:true});f();})(${name},${productName});`
}

function setHtmlSiteName(html: string, escapedName: string): string {
  if (/<html\b[^>]*\bdata-site-name=/i.test(html)) {
    return html.replace(/(<html\b[^>]*\bdata-site-name=")[^"]*(")/i, `$1${escapedName}$2`)
  }
  return html.replace(/<html\b/i, `<html data-site-name="${escapedName}"`)
}

function replaceResponseBody(response: Response, body: string): Response {
  const headers = new Headers(response.headers)
  headers.delete('content-length')
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function safeScriptJSON(value: string): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
}

function escapeHTML(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}
