import type { DrawerView, DrawerViewSession } from './drawer-view'
import type { NearbyPlace } from './map-api-client'

export type NearbyOrigin = readonly [latitude: number, longitude: number]

type NearbyViewBase = {
  cityCode: string
  origin: NearbyOrigin
  backLabel: string
  onBack: () => void
}

export type NearbyPlacesLoadingView = NearbyViewBase

export type NearbyPlacesPresentation = NearbyViewBase & {
  places: readonly NearbyPlace[]
}

export type NearbyPlacesFailureView = NearbyViewBase & {
  error: unknown
  onRetry: () => void
}

type NearbyPlacesViewOptions = {
  renderDrawer: (view: DrawerView) => DrawerViewSession
  createBackButton: (label: string, onClick: () => void) => HTMLButtonElement
  createHeading: (title: string, description: string) => HTMLElement
  createRetryButton: (onClick: () => void) => HTMLButtonElement
  createTripModeButton: () => HTMLButtonElement
  onOpenPlace: (place: NearbyPlace) => void
}

export type NearbyPlacesView = {
  renderLoading(view: NearbyPlacesLoadingView): void
  renderPlaces(view: NearbyPlacesPresentation): void
  renderError(view: NearbyPlacesFailureView): string
}

export function createNearbyPlacesView(options: NearbyPlacesViewOptions): NearbyPlacesView {
  function drawerKey(cityCode: string, origin: NearbyOrigin): string {
    return `nearby:${cityCode}:${origin[0].toFixed(5)}:${origin[1].toFixed(5)}`
  }

  function drawerHeader(title: string, description: string, backLabel: string, onBack: () => void): Node[] {
    return [
      options.createBackButton(backLabel, onBack),
      options.createHeading(title, description),
    ]
  }

  return {
    renderLoading({ cityCode, origin, backLabel, onBack }) {
      const loadingList = document.createElement('div')
      loadingList.className = 'place-route-loading'
      for (let index = 0; index < 3; index += 1) {
        const skeleton = document.createElement('div')
        skeleton.className = 'place-route-skeleton'
        loadingList.appendChild(skeleton)
      }
      options.renderDrawer({
        key: drawerKey(cityCode, origin),
        mode: 'map-list',
        preserveDesktopHeight: true,
        header: drawerHeader('附近站牌', '正在搜尋附近站牌', backLabel, onBack),
        content: [loadingList],
      })
    },

    renderPlaces({ cityCode, origin, places, backLabel, onBack }) {
      const list = document.createElement('div')
      list.className = 'nearby-list'
      if (!places.length) list.appendChild(paragraph('500 公尺內沒有收錄到站牌，換個位置試試。'))
      for (const place of places) {
        const button = document.createElement('button')
        button.className = 'nearby-place-button'
        const name = document.createElement('strong')
        name.textContent = place.name
        const distance = document.createElement('span')
        distance.textContent = `${Math.round(place.distanceMeters)} m`
        button.appendChild(name)
        button.appendChild(distance)
        button.addEventListener('click', () => options.onOpenPlace(place))
        list.appendChild(button)
      }
      const session = options.renderDrawer({
        key: drawerKey(cityCode, origin),
        mode: 'map-list',
        preserveDesktopHeight: places.length > 0,
        header: drawerHeader(
          '附近站牌',
          places.length
            ? `${places.length} 個附近站牌，點任一站牌預覽所有經過路線。`
            : '附近沒有站牌。',
          backLabel,
          onBack,
        ),
        content: [list],
        footer: [options.createTripModeButton()],
      })
      if (places.length) {
        const frame = requestAnimationFrame(() => session.releasePreservedHeight())
        session.onDispose(() => cancelAnimationFrame(frame))
      }
    },

    renderError({ cityCode, origin, error, backLabel, onBack, onRetry }) {
      const message = nearbyPlacesFailureMessage(error)
      options.renderDrawer({
        key: drawerKey(cityCode, origin),
        mode: 'map-list',
        header: drawerHeader('附近站牌讀取失敗', message, backLabel, onBack),
        content: [options.createRetryButton(onRetry)],
      })
      return message
    },
  }
}

export function nearbyPlacesFailureMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '附近站牌讀取失敗'
}

function paragraph(text: string): HTMLParagraphElement {
  const node = document.createElement('p')
  node.className = 'drawer-copy'
  node.textContent = text
  return node
}
