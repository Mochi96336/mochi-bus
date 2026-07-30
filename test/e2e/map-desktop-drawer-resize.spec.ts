import type { Route } from '@playwright/test'
import { expect, test, type Page } from './fixtures'

const city = { code: 'Tainan', name: '臺南', region: 'south', center: [22.997, 120.212] }
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
}

function variant() {
  return {
    variantKey: routeEntry.variantKey,
    routeName: routeEntry.routeName,
    routeUid: routeEntry.routeUid,
    subRouteUid: routeEntry.subRouteUid,
    direction: routeEntry.direction,
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

async function mockBootstrap(page: Page) {
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
  const targetX = mapBox.x + (drawerBox.x - mapBox.x + 45 - 48) / 2
  const targetY = mapBox.y + mapBox.height / 2 + (90 - 45) / 2
  await page.mouse.click(targetX, targetY)
}

test('recomputes the compact desktop drawer size when the viewport shrinks during route loading', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const routeGate = deferred()
  const routeRequested = deferred()

  await mockBootstrap(page)
  await page.route('**/api/v1/map/network*', (route) => route.fulfill({
    json: {
      version: 'desktop-route-resize',
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

  await openNetwork(page)
  await clickDesktopStageCenter(page)
  await routeRequested.promise
  await expect(drawer.getByRole('heading', { name: routeEntry.routeName })).toBeVisible()
  await expect(drawer).toHaveAttribute('data-size', 'compact')
  await expect(drawer).toHaveJSProperty('style.minHeight', '')
  const beforeResize = await drawer.evaluate((element) => element.getBoundingClientRect().height)

  await page.setViewportSize({ width: 1280, height: 600 })
  await expect.poll(() => drawer.evaluate((element) => {
    const height = element.getBoundingClientRect().height
    const maximumHeight = Number.parseFloat(getComputedStyle(element).maxHeight)
    return Math.abs(height - maximumHeight)
  })).toBeLessThanOrEqual(1)

  const resized = await drawer.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return {
      height: rect.height,
      bottom: rect.bottom,
      maximumHeight: Number.parseFloat(getComputedStyle(element).maxHeight),
      viewportHeight: window.innerHeight,
      inlineMinHeight: element.style.minHeight,
    }
  })
  expect(resized.inlineMinHeight).toBe('')
  expect(resized.height).toBeLessThan(beforeResize)
  expect(resized.height).toBeLessThanOrEqual(resized.maximumHeight + 1)
  expect(resized.bottom).toBeLessThanOrEqual(resized.viewportHeight)

  routeGate.release()
  await expect(drawer.getByRole('button', { name: '← 更換路線' })).toBeVisible()
  await expect(drawer).toHaveAttribute('data-size', 'compact')
  await expect(drawer).toHaveJSProperty('style.minHeight', '')
})
