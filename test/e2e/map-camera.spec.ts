import { expect, test, type Page } from './fixtures'

const city = { code: 'Tainan', name: '臺南', region: 'south', center: [22.99, 120.21] }
const centralCities = [
  { code: 'MiaoliCounty', name: '苗栗', region: 'central', center: [24.56, 120.821] },
  { code: 'Taichung', name: '臺中', region: 'central', center: [24.147, 120.674] },
  { code: 'ChanghuaCounty', name: '彰化', region: 'central', center: [24.076, 120.544] },
  { code: 'NantouCounty', name: '南投', region: 'central', center: [23.91, 120.684] },
  { code: 'YunlinCounty', name: '雲林', region: 'central', center: [23.708, 120.535] },
]
const place = { placeId: 'P1', name: '臺南火車站', latitude: 22.997, longitude: 120.212, distanceMeters: 76 }
const route = {
  routeName: '中山幹線',
  routeUid: 'R1',
  variantKey: 'R1:0',
  direction: 0,
  label: '大臺南公園 → 嘉義大學校區內',
  subRouteUid: 'R1',
  subRouteName: '中山幹線',
  stopUid: 'P1-S',
  stopName: '臺南火車站',
  stopSequence: 2,
  estimateSeconds: 120,
  etaLabel: '2 分',
  stopStatus: 0,
  source: 'realtime',
}

async function mockPlaceMap(page: Page) {
  await page.route('https://tile.openstreetmap.org/**', (request) => request.fulfill({ status: 204 }))
  await page.route('**/api/v1/map/cities', (request) => request.fulfill({ json: { cities: [city] } }))
  await page.route(/\/api\/v1\/map\/routes(?:\?|$)/, (request) => request.fulfill({
    json: { routes: [{ routeName: route.routeName, category: '幹線' }] },
  }))
  await page.route('**/api/v1/map/place/P1?city=Tainan', (request) => request.fulfill({ json: { place } }))
  await page.route('**/api/v1/map/place/P1/arrivals?city=Tainan', (request) => request.fulfill({
    json: { routes: [route] },
  }))
  await page.route(/\/api\/v1\/map\/route(?:\?|$)/, (request) => request.fulfill({
    json: {
      variants: [{
        variantKey: route.variantKey,
        routeName: route.routeName,
        routeUid: route.routeUid,
        subRouteUid: route.subRouteUid,
        direction: 0,
        label: route.label,
        subRouteName: route.subRouteName,
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
            properties: { stopUid: route.stopUid, stopName: route.stopName, sequence: 2 },
            geometry: { type: 'Point', coordinates: [120.212, 22.997] },
          }],
        },
      }],
    },
  }))
  await page.route('**/api/v1/map/network*', (request) => request.fulfill({
    json: {
      version: 'test',
      routes: [],
      places: [],
    },
  }))
}

test('uses the desktop map stage for closer overview and region framing', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.route('https://tile.openstreetmap.org/**', (request) => request.fulfill({ status: 204 }))
  await page.route('**/api/v1/map/cities', (request) => request.fulfill({ json: { cities: centralCities } }))
  await page.goto('/map')

  const regionMarkers = page.locator('.leaflet-marker-pane .region-marker')
  await expect(regionMarkers).toHaveCount(4)
  const north = regionMarkers.filter({ hasText: '北部' })
  const south = regionMarkers.filter({ hasText: '南部' })
  expect(await verticalDistance(north, south)).toBeGreaterThan(400)

  await regionMarkers.filter({ hasText: '中部' }).click()
  const cityMarkers = page.locator('.leaflet-marker-pane .city-marker')
  await expect(cityMarkers).toHaveCount(centralCities.length)
  const miaoli = cityMarkers.filter({ hasText: '苗栗' })
  const yunlin = cityMarkers.filter({ hasText: '雲林' })
  expect(await verticalDistance(miaoli, yunlin)).toBeGreaterThan(250)
})

test('caps a long mobile route catalogue and scrolls only its content', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.route('https://tile.openstreetmap.org/**', (request) => request.fulfill({ status: 204 }))
  await page.route('**/api/v1/map/cities', (request) => request.fulfill({ json: { cities: [city] } }))
  await page.route(/\/api\/v1\/map\/routes(?:\?|$)/, (request) => request.fulfill({
    json: {
      routes: Array.from({ length: 30 }, (_, index) => ({
        routeName: `測試路線 ${index + 1}`,
        category: '數字',
      })),
    },
  }))
  await page.goto('/map?city=Tainan')

  const drawer = page.locator('#map-drawer')
  const scrollRegion = drawer.locator('.drawer-scroll-region')
  await expect(drawer.getByRole('heading', { name: city.name })).toBeVisible()
  await expect.poll(async () => Math.round((await drawer.boundingBox())?.height ?? 0)).toBe(422)
  await expect.poll(async () => scrollRegion.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)
})

test('keeps the focused place in the visible map stage when the drawer or viewport changes', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await mockPlaceMap(page)
  await page.goto('/map?city=Tainan&place=P1')

  const drawer = page.locator('#map-drawer')
  const routePath = page.locator('.leaflet-pane svg path').first()
  await expect(drawer.getByRole('heading', { name: place.name })).toBeVisible()
  await expect(routePath).toHaveCount(1)
  await expect(drawer).toHaveAttribute('data-scrollable', 'true')

  await expectFocusedContentAboveDrawer(drawer, routePath, 422)

  await page.setViewportSize({ width: 390, height: 700 })
  await expectFocusedContentAboveDrawer(drawer, routePath, 350)
})

test('keeps the current map context when the city network overlay is toggled', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await mockPlaceMap(page)
  await page.goto('/map?city=Tainan&place=P1')

  const drawer = page.locator('#map-drawer')
  const routePath = page.locator('.leaflet-routePreview-pane svg path')
  const network = page.getByRole('button', { name: '切換全路網與全部站點' })
  const status = page.locator('#map-status')
  await expect(drawer.getByRole('heading', { name: place.name })).toBeVisible()
  await expect(routePath).toHaveCount(1)

  await network.click()
  await expect(network).toHaveAttribute('aria-pressed', 'true')
  await expect(status).toContainText('全路網')
  await expect(status).not.toHaveAttribute('aria-hidden', 'true')
  await expect(routePath).toHaveCount(1)
  await expect(drawer.getByRole('heading', { name: place.name })).toBeVisible()

  await network.click()
  await expect(network).toHaveAttribute('aria-pressed', 'false')
  await expect(status).toHaveAttribute('aria-hidden', 'true')
  await expect(status).toHaveText('')
  await expect(routePath).toHaveCount(1)
  await expect(drawer.getByRole('heading', { name: place.name })).toBeVisible()
})

async function expectFocusedContentAboveDrawer(
  drawer: ReturnType<Page['locator']>,
  routePath: ReturnType<Page['locator']>,
  maxDrawerHeight: number,
) {
  await expect.poll(async () => Math.round((await drawer.boundingBox())?.height ?? 0)).toBeLessThanOrEqual(maxDrawerHeight)
  await expect.poll(async () => {
    const drawerBox = await drawer.boundingBox()
    const pathBox = await routePath.boundingBox()
    if (!drawerBox || !pathBox) return false
    return pathBox.y > 100 && pathBox.y + pathBox.height < drawerBox.y - 32
  }).toBe(true)
}

async function verticalDistance(
  first: ReturnType<Page['locator']>,
  second: ReturnType<Page['locator']>,
): Promise<number> {
  const firstBox = await first.boundingBox()
  const secondBox = await second.boundingBox()
  if (!firstBox || !secondBox) throw new Error('Expected both map markers to have a layout box')
  return Math.abs((firstBox.y + firstBox.height / 2) - (secondBox.y + secondBox.height / 2))
}
