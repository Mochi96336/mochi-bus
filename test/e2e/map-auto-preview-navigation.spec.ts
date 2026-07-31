import { expect, test, type Page } from './fixtures'

const city = { code: 'Tainan', name: '臺南', region: 'south', center: [22.997, 120.212] }
const places = [
  { placeId: 'P1', name: '臺南火車站', latitude: 22.997, longitude: 120.212, distanceMeters: 76 },
  { placeId: 'P2', name: '成功大學', latitude: 22.999, longitude: 120.216, distanceMeters: 180 },
]

function variant() {
  return {
    variantKey: 'TNN-15:0', routeName: '15', routeUid: 'TNN-15', direction: 0,
    label: '奇美醫院 → 大成路口', subRouteUid: 'TNN-15', subRouteName: '15', updatedAt: null,
    shape: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[120.211, 22.997], [120.213, 22.999]] } },
    stops: { type: 'FeatureCollection', features: [
      { type: 'Feature', properties: { stopUid: 'S1', stopName: '奇美醫院', sequence: 1 }, geometry: { type: 'Point', coordinates: [120.211, 22.997] } },
      { type: 'Feature', properties: { stopUid: 'S2', stopName: '大成路口', sequence: 2 }, geometry: { type: 'Point', coordinates: [120.213, 22.999] } },
    ] },
  }
}

function deferred() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

async function mockCommon(page: Page) {
  await page.route('https://tile.openstreetmap.org/**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/v1/map/cities', (route) => route.fulfill({ json: { cities: [city] } }))
  await page.route(/\/api\/v1\/map\/routes(?:\?|$)/, (route) => route.fulfill({ json: { routes: [{ routeName: '15', category: '數字' }] } }))
  await page.route(/\/api\/v1\/map\/route(?:\?|$)/, (route) => route.fulfill({ json: { variants: [variant()] } }))
  await page.route('**/api/v1/map/timetable*', (route) => route.fulfill({ json: { timetable: { mode: 'none', services: [] } } }))
  await page.route('**/api/v1/map/vehicles*', (route) => route.fulfill({ json: { vehicles: [] } }))
  await page.route('**/api/v1/map/place/*/arrivals?city=Tainan', (route) => route.fulfill({ json: { routes: [] } }))
}

async function clickBlankMap(page: Page) {
  const point = await page.evaluate(() => {
    const map = document.getElementById('map')!
    const drawer = document.getElementById('map-drawer')!
    const mapBox = map.getBoundingClientRect()
    const drawerBox = drawer.getBoundingClientRect()
    for (const xRatio of [.85, .7, .55, .4, .25]) {
      for (const yRatio of [.2, .35, .5, .65, .8]) {
        const x = mapBox.left + mapBox.width * xRatio
        const y = mapBox.top + mapBox.height * yRatio
        if (x >= drawerBox.left && x <= drawerBox.right && y >= drawerBox.top && y <= drawerBox.bottom) continue
        const target = document.elementFromPoint(x, y) as Element | null
        if (!target?.closest('#map')) continue
        if (target.closest('.leaflet-interactive, .leaflet-marker-icon, button, a')) continue
        return { x, y }
      }
    }
    throw new Error('no blank map point found')
  })
  await page.mouse.click(point.x, point.y)
}

test('catalogue map preview keeps the zoom gate and replaces an older nearby waypoint', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await mockCommon(page)
  const firstGate = deferred()
  let nearbyRequests = 0
  await page.route(/\/api\/v1\/map\/nearby(?:\?|$)/, async (route) => {
    nearbyRequests += 1
    if (nearbyRequests === 1) await firstGate.promise
    await route.fulfill({ json: { places: nearbyRequests === 1 ? [places[0], places[1]] : [places[1]] } })
  })

  await page.goto('/map?city=Tainan')
  const drawer = page.locator('#map-drawer')
  await expect(drawer.getByRole('heading', { name: city.name })).toBeVisible()

  await clickBlankMap(page)
  await expect(page.locator('#map-status')).toContainText('放大後再選站牌')
  expect(nearbyRequests).toBe(0)
  await page.waitForTimeout(500)

  await clickBlankMap(page)
  await expect.poll(() => nearbyRequests).toBe(1)
  await expect(drawer.getByRole('heading', { name: city.name })).toBeVisible()
  await expect(drawer.getByRole('heading', { name: '附近站牌' })).toHaveCount(0)
  firstGate.release()

  await expect(drawer.getByRole('heading', { name: places[0].name })).toBeVisible()
  await expect(drawer.getByRole('button', { name: '← 附近站牌', exact: true })).toBeVisible()

  await clickBlankMap(page)
  await expect.poll(() => nearbyRequests).toBe(2)
  await expect(drawer.getByRole('heading', { name: places[1].name })).toBeVisible()
  await drawer.getByRole('button', { name: '← 附近站牌', exact: true }).click()
  await expect(drawer.getByRole('heading', { name: '附近站牌' })).toBeVisible()
  await expect(drawer.locator('.nearby-place-button')).toHaveCount(1)
  await drawer.getByRole('button', { name: '← 路線列表', exact: true }).click()
  await expect(page).toHaveURL('/map?city=Tainan')
})

test('blank map selection from a route returns through Nearby and then the route', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await mockCommon(page)
  await page.route(/\/api\/v1\/map\/nearby(?:\?|$)/, (route) => route.fulfill({ json: { places } }))

  await page.goto('/map?city=Tainan&route=15&variant=TNN-15%3A0')
  const drawer = page.locator('#map-drawer')
  await expect(drawer.getByRole('heading', { name: '15' })).toBeVisible()
  await clickBlankMap(page)

  await expect(drawer.getByRole('heading', { name: places[0].name })).toBeVisible()
  await expect(drawer.getByRole('button', { name: '← 附近站牌', exact: true })).toBeVisible()
  await drawer.getByRole('button', { name: '← 附近站牌', exact: true }).click()
  await expect(drawer.getByRole('heading', { name: '附近站牌' })).toBeVisible()
  await expect(drawer.getByRole('button', { name: '← 返回路線', exact: true })).toBeVisible()
  await drawer.getByRole('button', { name: '← 返回路線', exact: true }).click()
  await expect(drawer.getByRole('heading', { name: '15' })).toBeVisible()
})

test('route-stop preview stays direct, then a map pick replaces the place with Nearby', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await mockCommon(page)
  let nearbyRequests = 0
  await page.route(/\/api\/v1\/map\/nearby(?:\?|$)/, (route) => {
    nearbyRequests += 1
    return route.fulfill({ json: { places: nearbyRequests === 1 ? [places[0]] : [places[1]] } })
  })

  await page.goto('/map?city=Tainan&route=15&variant=TNN-15%3A0')
  const drawer = page.locator('#map-drawer')
  const routeStops = page.locator('.leaflet-stop-pane svg path.leaflet-interactive')
  await expect(routeStops).toHaveCount(2)
  await routeStops.first().click()

  await expect(drawer.getByRole('heading', { name: places[0].name })).toBeVisible()
  await expect(drawer.getByRole('button', { name: '← 返回路線', exact: true })).toBeVisible()

  await clickBlankMap(page)
  await expect.poll(() => nearbyRequests).toBe(2)
  await expect(drawer.getByRole('heading', { name: places[1].name })).toBeVisible()
  await expect(drawer.getByRole('button', { name: '← 附近站牌', exact: true })).toBeVisible()
  await drawer.getByRole('button', { name: '← 附近站牌', exact: true }).click()
  await expect(drawer.getByRole('heading', { name: '附近站牌' })).toBeVisible()
  await expect(drawer.getByRole('button', { name: '← 返回路線', exact: true })).toBeVisible()
})