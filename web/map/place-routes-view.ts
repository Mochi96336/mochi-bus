import { etaPresentation, type EtaPresentation } from '../../src/domain/eta-presentation'
import { tdxWarningMessages } from '../../src/domain/tdx-warning'
import type { NearbyPlace, PlaceRoute } from './map-api-client'
import type {
  PlaceRouteFailure,
  PlaceRoutesPresentation,
  PlaceRouteStart,
} from './place-routes-controller'
import type { DrawerView, DrawerViewSession } from './drawer-view'
import { createPlaceRouteLoadingList } from './loading-skeleton'

type PlaceRoutesViewOptions = {
  renderDrawer: (view: DrawerView) => DrawerViewSession
  createBackButton: (label: string, onClick: () => void) => HTMLButtonElement
  createHeading: (title: string, description: string) => HTMLElement
  createDegradedNotice: (message: string, onRetry: () => void, credentialRecovery?: boolean) => HTMLElement
  backLabel: () => string
  onBack: () => void
  onRetry: (place: NearbyPlace) => void
  onOpenRoute: (routeName: string, variantKey: string, color: string, stopUid: string) => void
  createFavoriteControl: (place: NearbyPlace, route: PlaceRoute) => HTMLButtonElement
  isCredentialRecovery: (error: unknown) => boolean
}

export type PlaceRoutesView = {
  renderLoading(start: PlaceRouteStart): void
  renderRoutes(presentation: PlaceRoutesPresentation): void
  renderError(failure: PlaceRouteFailure): string
}

export function createPlaceRoutesView(options: PlaceRoutesViewOptions): PlaceRoutesView {
  function drawerHeader(place: NearbyPlace, description: string): Node[] {
    return [
      options.createBackButton(options.backLabel(), options.onBack),
      options.createHeading(place.name, description),
    ]
  }

  function retry(place: NearbyPlace): () => void {
    return () => options.onRetry(place)
  }

  function renderSettled(view: DrawerView): void {
    const session = options.renderDrawer({ ...view, size: 'standard', preserveDesktopHeight: true })
    const frame = requestAnimationFrame(() => session.releasePreservedHeight())
    session.onDispose(() => cancelAnimationFrame(frame))
  }

  return {
    renderLoading({ cityCode, place }) {
      options.renderDrawer({
        key: `place:${cityCode}:${place.placeId}`,
        mode: 'map-list',
        size: 'standard',
        preserveDesktopHeight: true,
        header: drawerHeader(place, '正在取得路線與到站時間'),
        content: [createPlaceRouteLoadingList()],
      })
    },

    renderRoutes({ cityCode, place, routes, warning }) {
      const list = document.createElement('div')
      list.className = 'place-route-list'
      for (const { route, color } of routes) {
        const row = document.createElement('div')
        row.className = 'place-route-row'
        row.style.setProperty('--route-color', color)

        const button = document.createElement('button')
        button.className = 'place-route-button'
        const tick = document.createElement('span')
        tick.className = 'route-color-tick'
        tick.setAttribute('aria-hidden', 'true')
        const line = document.createElement('span')
        line.className = 'place-route-main'
        const routeName = document.createElement('strong')
        routeName.textContent = route.routeName
        const eta = placeRouteEtaNode(route)
        line.appendChild(routeName)
        line.appendChild(eta)
        const detail = document.createElement('small')
        detail.textContent = route.label
        button.appendChild(tick)
        button.appendChild(line)
        button.appendChild(detail)
        button.addEventListener('click', () => options.onOpenRoute(
          route.routeName,
          route.variantKey,
          color,
          route.stopUid,
        ))

        row.appendChild(button)
        row.appendChild(options.createFavoriteControl(place, route))
        list.appendChild(row)
      }

      renderSettled({
        key: `place:${cityCode}:${place.placeId}`,
        mode: 'map-list',
        header: drawerHeader(
          place,
          `${place.distanceMeters > 0 ? `${Math.round(place.distanceMeters)} 公尺 · ` : ''}${routes.length} 個行車方向`,
        ),
        content: [
          ...(warning
            ? [options.createDegradedNotice(tdxWarningMessages[warning], retry(place))]
            : []),
          list,
        ],
      })
    },

    renderError({ cityCode, place, error }) {
      const message = placeRouteFailureMessage(error)
      renderSettled({
        key: `place:${cityCode}:${place.placeId}`,
        mode: 'map-list',
        header: drawerHeader(place, message),
        content: [options.createDegradedNotice(
          message,
          retry(place),
          options.isCredentialRecovery(error),
        )],
      })
      return message
    },
  }
}

export function placeRouteEtaPresentation(route: Pick<PlaceRoute, 'etaLabel' | 'source' | 'estimateSeconds'>): EtaPresentation {
  return etaPresentation(route.etaLabel, {
    source: route.source,
    estimateSeconds: route.estimateSeconds,
  })
}

export function placeRouteFailureMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '站牌路線讀取失敗'
}

function placeRouteEtaNode(route: PlaceRoute): HTMLSpanElement {
  const presentation = placeRouteEtaPresentation(route)
  const node = document.createElement('span')
  node.classList.add('place-route-eta')
  if (presentation.tone !== 'default') node.classList.add(presentation.tone)
  if (presentation.prefix) {
    const prefix = document.createElement('small')
    prefix.className = 'eta-prefix'
    prefix.textContent = presentation.prefix
    node.appendChild(prefix)
  }
  const value = document.createElement('b')
  value.className = 'eta-value'
  value.textContent = presentation.value
  node.appendChild(value)
  if (presentation.suffix) {
    const suffix = document.createElement('small')
    suffix.className = 'eta-suffix'
    suffix.textContent = presentation.suffix
    node.appendChild(suffix)
  }
  if (presentation.stale) {
    const freshness = document.createElement('small')
    freshness.className = 'eta-freshness'
    freshness.textContent = '稍早'
    node.appendChild(freshness)
  }
  return node
}
