import type { Route } from '@playwright/test'
import { expect, test, type Page } from './fixtures'

const city = { code: 'Tainan', name: '臺南', region: 'south', center: [22.997, 120.212] }
const place = {
  placeId: 'P1',
  name: '臺南火車站',
  latitude: 22.997,
  longitude: 120.212,
  distanceMeters: 76,
}
const routeEntry = {
  routeName: '中山幹線',
  routeUid: 'R1',
  variantKey: 'R1:0',
  direction: 0 as const,
  label: '大臺南公園 → 嘉義大學校區內',
  subRouteUid: 'R1',
  subRouteName: '中山幹線',
  stopUid: 'P1-S',
  stopName: '臺南火車站',
  stopSequence: 2,
  estimateSeconds: 120,
  etaLabel: '2 分',
  stopStatus: 0,
  source: 'realtime' as const,
}

type DrawerFrame = {
  top: number
  height: number
  view: string
  mode: string
  phase: string
}

function variant() {
  return {
    variantKey: routeEntry.variantKey,
    routeName: routeEntry.routeName,
    routeUid: routeEntry.routeUid,
    subRouteUid: routeEntry.subRouteUid,
    direction: 0 as const,
    label: routeEntry.label,
    subRouteName: routeEntry.subRouteName,
    updatedAt: null,
    shape: {
      type: 'Feature' as const,
      properties: {},
      geometry: {
        type: 'LineString' as const,
        coordinates: [[120.209, 22.997], [120.212, 22.997], [120.215, 22.997]],
      },
    },
    stops: {
      type: 'FeatureCollection' as const,
      features: [{
        type: 'Feature' as const,
        properties: { stopUid: routeEntry.stopUid, stopName: routeEntry.stopName, sequence: 2 },
        geometry: { type: 'Point' as const, coordinates: [120.212, 22.997] as [number, number] },
      }],
    },
  }
}

function deferred() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

async function fulfillAfter(route: Route, gate: Promise<void>, json: unknown) {
  await gate
  try {
    await route.fulfill({ json })
  } catch {
    // A newer navigation may abort a delayed request; a closed route is expected in that case.
  }
}

async function mockBootstrap(page: Page, routeCount = 80) {
  await page.route('https://tile.openstreetmap.org/**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/v1/map/cities', (route) => route.fulfill({ json: { cities: [city] } }))
  await page.route(/\/api\/v1\/map\/routes(?:\?|$)/, (route) => route.fulfill({
    json: {
      routes: Array.from({ length: routeCount }, (_, index) => ({
        routeName: index === 0 ? routeEntry.routeName : `測試路線 ${index + 1}`,
        category: index % 4 === 0 ? '幹線' : '數字',
      })),
    },
  }))
  await page.route('**/api/v1/map/vehicles*', (route) => route.fulfill({ json: { vehicles: [] } }))
  await page.route('**/api/v1/map/timetable*', (route) => route.fulfill({
    json: {
      timetable: {
        mode: 'none',
        selectedStop: null,
        departureStop: null,
        stops: [],
        timedStopCount: 0,
        services: [],
      },
    },
  }))
}

async function startDrawerFrameCapture(page: Page) {
  await page.evaluate(() => {
    type Frame = { top: number; height: number; view: string; mode: string; phase: string }
    type FrameStore = { active: boolean; frames: Frame[] }
    const store: FrameStore = { active: true, frames: [] }
    ;(window as Window & { __drawerFrameStore?: FrameStore }).__drawerFrameStore = store
    const drawer = document.getElementById('map-drawer')!
    const sample = () => {
      if (!store.active) return
      const rect = drawer.getBoundingClientRect()
      const heading = drawer.querySelector<HTMLElement>('.drawer-heading h1')?.textContent ?? ''
      let phase = 'other'
      if (heading === '臺南') phase = 'catalogue'
      else if (drawer.querySelector('.place-route-row')) phase = 'place-results'
      else if (drawer.querySelector('.place-route-skeleton')) {
        phase = heading === '附近站牌' ? 'nearby-loading' : 'place-loading'
      } else if (drawer.querySelector('.variant-list')) phase = 'variant-picker'
      else if (heading === '中山幹線' && drawer.querySelector('.route-service-summary')) phase = 'route-results'
      else if (heading === '中山幹線') phase = 'route-loading'
      store.frames.push({
        top: rect.top,
        height: rect.height,
        view: drawer.dataset.view ?? '',
        mode: drawer.dataset.mode ?? '',
        phase,
      })
      window.requestAnimationFrame(sample)
    }
    window.requestAnimationFrame(sample)
  })
}

async function stopDrawerFrameCapture(page: Page): Promise<DrawerFrame[]> {
  return page.evaluate(() => {
    type Frame = { top: number; height: number; view: string; mode: string; phase: string }
    type FrameStore = { active: boolean; frames: Frame[] }
    const store = (window as Window & { __drawerFrameStore?: FrameStore }).__drawerFrameStore!
    store.active = false
    return store.frames
  })
}

function expectStableFrames(frames: DrawerFrame[], phases: string[]) {
  const selected = frames.filter((frame) => phases.includes(frame.phase))
  expect(new Set(selected.map((frame) => frame.phase))).toEqual(new Set(phases))
  expect(Math.max(...selected.map((frame) => frame.top)) - Math.min(...selected.map((frame) => frame.top))).toBeLessThanOrEqual(1)
  expect(Math.max(...selected.map((frame) => frame.height)) - Math.min(...selected.map((frame) => frame.height))).toBeLessThanOrEqual(1)
}

async function openNetwork(page: Page) {
  const network = page.getByRole('button', { name: '切換全路網與全部站點' })
  await network.click()
  await expect(network).toHaveAttribute('aria-pressed', 'true')
  await expect(network).not.toHaveAttribute('aria-busy')
}

async function clickDesktopStageCenter(page: Page) {
  const mapBox = await page.locator('#map').boundingBox()
  const drawerBox = await page.locator('#map-drawer').boundingBox()
  if (!mapBox || !drawerBox) throw new Error('map stage has no layout box')
  // focusPoint places the city center in the drawer-aware visible stage. These offsets mirror
  // the desktop camera padding constants: left 45, top 90, bottom 45, safety gap 48.
  const targetX = mapBox.x + (drawerBox.x - mapBox.x + 45 - 48) / 2
  const targetY = mapBox.y + mapBox.height / 2 + (90 - 45) / 2
  await page.mouse.click(targetX, targetY)
}

test('keeps stop lookup loading steps stable, then releases the desktop height for resolved content', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const nearby = deferred()
  const nearbyRequested = deferred()
  const arrivals = deferred()
  const arrivalsRequested = deferred()
  const preview = deferred()
  const previewRequested = deferred()

  await mockBootstrap(page)
  await page.route('**/api/v1/map/network*', (route) => route.fulfill({
    json: {
      version: 'desktop-stop-stability',
      routes: [],
      places: [{
        placeId: place.placeId,
        name: place.name,
        latitude: place.latitude,
        longitude: place.longitude,
      }],
    },
  }))
  await page.route(/\/api\/v1\/map\/nearby(?:\?|$)/, async (route) => {
    nearbyRequested.release()
    await fulfillAfter(route, nearby.promise, { places: [place] })
  })
  await page.route('**/api/v1/map/place/P1/arrivals?city=Tainan', async (route) => {
    arrivalsRequested.release()
    await fulfillAfter(route, arrivals.promise, { routes: [routeEntry] })
  })
  await page.route(/\/api\/v1\/map\/route(?:\?|$)/, async (route) => {
    previewRequested.release()
    await fulfillAfter(route, preview.promise, { variants: [variant()] })
  })

  await page.goto('/map?city=Tainan')
  const drawer = page.locator('#map-drawer')
  await expect(drawer.getByRole('heading', { name: city.name })).toBeVisible()
  await expect(drawer).toHaveAttribute('data-mode', 'map-list')
  await expect(drawer).toHaveJSProperty('style.height', '')
  await expect(drawer).toHaveJSProperty('style.minHeight', '')
  await startDrawerFrameCapture(page)

  await openNetwork(page)
  await clickDesktopStageCenter(page)
  await nearbyRequested.promise
  await expect(drawer.getByRole('heading', { name: '附近站牌' })).toBeVisible()
  await page.waitForTimeout(100)

  nearby.release()
  await arrivalsRequested.promise
  await expect(drawer.getByRole('heading', { name: place.name })).toBeVisible()
  await expect(drawer.locator('.place-route-skeleton')).toHaveCount(3)
  await page.waitForTimeout(100)

  arrivals.release()
  await previewRequested.promise
  await expect(drawer.locator('.place-route-row')).toHaveCount(1)
  await page.waitForTimeout(100)

  preview.release()
  await expect(page.locator('.leaflet-routePreview-pane svg path')).toHaveCount(1)
  await page.waitForTimeout(120)

  const frames = await stopDrawerFrameCapture(page)
  expectStableFrames(frames, ['catalogue', 'nearby-loading', 'place-loading'])
  await expect(drawer).toHaveJSProperty('style.height', '')
  await expect(drawer).toHaveJSProperty('style.minHeight', '')
})

test('keeps a desktop full-network route click stable through loading without fixing the final route card height', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const routeGate = deferred()
  const routeRequested = deferred()

  await mockBootstrap(page)
  await page.route('**/api/v1/map/network*', (route) => route.fulfill({
    json: {
      version: 'desktop-route-stability',
      routes: [{
        routeName: routeEntry.routeName,
        variantKey: routeEntry.variantKey,
        label: routeEntry.label,
        shape: variant().shape,
      }],
      places: [],
    },
  }))
  await page.route(/\/api\/v1\/map\/route(?:\?|$)/, async (route) => {
    routeRequested.release()
    await fulfillAfter(route, routeGate.promise, { variants: [variant()] })
  })

  await page.goto('/map?city=Tainan')
  const drawer = page.locator('#map-drawer')
  await expect(drawer.getByRole('heading', { name: city.name })).toBeVisible()
  await startDrawerFrameCapture(page)

  await openNetwork(page)
  await clickDesktopStageCenter(page)
  await routeRequested.promise
  await expect(drawer.getByRole('heading', { name: routeEntry.routeName })).toBeVisible()
  await expect(drawer).toHaveAttribute('data-mode', 'compact')
  await expect.poll(() => drawer.evaluate((element) => element.style.minHeight.length > 0)).toBe(true)
  await page.waitForTimeout(100)

  routeGate.release()
  await expect(drawer.getByRole('button', { name: '← 更換路線' })).toBeVisible()
  await expect(drawer.locator('.route-service-summary')).toHaveCount(0)
  await page.waitForTimeout(120)

  const frames = await stopDrawerFrameCapture(page)
  expectStableFrames(frames, ['catalogue', 'route-loading'])
  await expect(drawer).toHaveJSProperty('style.height', '')
  await expect(drawer).toHaveJSProperty('style.minHeight', '')
})

test('keeps a sparse desktop catalogue content-sized outside transitions', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await mockBootstrap(page, 1)
  await page.goto('/map?city=Tainan')

  const drawer = page.locator('#map-drawer')
  await expect(drawer.getByRole('heading', { name: city.name })).toBeVisible()
  const geometry = await drawer.evaluate((element) => ({
    height: element.getBoundingClientRect().height,
    viewportHeight: window.innerHeight,
    inlineHeight: element.style.height,
    inlineMinHeight: element.style.minHeight,
  }))
  expect(geometry.inlineHeight).toBe('')
  expect(geometry.inlineMinHeight).toBe('')
  expect(geometry.height).toBeLessThan(geometry.viewportHeight * 0.5)
})
