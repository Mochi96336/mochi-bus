import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tdxWarningMessages } from '../../src/domain/tdx-warning'
import type { DrawerView } from './drawer-view'
import type { NearbyPlace, PlaceRoute } from './map-api-client'
import type { PlaceRoutesPresentation } from './place-routes-controller'
import source from './place-routes-view.ts?raw'
import {
  createPlaceRoutesView,
  placeRouteEtaPresentation,
  placeRouteFailureMessage,
} from './place-routes-view'

class FakeClassList {
  private readonly values = new Set<string>()

  replace(value: string) {
    this.values.clear()
    for (const token of value.split(/\s+/).filter(Boolean)) this.values.add(token)
  }

  add(...tokens: string[]) {
    for (const token of tokens) this.values.add(token)
  }

  contains(token: string): boolean {
    return this.values.has(token)
  }
}

class FakeElement {
  readonly children: FakeElement[] = []
  readonly classList = new FakeClassList()
  readonly attributes = new Map<string, string>()
  readonly styles = new Map<string, string>()
  readonly style = { setProperty: (name: string, value: string) => this.styles.set(name, value) }
  readonly listeners = new Map<string, Array<(event: { stopPropagation(): void }) => void>>()
  textContent = ''
  type = ''
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

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value)
  }

  addEventListener(type: string, listener: (event: { stopPropagation(): void }) => void) {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  click() {
    for (const listener of this.listeners.get('click') ?? []) {
      listener({ stopPropagation() {} })
    }
  }
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

function place(): NearbyPlace {
  return {
    placeId: 'PLACE',
    name: '測試站牌',
    latitude: 25,
    longitude: 121,
    distanceMeters: 120,
  }
}

function route(overrides: Partial<PlaceRoute> = {}): PlaceRoute {
  return {
    routeUid: 'TPE-307',
    routeName: '307',
    variantKey: '307:0',
    direction: 0,
    label: '往撫遠街',
    subRouteName: '307',
    stopUid: 'STOP',
    stopName: '測試站牌',
    stopSequence: 1,
    estimateSeconds: 120,
    etaLabel: '2 分',
    stopStatus: 0,
    source: 'realtime',
    ...overrides,
  }
}

function createHarness() {
  let rendered: DrawerView | undefined
  const onBack = vi.fn()
  const onRetry = vi.fn()
  const onOpenRoute = vi.fn()
  const createFavoriteControl = vi.fn(() => element('button') as unknown as HTMLButtonElement)
  const createDegradedNotice = vi.fn((_message: string, retry: () => void, credentialRecovery = false) => {
    const notice = element('section')
    notice.className = 'degraded-notice'
    notice.setAttribute('credential-recovery', String(credentialRecovery))
    notice.addEventListener('click', retry)
    return notice as unknown as HTMLElement
  })
  const view = createPlaceRoutesView({
    renderDrawer: (drawerView) => { rendered = drawerView },
    createBackButton: (_label, onClick) => {
      const button = element('button')
      button.className = 'drawer-back'
      button.addEventListener('click', onClick)
      return button as unknown as HTMLButtonElement
    },
    createHeading: (title, description) => {
      const heading = element('header')
      heading.textContent = `${title}|${description}`
      return heading as unknown as HTMLElement
    },
    createDegradedNotice,
    backLabel: () => '附近站牌',
    onBack,
    onRetry,
    onOpenRoute,
    createFavoriteControl,
    isCredentialRecovery: (error) => error instanceof Error && error.message === 'credential',
  })
  return {
    view,
    rendered: () => rendered,
    onBack,
    onRetry,
    onOpenRoute,
    createFavoriteControl,
    createDegradedNotice,
  }
}

function scrollable(view: DrawerView | undefined): Exclude<DrawerView, { mode: 'compact' }> {
  if (!view || view.mode !== 'map-list') throw new Error('Expected map-list Drawer view')
  return view
}

beforeEach(() => {
  vi.stubGlobal('document', {
    createElement: (tagName: string) => element(tagName),
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Place routes view', () => {
  it('renders the three-row loading skeleton without owning status or navigation', () => {
    const harness = createHarness()
    harness.view.renderLoading({ cityCode: 'Taipei', place: place() })

    const drawer = scrollable(harness.rendered())
    expect(drawer.key).toBe('place:Taipei:PLACE')
    const loading = drawer.content[0] as unknown as FakeElement
    expect(loading.classList.contains('place-route-loading')).toBe(true)
    expect(loading.children).toHaveLength(3)
    expect(loading.children.every((child) => child.classList.contains('map-loading-row'))).toBe(true)
    ;(drawer.header[0] as unknown as FakeElement).click()
    expect(harness.onBack).toHaveBeenCalledOnce()
  })

  it('renders route color, ETA tone, stale freshness, favorite control, warning, and route callback', () => {
    const harness = createHarness()
    const staleRoute = route({ source: 'stale-realtime', etaLabel: '2 分', estimateSeconds: 120 })
    const presentation: PlaceRoutesPresentation = {
      cityCode: 'Taipei',
      place: place(),
      routes: [{ route: staleRoute, color: '#123456' }],
      warning: 'tdx-rate-limit',
    }

    harness.view.renderRoutes(presentation)

    const drawer = scrollable(harness.rendered())
    expect(harness.createDegradedNotice).toHaveBeenCalledWith(
      tdxWarningMessages['tdx-rate-limit'],
      expect.any(Function),
    )
    const list = drawer.content.at(-1) as unknown as FakeElement
    const row = findByClass(list, 'place-route-row')
    expect(row?.styles.get('--route-color')).toBe('#123456')
    const eta = row && findByClass(row, 'place-route-eta')
    expect(eta?.classList.contains('urgent')).toBe(true)
    expect(findByClass(eta!, 'eta-freshness')?.textContent).toBe('稍早')
    findByClass(row!, 'place-route-button')?.click()
    expect(harness.onOpenRoute).toHaveBeenCalledWith('307', '307:0', '#123456', 'STOP')
    expect(harness.createFavoriteControl).toHaveBeenCalledWith(place(), staleRoute)

    const warningRetry = harness.createDegradedNotice.mock.calls[0][1]
    warningRetry()
    expect(harness.onRetry).toHaveBeenCalledWith(place())
  })

  it('renders an error with credential recovery and returns the status message', () => {
    const harness = createHarness()
    const error = new Error('credential')

    expect(harness.view.renderError({ cityCode: 'Taipei', place: place(), error })).toBe('credential')

    const drawer = scrollable(harness.rendered())
    expect(drawer.key).toBe('place:Taipei:PLACE')
    expect(harness.createDegradedNotice).toHaveBeenCalledWith('credential', expect.any(Function), true)
    harness.createDegradedNotice.mock.calls[0][1]()
    expect(harness.onRetry).toHaveBeenCalledWith(place())
  })

  it('maps Place route ETA source to the established presentation language', () => {
    expect(placeRouteEtaPresentation(route({ source: 'schedule', etaLabel: '約 8 分', estimateSeconds: 480 })))
      .toMatchObject({ prefix: '約', value: '8', suffix: '分', tone: 'estimated', stale: false })
    expect(placeRouteEtaPresentation(route({ source: 'stale-realtime', etaLabel: '2 分', estimateSeconds: 120 })))
      .toMatchObject({ tone: 'urgent', stale: true })
    expect(placeRouteEtaPresentation(route({ source: 'none', etaLabel: '未發車', estimateSeconds: null })))
      .toMatchObject({ value: '未發車', tone: 'default', stale: false })
  })

  it('keeps the fallback error copy and stays outside app-shell ownership', () => {
    expect(placeRouteFailureMessage(null)).toBe('站牌路線讀取失敗')
    expect(source).not.toMatch(/from ['"]leaflet['"]|history-state|camera-controller|boards\/store/)
    for (const dependency of [
      'mapApi.',
      'history.',
      'camera.',
      'trip.',
      'routeDetail',
      'readBoards',
      'toggleFavoriteDirection',
      'setStatus(',
      'clearStatus(',
      'createPlaceRoutesController',
      'placeRoutes.open',
    ]) {
      expect(source).not.toContain(dependency)
    }
  })
})
