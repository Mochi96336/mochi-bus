import { expect, test, type Page } from './fixtures'

const city = { code: 'Tainan', name: '臺南', region: 'south', center: [22.99, 120.21] }
const routeNames = ['0右', ...Array.from({ length: 119 }, (_, index) => String(index + 1))]

function variant(routeName: string, index = 0) {
  return {
    variantKey: `${routeName}:${index}`,
    routeName,
    routeUid: `TNN-${routeName}`,
    direction: index % 2 === 0 ? 0 as const : 1 as const,
    label: index % 2 === 0 ? '臺南火車站 → 永康火車站' : '永康火車站 → 臺南火車站',
    subRouteName: `${routeName}-${index}`,
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

async function mockMap(page: Page, routeGate: Promise<void>, variantCount = 1) {
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
    await route.fulfill({
      json: { variants: Array.from({ length: variantCount }, (_, index) => variant(routeName, index)) },
    })
  })
  await page.route('**/api/v1/map/vehicles*', (route) => route.fulfill({ json: { vehicles: [] } }))
  await page.route('**/api/v1/map/timetable*', (route) => route.fulfill({
    json: {
      timetable: {
        mode: 'departure',
        selectedStop: null,
        departureStop: { stopUid: 'S1', stopName: '臺南火車站', sequence: 1 },
        stops: [],
        timedStopCount: 0,
        services: [{
          id: 'weekday',
          label: '平日',
          days: [1, 2, 3, 4, 5],
          today: true,
          times: ['06:10', '07:10'],
          periods: [],
          firstTime: '06:10',
          lastTime: '07:10',
        }],
      },
    },
  }))
}

async function catalogueHeight(page: Page): Promise<number> {
  const drawer = page.locator('#map-drawer')
  await expect(drawer).toHaveAttribute('data-mode', 'map-list')
  await expect(drawer).toHaveAttribute('data-size', 'standard')
  await expect(drawer.locator('.map-route-button')).toHaveCount(routeNames.length)
  return drawer.evaluate((element) => element.getBoundingClientRect().height)
}

async function drawerGeometry(page: Page) {
  return page.locator('#map-drawer').evaluate((element) => ({
    height: element.getBoundingClientRect().height,
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }))
}

async function resizeAndSettleDrawer(page: Page, viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport)
  await page.waitForTimeout(260)
  return drawerGeometry(page)
}

async function settledCompactHeight(page: Page, previousHeight: number): Promise<number> {
  const drawer = page.locator('#map-drawer')
  await expect.poll(
    () => drawer.evaluate((element) => element.getBoundingClientRect().height),
  ).toBeLessThanOrEqual(301)
  const height = await drawer.evaluate((element) => element.getBoundingClientRect().height)
  expect(height).toBeLessThan(previousHeight - 60)
  return height
}

test('uses a genuinely shorter compact route state while keeping it usable across viewport boundaries', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  let released = false
  let releaseRoute!: () => void
  const routeGate = new Promise<void>((resolve) => { releaseRoute = resolve })
  await mockMap(page, routeGate)
  await page.goto('/map?city=Tainan')

  const drawer = page.locator('#map-drawer')
  const catalogue = await catalogueHeight(page)

  try {
    await drawer.getByRole('button', { name: '0右', exact: true }).click()
    await expect(drawer.locator('.drawer-heading p')).toContainText('正在拼起路線與站牌')
    await expect(drawer).toHaveAttribute('data-size', 'compact')

    const portraitLoadingHeight = await settledCompactHeight(page, catalogue)
    expect(portraitLoadingHeight).toBeGreaterThanOrEqual(239)
    expect(portraitLoadingHeight).toBeLessThanOrEqual(301)
    expect((await drawerGeometry(page)).scrollHeight - (await drawerGeometry(page)).clientHeight).toBeLessThanOrEqual(1)
    await expect(drawer).toHaveJSProperty('style.minHeight', '')

    const at640 = await resizeAndSettleDrawer(page, { width: 640, height: 390 })
    const at641 = await resizeAndSettleDrawer(page, { width: 641, height: 390 })
    expect(Math.abs(at641.height - at640.height)).toBeLessThanOrEqual(1)

    const at520 = await resizeAndSettleDrawer(page, { width: 844, height: 520 })
    const at521 = await resizeAndSettleDrawer(page, { width: 844, height: 521 })
    expect(Math.abs(at521.height - at520.height)).toBeLessThanOrEqual(1)
    expect(at521.height).toBeGreaterThanOrEqual(250)
    expect(at521.scrollHeight - at521.clientHeight).toBeLessThanOrEqual(1)

    const landscapeLoading = await resizeAndSettleDrawer(page, { width: 844, height: 390 })
    await expect(drawer.getByRole('heading', { name: '0右' })).toBeVisible()
    await expect(drawer.locator('.drawer-back')).toBeVisible()
    await expect(drawer).toHaveAttribute('data-size', 'compact')
    await expect(drawer).toHaveJSProperty('style.minHeight', '')
    expect(landscapeLoading.height).toBeGreaterThanOrEqual(250)
    expect(landscapeLoading.scrollHeight - landscapeLoading.clientHeight).toBeLessThanOrEqual(1)

    releaseRoute()
    released = true
    await expect(drawer.locator('.route-service-summary')).toBeVisible()
    await expect(drawer.locator('.drawer-back')).toBeVisible()
    await expect(drawer).toHaveAttribute('data-size', 'compact')
    const landscapeResult = await drawerGeometry(page)
    expect(landscapeResult.height).toBeGreaterThanOrEqual(250)
    expect(landscapeResult.scrollHeight - landscapeResult.clientHeight).toBeLessThanOrEqual(1)

    await page.setViewportSize({ width: 390, height: 844 })
    await expect.poll(async () => {
      const height = await drawer.evaluate((element) => element.getBoundingClientRect().height)
      return Math.abs(height - portraitLoadingHeight)
    }).toBeLessThanOrEqual(1)
  } finally {
    if (!released) releaseRoute()
  }

  await expect(drawer.locator('.route-service-summary')).toBeVisible()
  await expect(drawer).toHaveAttribute('data-size', 'compact')
  await expect(drawer).toHaveJSProperty('style.minHeight', '')
})

test('keeps compact route loading and a compact variant picker at the same short mobile height', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  let releaseRoute!: () => void
  const routeGate = new Promise<void>((resolve) => { releaseRoute = resolve })
  await mockMap(page, routeGate, 2)
  await page.goto('/map?city=Tainan')

  const drawer = page.locator('#map-drawer')
  const catalogue = await catalogueHeight(page)
  let loadingHeight = 0

  try {
    await drawer.getByRole('button', { name: '0右', exact: true }).click()
    await expect(drawer.locator('.drawer-heading p')).toContainText('正在拼起路線與站牌')
    await expect(drawer).toHaveAttribute('data-size', 'compact')
    loadingHeight = await settledCompactHeight(page, catalogue)
  } finally {
    releaseRoute()
  }

  await expect(drawer).toHaveAttribute('data-mode', 'map-list')
  await expect(drawer).toHaveAttribute('data-size', 'compact')
  await expect(drawer.locator('.variant-button')).toHaveCount(2)
  await expect(drawer).toHaveJSProperty('style.minHeight', '')
  await expect.poll(async () => {
    const height = await drawer.evaluate((element) => element.getBoundingClientRect().height)
    return Math.abs(height - loadingHeight)
  }).toBeLessThanOrEqual(1)
})
