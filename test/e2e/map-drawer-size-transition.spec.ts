import type { Route } from '@playwright/test'
import { expect, test, type Page } from './fixtures'

const city = { code: 'Tainan', name: '臺南', region: 'south', center: [22.997, 120.212] }
const routeName = '中山幹線'

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
    // A newer navigation may abort a delayed request.
  }
}

function variant() {
  return {
    variantKey: 'R1:0',
    routeName,
    routeUid: 'R1',
    subRouteUid: 'R1',
    direction: 0,
    label: '大臺南公園 → 嘉義大學校區內',
    subRouteName: routeName,
    updatedAt: null,
    shape: {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'LineString',
        coordinates: [[120.209, 22.997], [120.212, 22.997], [120.215, 22.997]],
      },
    },
    stops: {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: { stopUid: 'S1', stopName: '臺南火車站', sequence: 1 },
        geometry: { type: 'Point', coordinates: [120.212, 22.997] },
      }],
    },
  }
}

async function mockMap(page: Page, routeGate: Promise<void>, routeRequested: ReturnType<typeof deferred>) {
  await page.route('https://tile.openstreetmap.org/**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/v1/map/cities', (route) => route.fulfill({ json: { cities: [city] } }))
  await page.route(/\/api\/v1\/map\/routes(?:\?|$)/, (route) => route.fulfill({
    json: { routes: [{ routeName, category: '幹線' }] },
  }))
  await page.route(/\/api\/v1\/map\/route(?:\?|$)/, async (route) => {
    routeRequested.release()
    await fulfillAfter(route, routeGate, { variants: [variant()] })
  })
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

async function startFrameCapture(page: Page) {
  await page.evaluate(() => {
    type Frame = { height: number; phase: string; size: string }
    type Store = { active: boolean; frames: Frame[] }
    const store: Store = { active: true, frames: [] }
    ;(window as Window & { __drawerTransitionFrames?: Store }).__drawerTransitionFrames = store
    const drawer = document.getElementById('map-drawer')!
    const sample = () => {
      if (!store.active) return
      const heading = drawer.querySelector<HTMLElement>('.drawer-heading h1')?.textContent ?? ''
      const description = drawer.querySelector<HTMLElement>('.drawer-heading p')?.textContent ?? ''
      const phase = heading === '臺南'
        ? 'catalogue'
        : heading === '中山幹線' && description.includes('正在拼起路線與站牌')
          ? 'route-loading'
          : heading === '中山幹線'
            ? 'route-result'
            : 'other'
      store.frames.push({
        height: drawer.getBoundingClientRect().height,
        phase,
        size: drawer.dataset.size ?? '',
      })
      window.requestAnimationFrame(sample)
    }
    window.requestAnimationFrame(sample)
  })
}

async function stopFrameCapture(page: Page): Promise<Array<{ height: number; phase: string; size: string }>> {
  return page.evaluate(() => {
    type Frame = { height: number; phase: string; size: string }
    type Store = { active: boolean; frames: Frame[] }
    const store = (window as Window & { __drawerTransitionFrames?: Store }).__drawerTransitionFrames!
    store.active = false
    return store.frames
  })
}

test('records the full standard-to-compact drawer transition without rebound', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const routeGate = deferred()
  const routeRequested = deferred()
  await mockMap(page, routeGate.promise, routeRequested)

  await page.goto('/map?city=Tainan')
  const drawer = page.locator('#map-drawer')
  await expect(drawer.getByRole('heading', { name: city.name })).toBeVisible()
  await expect(drawer).toHaveAttribute('data-size', 'standard')
  await startFrameCapture(page)

  await drawer.locator('.map-route-button').first().click()
  await routeRequested.promise
  await expect(drawer.getByRole('heading', { name: routeName })).toBeVisible()
  await expect(drawer).toHaveAttribute('data-size', 'compact')
  await page.waitForTimeout(220)

  routeGate.release()
  await expect(drawer.getByRole('button', { name: '← 更換路線' })).toBeVisible()
  await page.waitForTimeout(80)

  const frames = await stopFrameCapture(page)
  const loading = frames.filter((frame) => frame.phase === 'route-loading')
  expect(loading.length).toBeGreaterThan(4)
  expect(new Set(loading.map((frame) => frame.size))).toEqual(new Set(['compact']))
  expect(Math.max(...loading.map((frame) => frame.height)) - Math.min(...loading.map((frame) => frame.height))).toBeGreaterThan(50)
  for (let index = 1; index < loading.length; index += 1) {
    expect(loading[index].height).toBeLessThanOrEqual(loading[index - 1].height + 1)
  }

  const result = frames.filter((frame) => frame.phase === 'route-result')
  expect(result.length).toBeGreaterThan(1)
  expect(Math.max(...result.map((frame) => frame.height)) - Math.min(...result.map((frame) => frame.height))).toBeLessThanOrEqual(1)
  expect(Math.abs(result.at(-1)!.height - Math.min(...loading.map((frame) => frame.height)))).toBeLessThanOrEqual(1)
})
