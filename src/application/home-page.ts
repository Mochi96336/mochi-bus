import type { BusQuery, ResolvedBusQuery } from '../domain/bus-query'
import { renderETAPage } from '../ui'

export type HomePageView = {
  demoQuery: BusQuery | null
  defaultCity: string
  notice?: string
  requestUrl: string
}

/** Render the local-first homepage without requiring a configured sample route. */
export function renderHomePage(view: HomePageView): string {
  const query = view.demoQuery ? resolvedDemoQuery(view.demoQuery) : undefined
  return renderETAPage({
    query,
    initialBoard: query ? undefined : null,
    mapCity: view.defaultCity,
    notice: view.notice,
    useLocalBoard: true,
    requestUrl: view.requestUrl,
  })
}

function resolvedDemoQuery(query: BusQuery): ResolvedBusQuery {
  if (!query.stopName || !query.stopUid) {
    throw new Error('Instance demoQuery must include stopName and stopUid')
  }
  return query as ResolvedBusQuery
}
