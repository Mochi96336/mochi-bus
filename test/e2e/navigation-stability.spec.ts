import { expect, test } from './fixtures'

const board = {
  version: 2,
  id: 'stable-home',
  title: '捷運景安站',
  city: 'NewTaipei',
  placeId: 'NWT:jing-an',
  buses: [
    {
      city: 'NewTaipei', routeName: '中山幹線（綠線）', routeUid: 'NWT-GREEN', patternId: 'NWT-GREEN-0',
      stopName: '捷運景安站', stopUid: 'NWT1', direction: 0, directionLabel: '往板橋',
    },
    {
      city: 'NewTaipei', routeName: '307', routeUid: 'NWT307', patternId: 'NWT307-0',
      stopName: '捷運景安站', stopUid: 'NWT1', direction: 0, directionLabel: '往臺北',
    },
  ],
  createdAt: '2026-08-04T00:00:00.000Z',
  updatedAt: '2026-08-04T00:00:00.000Z',
}

const arrivals = [
  {
    routeName: '中山幹線（綠線）', routeUid: 'NWT-GREEN', variantKey: 'NWT-GREEN-0', direction: 0,
    label: '往板橋', subRouteName: '中山幹線（綠線）', stopUid: 'NWT1', stopName: '捷運景安站',
    stopSequence: 8, estimateSeconds: 300, etaLabel: '5 分', stopStatus: 0, source: 'realtime',
  },
  {
    routeName: '307', routeUid: 'NWT307', variantKey: 'NWT307-0', direction: 0,
    label: '往臺北', subRouteName: '307', stopUid: 'NWT1', stopName: '捷運景安站',
    stopSequence: 8, estimateSeconds: 720, etaLabel: '12 分', stopStatus: 0, source: 'realtime',
  },
]

test('map deep link stays covered and returning restores the stable home frame', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.addInitScript((savedBoard) => {
    localStorage.setItem('mochi.bus.boards.v2', JSON.stringify([savedBoard]))
    localStorage.setItem('mochi.bus.activeBoard.v2', savedBoard.id)
  }, board)

  let homeArrivalsCalls = 0
  let releaseHomeRefresh: (() => void) | undefined
  await page.route('**/api/v1/map/place/*/arrivals?*', async (route) => {
    const url = new URL(route.request().url())
    // The home endpoint and map endpoint share this route shape. Hold only the
    // first refresh after returning so the assertion sees stale-while-revalidate.
    if (url.pathname.includes('/api/v1/map/place/NWT%3Ajing-an/arrivals')) {
      const isMapRequest = url.searchParams.has('city') && !url.searchParams.has('focusStopUid')
      if (!isMapRequest) {
        homeArrivalsCalls += 1
        if (homeArrivalsCalls >= 2) {
          await new Promise<void>((resolve) => { releaseHomeRefresh = resolve })
        }
      }
    }
    await route.fulfill({ json: { routes: arrivals } })
  })

  await page.route('**/api/v1/map/place/NWT%3Ajing-an?city=NewTaipei', (route) => route.fulfill({ json: {
    place: { placeId: 'NWT:jing-an', name: '捷運景安站', latitude: 24.993, longitude: 121.505, distanceMeters: 0 },
  } }))

  let releaseMapArrivals: (() => void) | undefined
  await page.route('**/api/v1/map/place/NWT%3Ajing-an/arrivals?city=NewTaipei', async (route) => {
    await new Promise<void>((resolve) => { releaseMapArrivals = resolve })
    await route.fulfill({ json: { routes: arrivals } })
  })

  await page.goto('/')
  await expect(page.locator('.eta-value')).toHaveText(['5', '12'])
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('mochi.bus.home-view.v2'))).not.toBeNull()

  const routeLayout = await page.locator('.bus-row').first().evaluate((row) => {
    const name = row.querySelector('.bus-name')!
    return {
      whiteSpace: getComputedStyle(name).whiteSpace,
      height: name.getBoundingClientRect().height,
      fontSize: getComputedStyle(name).fontSize,
    }
  })
  expect(routeLayout.whiteSpace).toBe('nowrap')

  await page.getByRole('link', { name: '地圖' }).click()
  await expect(page).toHaveURL(/\/map\?city=NewTaipei/)
  await expect(page.locator('html')).toHaveAttribute('data-mochi-map-booting', 'true')
  await expect(page.locator('.leaflet-tile-pane')).toHaveCSS('opacity', '0')

  await expect.poll(() => Boolean(releaseMapArrivals)).toBe(true)
  releaseMapArrivals?.()
  await expect(page.locator('#map-drawer')).toHaveAttribute('data-view', /place:NewTaipei:/)
  await expect(page.locator('html')).not.toHaveAttribute('data-mochi-map-booting', 'true')
  await expect(page.locator('.leaflet-tile-pane')).toHaveCSS('opacity', '1')

  await page.getByRole('link', { name: '首頁' }).click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.locator('.skeleton-row')).toHaveCount(0)
  await expect(page.locator('.eta-value')).toHaveText(['5', '12'])
  await expect(page.locator('.bus-name').first()).toHaveCSS('white-space', 'nowrap')
  await expect(page.locator('.bus-name').first()).toHaveCSS('font-size', routeLayout.fontSize)
  const restoredHeight = await page.locator('.bus-name').first().evaluate((name) => name.getBoundingClientRect().height)
  expect(Math.abs(restoredHeight - routeLayout.height)).toBeLessThan(1)

  await expect.poll(() => Boolean(releaseHomeRefresh)).toBe(true)
  releaseHomeRefresh?.()
})
