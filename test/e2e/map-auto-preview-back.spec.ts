import { expect, test, type Page } from './fixtures'

const city = { code: 'Tainan', name: '臺南', region: 'south', center: [22.997, 120.212] }
const places = [
  { placeId: 'P1', name: '臺南火車站', latitude: 22.997, longitude: 120.212, distanceMeters: 76 },
  { placeId: 'P2', name: '成功大學', latitude: 22.999, longitude: 120.216, distanceMeters: 180 },
]

function deferred() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
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

test('map auto-preview returns through the nearby list without flashing it during lookup', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const nearbyGate = deferred()
  const nearbyRequested = deferred()
  let signalledNearby = false

  await page.route('https://tile.openstreetmap.org/**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/v1/map/cities', (route) => route.fulfill({ json: { cities: [city] } }))
  await page.route(/\/api\/v1\/map\/routes(?:\?|$)/, (route) => route.fulfill({
    json: { routes: [{ routeName: '15', category: '數字' }] },
  }))
  await page.route('**/api/v1/map/network*', (route) => route.fulfill({
    json: {
      version: 'auto-preview-back',
      routes: [],
      places: [{
        placeId: places[0].placeId,
        name: places[0].name,
        latitude: places[0].latitude,
        longitude: places[0].longitude,
      }],
    },
  }))
  await page.route(/\/api\/v1\/map\/nearby(?:\?|$)/, async (route) => {
    if (!signalledNearby) {
      signalledNearby = true
      nearbyRequested.release()
      await nearbyGate.promise
    }
    await route.fulfill({ json: { places } })
  })
  await page.route('**/api/v1/map/place/P1/arrivals?city=Tainan', (route) => route.fulfill({
    json: { routes: [] },
  }))

  await page.goto('/map?city=Tainan')
  const drawer = page.locator('#map-drawer')
  await expect(drawer.getByRole('heading', { name: city.name })).toBeVisible()

  await openNetwork(page)
  await clickDesktopStageCenter(page)
  await nearbyRequested.promise

  await expect(drawer.getByRole('heading', { name: city.name })).toBeVisible()
  await expect(drawer.getByRole('heading', { name: '附近站牌' })).toHaveCount(0)
  nearbyGate.release()

  await expect(page).toHaveURL('/map?city=Tainan&place=P1')
  await expect(drawer.getByRole('heading', { name: places[0].name })).toBeVisible()
  await expect(drawer.getByRole('button', { name: '← 附近站牌', exact: true })).toBeVisible()

  await drawer.getByRole('button', { name: '← 附近站牌', exact: true }).click()
  await expect(page).toHaveURL('/map?city=Tainan&lat=22.99700&lon=120.21200')
  await expect(drawer.getByRole('heading', { name: '附近站牌' })).toBeVisible()
  await expect(drawer.locator('.nearby-place-button')).toHaveCount(2)

  await drawer.getByRole('button', { name: '← 路線列表', exact: true }).click()
  await expect(page).toHaveURL('/map?city=Tainan')
  await expect(drawer.getByRole('heading', { name: city.name })).toBeVisible()
})
