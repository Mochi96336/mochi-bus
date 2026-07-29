import { expect, test } from './fixtures'

const city = { code: 'Tainan', name: '臺南', region: 'south', center: [22.99, 120.21] }

function variant(routeName: string) {
  return {
    variantKey: `TNN-${routeName}:0`, routeName, routeUid: `TNN-${routeName}`, direction: 0,
    label: '奇美醫院 → 大成路口', subRouteName: routeName, updatedAt: null,
    shape: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[120.2, 22.99], [120.24, 23.02]] } },
    stops: { type: 'FeatureCollection', features: [
      { type: 'Feature', properties: { stopUid: 'S1', stopName: '奇美醫院', sequence: 1 }, geometry: { type: 'Point', coordinates: [120.2, 22.99] } },
      { type: 'Feature', properties: { stopUid: 'S2', stopName: '大成路口', sequence: 2 }, geometry: { type: 'Point', coordinates: [120.24, 23.02] } },
    ] },
  }
}

test('drawer back restores the route catalogue URL, search, scroll and reload state', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 700 })
  await page.route('https://tile.openstreetmap.org/**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/v1/map/cities', (route) => route.fulfill({ json: { cities: [city] } }))
  await page.route(/\/api\/v1\/map\/routes(?:\?|$)/, (route) => route.fulfill({
    json: { routes: Array.from({ length: 181 }, (_, index) => ({ routeName: String(index + 1), category: '數字' })) },
  }))
  await page.route(/\/api\/v1\/map\/route(?:\?|$)/, (route) => {
    const routeName = new URL(route.request().url()).searchParams.get('route') ?? '15'
    return route.fulfill({ json: { variants: [variant(routeName)] } })
  })
  await page.route('**/api/v1/map/timetable*', (route) => route.fulfill({ json: { timetable: { mode: 'none', services: [] } } }))
  await page.route('**/api/v1/map/vehicles*', (route) => route.fulfill({ json: { vehicles: [] } }))

  await page.goto('/map?city=Tainan')
  const drawer = page.locator('#map-drawer')
  const search = drawer.getByRole('textbox', { name: '篩選路線，或搜尋站牌名稱' })
  await search.fill('1')
  const scrollRegion = drawer.locator('.drawer-scroll-region')
  await scrollRegion.evaluate((element) => { element.scrollTop = 120 })
  await expect.poll(() => scrollRegion.evaluate((element) => element.scrollTop)).toBeGreaterThan(50)
  await drawer.getByRole('button', { name: '15', exact: true }).click()
  await expect(page).toHaveURL(/route=15/)

  await drawer.getByRole('button', { name: '← 更換路線', exact: true }).click()

  await expect(page).toHaveURL('/map?city=Tainan')
  await expect(search).toHaveValue('1')
  await expect.poll(() => scrollRegion.evaluate((element) => element.scrollTop)).toBeGreaterThan(50)

  await page.goForward()
  await expect(page).toHaveURL(/route=15/)
  await expect(drawer.getByRole('heading', { name: '15' })).toBeVisible()

  await page.goBack()
  await expect(page).toHaveURL('/map?city=Tainan')
  await expect(search).toHaveValue('1')
  await expect.poll(() => scrollRegion.evaluate((element) => element.scrollTop)).toBeGreaterThan(50)

  await page.reload()
  await expect(drawer.getByRole('heading', { name: '臺南' })).toBeVisible()
  await expect(page).toHaveURL('/map?city=Tainan')
})

test('/map remains the Taiwan overview even when a previous city is stored', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('mochi.bus.activeCity.v1', 'Tainan'))
  await page.route('https://tile.openstreetmap.org/**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/v1/map/cities', (route) => route.fulfill({ json: { cities: [city] } }))
  await page.route(/\/api\/v1\/map\/routes(?:\?|$)/, (route) => route.fulfill({
    json: { routes: [{ routeName: '15', category: '數字' }] },
  }))

  await page.goto('/map')

  await expect(page.locator('#map-drawer').getByRole('heading', { name: '先從哪裡開始？' })).toBeVisible()
  await expect(page).toHaveURL('/map')
  await page.reload()
  await expect(page.locator('#map-drawer').getByRole('heading', { name: '先從哪裡開始？' })).toBeVisible()
})

test('detail exploration keeps drawer Back but browser Back skips to the catalogue', async ({ page }) => {
  const place = { placeId: 'P1', name: '臺南火車站', latitude: 22.997, longitude: 120.212, distanceMeters: 76 }
  await page.route('https://tile.openstreetmap.org/**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/v1/map/cities', (route) => route.fulfill({ json: { cities: [city] } }))
  await page.route(/\/api\/v1\/map\/routes(?:\?|$)/, (route) => route.fulfill({ json: { routes: [] } }))
  await page.route('**/api/v1/map/nearby*', (route) => route.fulfill({ json: { places: [place] } }))
  await page.route('**/api/v1/map/place/P1?city=Tainan', (route) => route.fulfill({ json: { place } }))
  await page.route('**/api/v1/map/place/P1/arrivals?city=Tainan', (route) => route.fulfill({ json: { routes: [] } }))

  await page.goto('/map?city=Tainan&lat=22.99700&lon=120.21200')
  const drawer = page.locator('#map-drawer')
  await expect(drawer.getByRole('heading', { name: '附近站牌' })).toBeVisible()
  await drawer.getByRole('button', { name: /臺南火車站/ }).click()
  await expect(page).toHaveURL('/map?city=Tainan&place=P1')
  await expect(drawer.getByRole('heading', { name: '臺南火車站' })).toBeVisible()

  await drawer.getByRole('button', { name: '← 附近站牌', exact: true }).click()
  await expect(page).toHaveURL('/map?city=Tainan&lat=22.99700&lon=120.21200')
  await expect(drawer.getByRole('heading', { name: '附近站牌' })).toBeVisible()

  await drawer.getByRole('button', { name: /臺南火車站/ }).click()
  await expect(page).toHaveURL('/map?city=Tainan&place=P1')
  await page.goBack()
  await expect(page).toHaveURL('/map?city=Tainan')
  await expect(drawer.getByRole('heading', { name: '臺南' })).toBeVisible()

  await page.goForward()
  await expect(page).toHaveURL('/map?city=Tainan&place=P1')
  await expect(drawer.getByRole('heading', { name: '臺南火車站' })).toBeVisible()
  await drawer.getByRole('button', { name: '← 附近站牌', exact: true }).click()
  await expect(drawer.getByRole('heading', { name: '附近站牌' })).toBeVisible()
  await page.reload()
  await expect(drawer.getByRole('heading', { name: '附近站牌' })).toBeVisible()
  await drawer.getByRole('button', { name: '← 路線列表', exact: true }).click()
  await expect(page).toHaveURL('/map?city=Tainan')
  await page.goForward()
  await expect(drawer.getByRole('heading', { name: '附近站牌' })).toBeVisible()

  await page.goto('/map?city=Tainan&place=P1')
  await expect(drawer.getByRole('heading', { name: '臺南火車站' })).toBeVisible()
  await drawer.getByRole('button', { name: '← 返回路線列表', exact: true }).click()
  await expect(page).toHaveURL('/map?city=Tainan')
  await page.goForward()
  await expect(drawer.getByRole('heading', { name: '臺南火車站' })).toBeVisible()
})

test('auto-preview keeps nearby result markers while skipping the transient list drawer', async ({ page }) => {
  const nearbyPlaces = [
    { placeId: 'P1', name: '臺南火車站', latitude: 22.997, longitude: 120.212, distanceMeters: 76 },
    { placeId: 'P2', name: '成功大學', latitude: 22.999, longitude: 120.216, distanceMeters: 180 },
  ]
  await page.route('https://tile.openstreetmap.org/**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/v1/map/cities', (route) => route.fulfill({ json: { cities: [city] } }))
  await page.route(/\/api\/v1\/map\/routes(?:\?|$)/, (route) => route.fulfill({ json: { routes: [{ routeName: '15', category: '數字' }] } }))
  await page.route(/\/api\/v1\/map\/route(?:\?|$)/, (route) => route.fulfill({ json: { variants: [variant('15')] } }))
  await page.route('**/api/v1/map/timetable*', (route) => route.fulfill({ json: { timetable: { mode: 'none', services: [] } } }))
  await page.route('**/api/v1/map/vehicles*', (route) => route.fulfill({ json: { vehicles: [] } }))
  await page.route('**/api/v1/map/nearby*', (route) => route.fulfill({ json: { places: nearbyPlaces } }))
  await page.route('**/api/v1/map/place/P1/arrivals?city=Tainan', (route) => route.fulfill({ json: { routes: [] } }))

  await page.goto('/map?city=Tainan&route=15&variant=TNN-15%3A0')
  const drawer = page.locator('#map-drawer')
  await expect(drawer.getByRole('heading', { name: '15' })).toBeVisible()

  const routeStops = page.locator('.leaflet-stop-pane svg path.leaflet-interactive')
  await expect(routeStops).toHaveCount(2)
  await routeStops.first().click()

  await expect(page).toHaveURL(/place=P1/)
  await expect(drawer.getByRole('heading', { name: '臺南火車站' })).toBeVisible()
  await expect(drawer.locator('.nearby-place-button')).toHaveCount(0)
  await expect(page.locator('.leaflet-stop-pane svg path.leaflet-interactive')).toHaveCount(3)
})

test('overview, region and catalogue share drawer and browser history transitions', async ({ page }) => {
  await page.route('https://tile.openstreetmap.org/**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/v1/map/cities', (route) => route.fulfill({ json: { cities: [city] } }))
  await page.route(/\/api\/v1\/map\/routes(?:\?|$)/, (route) => route.fulfill({
    json: { routes: [{ routeName: '15', category: '數字' }] },
  }))

  await page.goto('/map')
  const drawer = page.locator('#map-drawer')
  await drawer.getByRole('button', { name: '南部', exact: true }).click()
  await expect(page).toHaveURL('/map?region=south')
  await drawer.getByRole('button', { name: '臺南', exact: true }).click()
  await expect(page).toHaveURL('/map?city=Tainan')
  await expect(drawer.getByRole('heading', { name: '臺南' })).toBeVisible()

  await page.goBack()
  await expect(page).toHaveURL('/map?region=south')
  await expect(drawer.getByRole('heading', { name: '南部' })).toBeVisible()
  await page.goForward()
  await expect(drawer.getByRole('heading', { name: '臺南' })).toBeVisible()

  await drawer.getByRole('button', { name: '← 返回縣市', exact: true }).click()
  await expect(page).toHaveURL('/map?region=south')
  await page.goBack()
  await expect(page).toHaveURL('/map')
  await expect(drawer.getByRole('heading', { name: '先從哪裡開始？' })).toBeVisible()
})

test('a shared route deep link synthesizes the same internal parent history', async ({ page }) => {
  await page.route('https://tile.openstreetmap.org/**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/v1/map/cities', (route) => route.fulfill({ json: { cities: [city] } }))
  await page.route(/\/api\/v1\/map\/routes(?:\?|$)/, (route) => route.fulfill({
    json: { routes: [{ routeName: '15', category: '數字' }] },
  }))
  await page.route(/\/api\/v1\/map\/route(?:\?|$)/, (route) => route.fulfill({ json: { variants: [variant('15')] } }))
  await page.route('**/api/v1/map/timetable*', (route) => route.fulfill({ json: { timetable: { mode: 'none', services: [] } } }))
  await page.route('**/api/v1/map/vehicles*', (route) => route.fulfill({ json: { vehicles: [] } }))

  await page.goto('/map?city=Tainan&route=15&variant=TNN-15%3A0')
  const drawer = page.locator('#map-drawer')
  await expect(drawer.getByRole('heading', { name: '15' })).toBeVisible()
  await drawer.getByRole('button', { name: '← 更換路線', exact: true }).click()
  await expect(page).toHaveURL('/map?city=Tainan')
  await expect(drawer.getByRole('heading', { name: '臺南' })).toBeVisible()

  await page.goForward()
  await expect(drawer.getByRole('heading', { name: '15' })).toBeVisible()
  await page.goBack()
  await expect(drawer.getByRole('heading', { name: '臺南' })).toBeVisible()
  await page.goBack()
  await expect(page).toHaveURL('/map?region=south')
  await expect(drawer.getByRole('heading', { name: '南部' })).toBeVisible()
  await page.goBack()
  await expect(page).toHaveURL('/map')
})

test('a stop search result creates a place child whose Back returns to the catalogue', async ({ page }) => {
  const place = { placeId: 'P1', name: '臺南火車站', latitude: 22.997, longitude: 120.212 }
  await page.route('https://tile.openstreetmap.org/**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/v1/map/cities', (route) => route.fulfill({ json: { cities: [city] } }))
  await page.route(/\/api\/v1\/map\/routes(?:\?|$)/, (route) => route.fulfill({
    json: { routes: [{ routeName: '15', category: '數字' }] },
  }))
  await page.route('**/api/v1/map/search*', (route) => route.fulfill({ json: { places: [place] } }))
  await page.route('**/api/v1/map/place/P1?city=Tainan', (route) => route.fulfill({ json: { place: { ...place, distanceMeters: 0 } } }))
  await page.route('**/api/v1/map/place/P1/arrivals?city=Tainan', (route) => route.fulfill({ json: { routes: [] } }))

  await page.goto('/map?city=Tainan')
  const drawer = page.locator('#map-drawer')
  await drawer.getByRole('textbox', { name: '篩選路線，或搜尋站牌名稱' }).fill('火車站')
  await drawer.locator('.place-search-results .nearby-place-button').click()
  await expect(page).toHaveURL('/map?city=Tainan&place=P1')
  await expect(drawer.getByRole('heading', { name: '臺南火車站' })).toBeVisible()

  await drawer.locator('.drawer-back').click()
  await expect(page).toHaveURL('/map?city=Tainan')
  await expect(drawer.getByRole('textbox', { name: '篩選路線，或搜尋站牌名稱' })).toHaveValue('火車站')

  await page.goForward()
  await expect(page).toHaveURL('/map?city=Tainan&place=P1')
  await expect(drawer.getByRole('heading', { name: '臺南火車站' })).toBeVisible()
})

test('a legacy history entry without mapView restores from its URL', async ({ page }) => {
  await page.route('https://tile.openstreetmap.org/**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/v1/map/cities', (route) => route.fulfill({ json: { cities: [city] } }))
  await page.route(/\/api\/v1\/map\/routes(?:\?|$)/, (route) => route.fulfill({
    json: { routes: [{ routeName: '15', category: '數字' }] },
  }))
  await page.route(/\/api\/v1\/map\/route(?:\?|$)/, (route) => route.fulfill({ json: { variants: [variant('15')] } }))
  await page.route('**/api/v1/map/timetable*', (route) => route.fulfill({ json: { timetable: { mode: 'none', services: [] } } }))
  await page.route('**/api/v1/map/vehicles*', (route) => route.fulfill({ json: { vehicles: [] } }))

  await page.goto('/map?city=Tainan')
  await page.evaluate(() => {
    history.pushState(null, '', '/map?city=Tainan&route=15')
    history.pushState({ mapView: 'catalogue' }, '', '/map?city=Tainan')
  })

  await page.goBack()
  await expect(page).toHaveURL(/city=Tainan&route=15&.*variant=TNN-15%3A0/)
  await expect(page.locator('#map-drawer').getByRole('heading', { name: '15' })).toBeVisible()
})

test('an old favorite placeId falls back to its stable stopUid', async ({ page }) => {
  const place = { placeId: 'P1', name: '臺南火車站', latitude: 22.997, longitude: 120.212, distanceMeters: 0 }
  await page.route('https://tile.openstreetmap.org/**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/v1/map/cities', (route) => route.fulfill({ json: { cities: [city] } }))
  await page.route(/\/api\/v1\/map\/routes(?:\?|$)/, (route) => route.fulfill({ json: { routes: [] } }))
  await page.route('**/api/v1/map/place/OLD?city=Tainan', (route) => route.fulfill({ status: 404, json: { error: '找不到這個站牌' } }))
  await page.route('**/api/v1/map/stop-place?city=Tainan&stopUid=S1', (route) => route.fulfill({ json: { place } }))
  await page.route('**/api/v1/map/place/P1/arrivals?city=Tainan', (route) => route.fulfill({ json: { routes: [] } }))

  await page.goto('/map?city=Tainan&place=OLD&stopUid=S1')

  await expect(page).toHaveURL('/map?city=Tainan&place=P1')
  await expect(page.locator('#map-drawer').getByRole('heading', { name: '臺南火車站' })).toBeVisible()
})
