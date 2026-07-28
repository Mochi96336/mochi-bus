import { expect, test, type Page } from './fixtures'

const city = { code: 'Tainan', name: '臺南', region: 'south', center: [22.99, 120.21] }
const routeNames = ['0右', ...Array.from({ length: 119 }, (_, index) => String(index + 1))]

function variant(routeName: string) {
  return {
    variantKey: `${routeName}:0`,
    routeName,
    routeUid: `TNN-${routeName}`,
    direction: 0 as const,
    label: '臺南火車站 → 永康火車站',
    subRouteName: routeName,
    updatedAt: null,
    shape: {
      type: 'Feature' as const,
      properties: {},
      geometry: {
        type: 'LineString' as const,
        coordinates: [[120.20, 22.99], [120.24, 23.02]],
      },
    },
    stops: {
      type: 'FeatureCollection' as const,
      features: [
        {
          type: 'Feature' as const,
          properties: { stopUid: 'S1', stopName: '臺南火車站', sequence: 1 },
          geometry: { type: 'Point' as const, coordinates: [120.20, 22.99] as [number, number] },
        },
        {
          type: 'Feature' as const,
          properties: { stopUid: 'S2', stopName: '永康火車站', sequence: 2 },
          geometry: { type: 'Point' as const, coordinates: [120.24, 23.02] as [number, number] },
        },
      ],
    },
  }
}

async function mockMap(page: Page, routeGate: Promise<void>) {
  await page.route('https://tile.openstreetmap.org/**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/v1/map/cities', (route) => route.fulfill({ json: { cities: [city] } }))
  await page.route(/\/api\/v1\/map\/routes(?:\?|$)/, (route) => route.fulfill({
    json: {
      routes: routeNames.map((routeName, index) => ({
        routeName,
        category: index % 4 === 0 ? '幹線' : '數字',
      })),
    },
  }))
  await page.route(/\/api\/v1\/map\/route(?:\?|$)/, async (route) => {
    await routeGate
    const routeName = new URL(route.request().url()).searchParams.get('route') ?? '0右'
    await route.fulfill({ json: { variants: [variant(routeName)] } })
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

test('keeps the mobile route drawer height stable while route data is loading', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  let releaseRoute!: () => void
  const routeGate = new Promise<void>((resolve) => { releaseRoute = resolve })
  await mockMap(page, routeGate)
  await page.goto('/map?city=Tainan')

  const drawer = page.locator('#map-drawer')
  await expect(drawer).toHaveAttribute('data-mode', 'map-list')
  await expect(drawer.locator('.map-route-button')).toHaveCount(routeNames.length)
  const beforeHeight = await drawer.evaluate((element) => element.getBoundingClientRect().height)

  try {
    await drawer.getByRole('button', { name: '0右', exact: true }).click()
    await expect(drawer.locator('.drawer-heading p')).toContainText('正在拼起路線與站牌')

    const loading = await drawer.evaluate((element) => ({
      height: element.getBoundingClientRect().height,
      minHeight: element.style.minHeight,
    }))
    expect(Math.abs(loading.height - beforeHeight)).toBeLessThanOrEqual(1)
    expect(loading.minHeight).not.toBe('')
  } finally {
    releaseRoute()
  }

  await expect(drawer.locator('.route-service-summary')).toBeVisible()
  await expect.poll(() => drawer.evaluate((element) => element.style.minHeight)).toBe('')
})
