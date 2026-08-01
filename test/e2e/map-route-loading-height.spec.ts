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
  ).toBeLessThanOrEqual(241)
  const height = await drawer.evaluate((element) => element.getBoundingClientRect().height)
  expect(height).toBeLessThan(previousHeight - 120)
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
    // 讀取中維持目錄的高度;compact 是路線資料到達後的狀態,所以先讓它落地再量。
    await expect(drawer).toHaveAttribute('data-size', 'standard')
    releaseRoute()
    released = true
    await expect(drawer.locator('.route-service-summary')).toBeVisible()
    await expect(drawer).toHaveAttribute('data-size', 'compact')
    // settledCompactHeight 只輪詢到「已經夠矮」,收合動畫途中就滿足了。等它走完再量。
    await page.waitForTimeout(400)

    const portraitCompactHeight = await settledCompactHeight(page, catalogue)
    expect(portraitCompactHeight).toBeGreaterThanOrEqual(215)
    expect(portraitCompactHeight).toBeLessThanOrEqual(241)
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

    const landscapeResult = await resizeAndSettleDrawer(page, { width: 844, height: 390 })
    await expect(drawer.getByRole('heading', { name: '0右' })).toBeVisible()
    await expect(drawer.locator('.drawer-back')).toBeVisible()
    await expect(drawer).toHaveAttribute('data-size', 'compact')
    await expect(drawer).toHaveJSProperty('style.minHeight', '')
    expect(landscapeResult.height).toBeGreaterThanOrEqual(250)
    expect(landscapeResult.scrollHeight - landscapeResult.clientHeight).toBeLessThanOrEqual(1)

    const portraitResult = await resizeAndSettleDrawer(page, { width: 390, height: 844 })
    expect(Math.abs(portraitResult.height - portraitCompactHeight)).toBeLessThanOrEqual(1)
    expect(portraitResult.scrollHeight - portraitResult.clientHeight).toBeLessThanOrEqual(1)

    // 428 × 926 matches the class of device in the reported screenshot: compact should cap
    // at 240 px rather than reserving the previous 300 px sheet.
    const largePortraitResult = await resizeAndSettleDrawer(page, { width: 428, height: 926 })
    expect(largePortraitResult.height).toBeGreaterThanOrEqual(239)
    expect(largePortraitResult.height).toBeLessThanOrEqual(241)
    expect(largePortraitResult.scrollHeight - largePortraitResult.clientHeight).toBeLessThanOrEqual(1)
  } finally {
    if (!released) releaseRoute()
  }

  await expect(drawer.locator('.route-service-summary')).toBeVisible()
  await expect(drawer).toHaveAttribute('data-size', 'compact')
  await expect(drawer).toHaveJSProperty('style.minHeight', '')
})

// 讀取中維持目錄高度,收合發生在變體清單到達時。
test('holds the catalogue height through route loading before a compact variant picker', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  let releaseRoute!: () => void
  const routeGate = new Promise<void>((resolve) => { releaseRoute = resolve })
  await mockMap(page, routeGate, 2)
  await page.goto('/map?city=Tainan')

  const drawer = page.locator('#map-drawer')
  const catalogue = await catalogueHeight(page)

  try {
    await drawer.getByRole('button', { name: '0右', exact: true }).click()
    await expect(drawer.locator('.drawer-heading p')).toContainText('正在拼起路線與站牌')
    await expect(drawer).toHaveAttribute('data-size', 'standard')
    const loadingHeight = await drawer.evaluate((element) => element.getBoundingClientRect().height)
    expect(Math.abs(loadingHeight - catalogue)).toBeLessThanOrEqual(1)
  } finally {
    releaseRoute()
  }

  await expect(drawer).toHaveAttribute('data-mode', 'map-list')
  await expect(drawer).toHaveAttribute('data-size', 'compact')
  await expect(drawer.locator('.variant-button')).toHaveCount(2)
  await expect(drawer).toHaveJSProperty('style.minHeight', '')
  const pickerHeight = await settledCompactHeight(page, catalogue)
  expect(pickerHeight).toBeGreaterThanOrEqual(215)
  expect(pickerHeight).toBeLessThanOrEqual(241)
})
