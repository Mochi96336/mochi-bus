import type { BusQuery, ResolvedBusQuery } from '../domain/bus-query'
import { renderETAPage } from '../ui'

export type HomePageView = {
  demoQuery: BusQuery | null
  defaultCity: string
  notice?: string
  requestUrl: string
}

/**
 * Render the local-first homepage without requiring every instance to publish a
 * sample route. renderETAPage still owns the shared shell; for a no-demo
 * instance we remove its temporary server-only board from the JSON bootstrap
 * before the response leaves the Worker.
 */
export function renderHomePage(view: HomePageView): string {
  if (view.demoQuery) {
    return renderETAPage({
      query: resolvedDemoQuery(view.demoQuery),
      notice: view.notice,
      useLocalBoard: true,
      requestUrl: view.requestUrl,
    })
  }

  const shellQuery: ResolvedBusQuery = {
    city: view.defaultCity,
    routeName: '',
    stopName: '',
    stopUid: '',
    direction: 0,
  }
  const html = renderETAPage({
    query: shellQuery,
    notice: view.notice,
    useLocalBoard: true,
    requestUrl: view.requestUrl,
  })
  return replaceInitialBoard(html, null)
}

function resolvedDemoQuery(query: BusQuery): ResolvedBusQuery {
  if (!query.stopName || !query.stopUid) {
    throw new Error('Instance demoQuery must include stopName and stopUid')
  }
  return query as ResolvedBusQuery
}

function replaceInitialBoard(html: string, initialBoard: null): string {
  const marker = '<script id="eta-bootstrap" type="application/json">'
  const start = html.indexOf(marker)
  if (start < 0) throw new Error('ETA page is missing its bootstrap script')
  const contentStart = start + marker.length
  const end = html.indexOf('</script>', contentStart)
  if (end < 0) throw new Error('ETA bootstrap script is not closed')

  const bootstrap = JSON.parse(html.slice(contentStart, end)) as Record<string, unknown>
  bootstrap.initialBoard = initialBoard
  return html.slice(0, contentStart) + safeJSON(bootstrap) + html.slice(end)
}

function safeJSON(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029')
}
