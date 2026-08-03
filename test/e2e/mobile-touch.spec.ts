import { expect, mockMapBootstrapCities, test, type Page } from './fixtures'

const city = { code: 'Tainan', name: '臺南', region: 'south', center: [22.997, 120.212] }

function variant(variantKey: string, latitudeOffset = 0) {
  return {
    variantKey,
    routeName: '15',
    routeUid: 'TNN15',
    direction: 0,
    label: variantKey.endsWith('A') ? '火車站 → 公園' : '火車站 → 市府',
    subRouteName: variantKey,
    updatedAt: null,
    shape: {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'LineString',
        coordinates: [[120.208, 22.997 + latitudeOffset], [120.212, 22.997 + latitudeOffset], [120.216, 22.997 + latitudeOffset]],
      },
    },
    stops: {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: { stopUid: `${variantKey}-1`, stopName: '火車站', sequence: 1 }, geometry: { type: 'Point', coordinates: [120.208, 22.997 + latitudeOffset] } },
        { type: 'Feature', properties: { stopUid: `${variantKey}-2`, stopName: '終點', sequence: 2 }, geometry: { type: 'Point', coordinates: [120.216, 22.997 + latitudeOffset] } },
      ],
    },
  }
}

async function mockTouchMap(page: Page) {
  await page.route('https://tile.openstreetmap.org/**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/v1/map/cities', (route) => route.fulfill({ json: { cities: [city] } }))
  await page.route(/\/api\/v1\/map\/routes(?:\?|$)/, (route) => route.fulfill({
    json: { routes: [{ routeName: '15', category: '數字' }] },
  }))
  await page.route(/\/api\/v1\/map\/route(?:\?|$)/, (route) => route.fulfill({
    json: { variants: [variant('15-A'), variant('15-B', 0.001)] },
  }))
  await page.route('**/api/v1/map/vehicles*', (route) => route.fulfill({ json: { vehicles: [] } }))
  await page.route('**/api/v1/map/network*', (route) => route.fulfill({ json: {
    version: 'touch-test',
    routes: [{
      routeName: '15', variantKey: '15-A', label: '火車站 → 公園', shape: variant('15-A').shape,
    }],
    places: [],
  } }))
}

test('uses a real touch profile and renders wide invisible route hit targets', async ({ page }) => {
  await mockTouchMap(page)
  await page.goto('/map?city=Tainan')

  const capabilities = await page.evaluate(() => ({
    touchPoints: navigator.maxTouchPoints,
    hover: matchMedia('(hover: hover)').matches,
    coarse: matchMedia('(pointer: coarse)').matches,
  }))
  expect(capabilities.touchPoints).toBeGreaterThan(0)
  expect(capabilities.hover).toBe(false)
  expect(capabilities.coarse).toBe(true)

  await page.locator('#map-drawer').getByRole('button', { name: '15', exact: true }).click()
  await expect(page.locator('.variant-list')).toBeVisible()
  const hitTargets = page.locator('.leaflet-routePreview-pane path[stroke-opacity="0"]')
  await expect(hitTargets).toHaveCount(2)
  expect(await hitTargets.evaluateAll((paths) => paths.map((path) => ({
    strokeWidth: path.getAttribute('stroke-width'),
    interactive: path.classList.contains('leaflet-interactive'),
  })))).toEqual([
    { strokeWidth: '26', interactive: true },
    { strokeWidth: '26', interactive: true },
  ])

  // The mobile drawer may legally cover every preview segment. Verify the
  // target construction here, then use the visible direction control for the
  // picker transition. The following test independently exercises a real map
  // touchscreen tap through the coarse-pointer route picker.
  await page.getByRole('button', { name: '火車站 → 公園 15-A' }).tap()

  await expect(page.locator('.variant-list')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '← 更換方向' })).toBeVisible()
  await expect(page.locator('#map-drawer')).toContainText('火車站 → 公園')
  await expect(page.locator('.leaflet-tooltip')).toHaveCount(0)
})

test('taps a non-interactive network route through the coarse touch picker', async ({ page }) => {
  await mockTouchMap(page)
  await page.goto('/map?city=Tainan')
  await page.getByRole('button', { name: '切換全路網與全部站點' }).click()
  await expect(page.getByRole('button', { name: '切換全路網與全部站點' })).toHaveAttribute('aria-pressed', 'true')

  const mapBox = await page.locator('#map').boundingBox()
  const drawerBox = await page.locator('#map-drawer').boundingBox()
  if (!mapBox || !drawerBox) throw new Error('map stage has no layout box')
  // camera.focusPoint 會把城市中心放在扣除 top chrome 與 bottom sheet 後的可見舞台中心。
  const targetX = mapBox.x + mapBox.width / 2
  const targetY = mapBox.y + (drawerBox.y - mapBox.y + 42) / 2
  await page.touchscreen.tap(targetX, targetY)

  await expect(page).toHaveURL(/route=15.*variant=15-A/)
  await expect(page.getByRole('button', { name: '← 更換路線' })).toBeVisible()
})

test('keeps bootstrap recovery visible in a short touch landscape viewport', async ({ page }) => {
  await page.setViewportSize({ width: 636, height: 381 })
  // SSR 內嵌清單一律缺席,逼前端第一次一定要走網路回退,才測得到離線恢復。
  await mockMapBootstrapCities(page, null)
  let cityRequests = 0
  await page.route('https://tile.openstreetmap.org/**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/v1/map/cities', (route) => {
    cityRequests += 1
    return cityRequests === 1
      ? route.fulfill({ status: 503, json: { error: 'offline' } })
      : route.fulfill({ json: { cities: [city] } })
  })

  await page.goto('/map')
  const retry = page.getByRole('button', { name: '再試一次' })
  await expect(page.getByRole('heading', { name: '地圖初始化失敗' })).toBeVisible()
  await expect(retry).toBeVisible()
  await retry.tap()
  await expect(page.getByRole('heading', { name: '先從哪裡開始？' })).toBeVisible()
  expect(cityRequests).toBe(2)
})
