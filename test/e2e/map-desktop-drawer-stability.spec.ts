import type { Route } from '@playwright/test'
import { expect, test, type Page } from './fixtures'

const city = { code: 'Tainan', name: '臺南', region: 'south', center: [22.99, 120.21] }
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

async function mockMap(page: Page, gates: {
  nearby: Promise<void>
  nearbyStarted: () => void
  arrivals: Promise<void>
  arrivalsStarted: () => void
  preview: Promise<void>
  previewStarted: () => void
}) {
  await page.route('https://tile.openstreetmap.org/**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/v1/map/cities', (route) => route.fulfill({ json: { cities: [city] } }))
  await page.route(/\/api\/v1\/map\/routes(?:\?|$)/, (route) => route.fulfill({
    json: {
      routes: Array.from({ length: 80 }, (_, index) => ({
        routeName: index === 0 ? routeEntry.routeName : `測試路線 ${index + 1}`,
        category: index % 4 === 0 ? '幹線' : '數字',
      })),
    },
  }))
  await page.route(/\/api\/v1\/map\/nearby(?:\?|$)/, async (route) => {
    gates.nearbyStarted()
    await fulfillAfter(route, gates.nearby, { places: [place] })
  })
  await page.route('**/api/v1/map/place/P1/arrivals?city=Tainan', async (route) => {
    gates.arrivalsStarted()
    await fulfillAfter(route, gates.arrivals, { routes: [routeEntry] })
  })
  await page.route(/\/api\/v1\/map\/route(?:\?|$)/, async (route) => {
    gates.previewStarted()
    await fulfillAfter(route, gates.preview, { variants: [variant()] })
  })
}

test('keeps the desktop drawer shell stable while a map click auto-previews the nearest stop', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })

  const nearby = deferred()
  const nearbyRequested = deferred()
  const arrivals = deferred()
  const arrivalsRequested = deferred()
  const preview = deferred()
  const previewRequested = deferred()
  await mockMap(page, {
    nearby: nearby.promise,
    nearbyStarted: nearbyRequested.release,
    arrivals: arrivals.promise,
    arrivalsStarted: arrivalsRequested.release,
    preview: preview.promise,
    previewStarted: previewRequested.release,
  })

  await page.goto('/map?city=Tainan')
  const drawer = page.locator('#map-drawer')
  await expect(drawer.getByRole('heading', { name: city.name })).toBeVisible()
  await expect(drawer).toHaveAttribute('data-mode', 'map-list')

  await page.evaluate(() => {
    type Frame = { top: number; height: number; view: string; mode: string }
    type FrameStore = { active: boolean; frames: Frame[] }
    const store: FrameStore = { active: true, frames: [] }
    ;(window as Window & { __drawerFrameStore?: FrameStore }).__drawerFrameStore = store
    const drawerElement = document.getElementById('map-drawer')!
    const sample = () => {
      if (!store.active) return
      const rect = drawerElement.getBoundingClientRect()
      store.frames.push({
        top: rect.top,
        height: rect.height,
        view: drawerElement.dataset.view ?? '',
        mode: drawerElement.dataset.mode ?? '',
      })
      window.requestAnimationFrame(sample)
    }
    window.requestAnimationFrame(sample)
  })

  const zoomIn = page.locator('.leaflet-control-zoom-in')
  for (let index = 0; index < 6; index += 1) {
    await zoomIn.click()
    await page.waitForTimeout(35)
  }
  await page.waitForTimeout(120)
  await page.locator('#map').click({ position: { x: 620, y: 430 } })

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

  const frames = await page.evaluate(() => {
    type Frame = { top: number; height: number; view: string; mode: string }
    type FrameStore = { active: boolean; frames: Frame[] }
    const store = (window as Window & { __drawerFrameStore?: FrameStore }).__drawerFrameStore!
    store.active = false
    return store.frames
  })
  const mapListFrames = frames.filter((frame) => frame.mode === 'map-list')
  expect(new Set(mapListFrames.map((frame) => frame.view)).size).toBeGreaterThanOrEqual(3)
  expect(Math.max(...mapListFrames.map((frame) => frame.top)) - Math.min(...mapListFrames.map((frame) => frame.top))).toBeLessThanOrEqual(1)
  expect(Math.max(...mapListFrames.map((frame) => frame.height)) - Math.min(...mapListFrames.map((frame) => frame.height))).toBeLessThanOrEqual(1)
})
