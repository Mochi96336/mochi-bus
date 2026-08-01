import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DrawerView, DrawerViewSession } from './drawer-view'
import type { NearbyPlace } from './map-api-client'
import source from './nearby-places-view.ts?raw'
import {
  createNearbyPlacesView,
  nearbyPlacesFailureMessage,
  type NearbyOrigin,
} from './nearby-places-view'

class FakeClassList {
  private readonly values = new Set<string>()

  replace(value: string) {
    this.values.clear()
    for (const token of value.split(/\s+/).filter(Boolean)) this.values.add(token)
  }

  contains(token: string): boolean {
    return this.values.has(token)
  }
}

class FakeElement {
  readonly children: FakeElement[] = []
  readonly classList = new FakeClassList()
  readonly listeners = new Map<string, Array<() => void>>()
  textContent = ''
  private classValue = ''

  constructor(readonly tagName: string) {}

  get className(): string {
    return this.classValue
  }

  set className(value: string) {
    this.classValue = value
    this.classList.replace(value)
  }

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child)
    return child
  }

  addEventListener(type: string, listener: () => void) {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  click() {
    for (const listener of this.listeners.get('click') ?? []) listener()
  }
}

type FakeSession = {
  controller: AbortController
  cleanups: Array<() => void>
  session: DrawerViewSession
}

function element(tagName = 'div'): FakeElement {
  return new FakeElement(tagName)
}

function findByClass(root: FakeElement, className: string): FakeElement | undefined {
  if (root.classList.contains(className)) return root
  for (const child of root.children) {
    const found = findByClass(child, className)
    if (found) return found
  }
  return undefined
}

function place(id: string, name: string, distanceMeters: number): NearbyPlace {
  return { placeId: id, name, latitude: 25, longitude: 121, distanceMeters }
}

function createHarness() {
  let rendered: DrawerView | undefined
  let currentSession: FakeSession | undefined
  const onOpenPlace = vi.fn()
  const createTripModeButton = vi.fn(() => element('button') as unknown as HTMLButtonElement)
  const view = createNearbyPlacesView({
    renderDrawer: (drawerView) => {
      if (currentSession) {
        currentSession.controller.abort()
        for (const cleanup of currentSession.cleanups.splice(0).reverse()) cleanup()
      }
      rendered = drawerView
      const controller = new AbortController()
      const cleanups: Array<() => void> = []
      const session: DrawerViewSession = {
        signal: controller.signal,
        onDispose(cleanup) { cleanups.push(cleanup) },
      }
      currentSession = { controller, cleanups, session }
      return session
    },
    createBackButton: (label, onClick) => {
      const button = element('button')
      button.className = 'drawer-back'
      button.textContent = label
      button.addEventListener('click', onClick)
      return button as unknown as HTMLButtonElement
    },
    createHeading: (title, description) => {
      const heading = element('header')
      heading.textContent = `${title}|${description}`
      return heading as unknown as HTMLElement
    },
    createRetryButton: (onClick) => {
      const button = element('button')
      button.className = 'quiet-button'
      button.addEventListener('click', onClick)
      return button as unknown as HTMLButtonElement
    },
    createTripModeButton,
    onOpenPlace,
  })
  return { view, rendered: () => rendered, onOpenPlace, createTripModeButton }
}

function scrollable(view: DrawerView | undefined): Exclude<DrawerView, { mode: 'compact' }> {
  if (!view || view.mode !== 'map-list') throw new Error('Expected map-list Drawer view')
  return view
}

const origin: NearbyOrigin = [25.01234, 121.56789]

beforeEach(() => {
  vi.stubGlobal('document', { createElement: (tagName: string) => element(tagName) })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Nearby places view', () => {
  it('renders the loading skeleton at the nearby size without deciding the height itself', () => {
    const harness = createHarness()
    const onBack = vi.fn()
    harness.view.renderLoading({ cityCode: 'Taipei', origin, backLabel: '附近站牌', onBack })
    const drawer = scrollable(harness.rendered())
    expect(drawer.key).toBe('nearby:Taipei:25.01234:121.56789')
    expect(drawer.size).toBe('nearby')
    // 骨架標記為 transient:抽屜已經有高度時沿用它,size 只是首次繪製的退路。
    expect(drawer.transient).toBe(true)
    expect((drawer.header[1] as unknown as FakeElement).textContent).toBe('附近站牌|正在搜尋附近站牌')
    const loading = drawer.content[0] as unknown as FakeElement
    expect(loading.classList.contains('map-loading-list')).toBe(true)
    expect(loading.children).toHaveLength(3)
    expect(loading.children.every((child) => child.classList.contains('map-loading-row'))).toBe(true)
    ;(drawer.header[0] as unknown as FakeElement).click()
    expect(onBack).toHaveBeenCalledOnce()
  })

  it('renders rounded distances, opens the selected place, and includes the Trip footer', () => {
    const harness = createHarness()
    const places = [place('A', '市政府', 120.4), place('B', '捷運站', 48.7)]
    harness.view.renderPlaces({ cityCode: 'Taipei', origin, places, backLabel: '路線列表', onBack: vi.fn() })
    const drawer = scrollable(harness.rendered())
    expect(drawer.size).toBe('nearby')
    // 結果就是最終內容,由它決定高度。
    expect(drawer.transient).toBeUndefined()
    expect((drawer.header[1] as unknown as FakeElement).textContent)
      .toBe('附近站牌|2 個附近站牌，點任一站牌預覽所有經過路線。')
    const list = drawer.content[0] as unknown as FakeElement
    expect(list.classList.contains('nearby-list')).toBe(true)
    expect(list.children[0].children.map((child) => child.textContent)).toEqual(['市政府', '120 m'])
    expect(list.children[1].children.map((child) => child.textContent)).toEqual(['捷運站', '49 m'])
    list.children[1].click()
    expect(harness.onOpenPlace).toHaveBeenCalledWith(places[1])
    expect(drawer.footer).toHaveLength(1)
    expect(harness.createTripModeButton).toHaveBeenCalledOnce()
  })

  it('renders the existing empty-state copy at the same nearby size', () => {
    const harness = createHarness()
    harness.view.renderPlaces({ cityCode: 'Taipei', origin, places: [], backLabel: '返回行程候選', onBack: vi.fn() })
    const drawer = scrollable(harness.rendered())
    expect(drawer.size).toBe('nearby')
    expect((drawer.header[1] as unknown as FakeElement).textContent).toBe('附近站牌|附近沒有站牌。')
    const list = drawer.content[0] as unknown as FakeElement
    expect(list.children).toHaveLength(1)
    expect(list.children[0].classList.contains('drawer-copy')).toBe(true)
    expect(list.children[0].textContent).toBe('500 公尺內沒有收錄到站牌，換個位置試試。')
    expect(findByClass(list, 'nearby-place-button')).toBeUndefined()
  })

  it('renders active error text and delegates retry and back actions', () => {
    const harness = createHarness()
    const onBack = vi.fn()
    const onRetry = vi.fn()
    const message = harness.view.renderError({
      cityCode: 'Taipei', origin, error: new Error('附近服務忙碌中'), backLabel: '附近站牌', onBack, onRetry,
    })
    expect(message).toBe('附近服務忙碌中')
    const drawer = scrollable(harness.rendered())
    expect(drawer.size).toBe('nearby')
    expect((drawer.header[1] as unknown as FakeElement).textContent).toBe('附近站牌讀取失敗|附近服務忙碌中')
    ;(drawer.header[0] as unknown as FakeElement).click()
    ;(drawer.content[0] as unknown as FakeElement).click()
    expect(onBack).toHaveBeenCalledOnce()
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('uses a stable fallback failure message', () => {
    expect(nearbyPlacesFailureMessage(undefined)).toBe('附近站牌讀取失敗')
    expect(nearbyPlacesFailureMessage(new Error(''))).toBe('附近站牌讀取失敗')
  })

  it('does not acquire browser, map, request, History, camera, Trip, or status ownership', () => {
    for (const dependency of [
      'leaflet', 'history.', 'window.', 'mapApi.', 'camera.', 'trip.', 'AbortController',
      'beginNavRequest', 'isStaleNav', 'nearbyLayer', 'setStatus(', 'clearStatus(',
      'openNearbyPlace', './main',
    ]) expect(source).not.toContain(dependency)
  })
})
