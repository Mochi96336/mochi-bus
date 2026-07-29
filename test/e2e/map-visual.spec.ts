import type { Locator } from '@playwright/test'
import { expect, test, type Page } from './fixtures'

const city = { code: 'Tainan', name: '臺南', region: 'south', center: [22.99, 120.21] }

const arrivals = [
  {
    routeName: '中山幹線(綠線)',
    routeUid: 'ARR-1',
    variantKey: 'ARR-1:0',
    direction: 0,
    label: '大富路 → 嘉義大學校區內',
    subRouteUid: 'ARR-1',
    subRouteName: '中山幹線(綠線)',
    stopUid: 'P1-S',
    stopName: '臺南火車站',
    stopSequence: 1,
    estimateSeconds: 120,
    etaLabel: '2 分',
    stopStatus: 0,
    source: 'realtime',
  },
  {
    routeName: '樂活1路',
    routeUid: 'ARR-2',
    variantKey: 'ARR-2:0',
    direction: 1,
    label: '嘉義大學校區內 → 大富路',
    subRouteUid: 'ARR-2',
    subRouteName: '樂活1路',
    stopUid: 'P1-S',
    stopName: '臺南火車站',
    stopSequence: 1,
    estimateSeconds: 540,
    etaLabel: '9 分',
    stopStatus: 0,
    source: 'stale-realtime',
  },
  {
    routeName: '7211',
    routeUid: 'ARR-3',
    variantKey: 'ARR-3:0',
    direction: 0,
    label: '嘉義公園 → 朴子轉運站',
    subRouteUid: 'ARR-3',
    subRouteName: '7211',
    stopUid: 'P1-S',
    stopName: '臺南火車站',
    stopSequence: 1,
    estimateSeconds: 4_800,
    etaLabel: '09:20 到站',
    stopStatus: 0,
    source: 'schedule',
  },
] as const

const tripPlaces = {
  from: { placeId: 'FROM', name: '彰化銀行(嘉義)', latitude: 23.479, longitude: 120.449, distanceMeters: 139 },
  to: { placeId: 'TO', name: '南田市場', latitude: 23.472, longitude: 120.458, distanceMeters: 223 },
}

const transferPlan = {
  transferPlaceId: 'TRANSFER',
  transferName: '大業國中',
  transferWalkMeters: 0,
  totalStops: 8,
  first: { routeName: '7301', variantKey: '7301:0', label: '大雅站 → 大埔鄉公所', boardSequence: 1, alightSequence: 4, stopCount: 4 },
  second: { routeName: '7318', variantKey: '7318:0', label: '大業國中 → 南田市場', boardSequence: 1, alightSequence: 4, stopCount: 4 },
}

function tripRouteVariant(routeName: string) {
  return {
    variantKey: `${routeName}:0`,
    routeName,
    routeUid: `${routeName}-uid`,
    direction: 0,
    label: `${routeName} 測試方向`,
    subRouteName: routeName,
    shape: {
      type: 'Feature' as const,
      properties: { routeUid: `${routeName}-uid`, direction: 0 },
      geometry: {
        type: 'LineString' as const,
        coordinates: [[120.449, 23.479], [120.453, 23.475], [120.458, 23.472]],
      },
    },
    stops: {
      type: 'FeatureCollection' as const,
      features: [
        { type: 'Feature' as const, properties: { stopUid: `${routeName}-1`, stopName: '起點', sequence: 1 }, geometry: { type: 'Point' as const, coordinates: [120.449, 23.479] } },
        { type: 'Feature' as const, properties: { stopUid: `${routeName}-2`, stopName: '大業國中', sequence: 2 }, geometry: { type: 'Point' as const, coordinates: [120.453, 23.475] } },
        { type: 'Feature' as const, properties: { stopUid: `${routeName}-3`, stopName: '終點', sequence: 3 }, geometry: { type: 'Point' as const, coordinates: [120.458, 23.472] } },
      ],
    },
    updatedAt: null,
  }
}

async function mockMap(page: Page) {
  await page.route('https://tile.openstreetmap.org/**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/v1/map/cities', (route) => route.fulfill({ json: { cities: [city] } }))
  await page.route(/\/api\/v1\/map\/routes(?:\?|$)/, (route) => route.fulfill({
    json: {
      routes: [
        { routeName: '中山幹線(綠線)', category: '幹線' },
        { routeName: '樂活1路', category: '數字' },
        { routeName: '幸福小黃（預約）', category: '幸福／社區' },
        { routeName: '7211', category: '公路客運' },
        { routeName: '橘12', category: '接駁' },
        { routeName: '觀光公車', category: '觀光' },
      ],
    },
  }))
  await page.route('**/api/v1/map/place/P1?city=Tainan', (route) => route.fulfill({
    json: { place: { placeId: 'P1', name: '臺南火車站', latitude: 22.997, longitude: 120.212, distanceMeters: 76 } },
  }))
  await page.route('**/api/v1/map/place/P1/arrivals?city=Tainan', (route) => route.fulfill({
    json: { routes: arrivals },
  }))
  await page.route(/\/api\/v1\/map\/route(?:\?|$)/, (route) => route.fulfill({
    json: { variants: [] },
  }))
}

async function holdJsonResponse(
  page: Page,
  url: Parameters<Page['route']>[0],
  json: unknown,
): Promise<() => void> {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  await page.route(url, async (route) => {
    await gate
    await route.fulfill({ json })
  })
  return release
}

async function expectClippedScreenshot(page: Page, locator: Locator, snapshotName: string) {
  const clip = await locator.boundingBox()
  if (!clip) throw new Error(`Cannot capture hidden loading fixture: ${snapshotName}`)
  const screenshot = await page.screenshot({
    animations: 'disabled',
    caret: 'hide',
    clip,
  })
  expect(screenshot).toMatchSnapshot(snapshotName)
}

async function mockTripResults(page: Page) {
  let nearbyCall = 0
  await page.route('https://tile.openstreetmap.org/**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/v1/map/cities', (route) => route.fulfill({ json: { cities: [city] } }))
  await page.route(/\/api\/v1\/map\/routes(?:\?|$)/, (route) => route.fulfill({
    json: { routes: [{ routeName: '7301', category: '公路客運' }] },
  }))
  await page.route('**/api/v1/map/nearby*', (route) => {
    const place = nearbyCall++ === 0 ? tripPlaces.from : tripPlaces.to
    return route.fulfill({ json: { places: [place] } })
  })
  await page.route('**/api/v1/map/direct*', (route) => route.fulfill({ json: { routes: [] } }))
  await page.route('**/api/v1/map/transfer*', (route) => route.fulfill({ json: { plans: [transferPlan] } }))
  await page.route('**/api/v1/map/journey-eta', (route) => route.fulfill({
    json: { estimates: [
      { key: 'transfer:0:first', minutes: 5, source: 'none' },
      { key: 'transfer:0:second', minutes: 12, source: 'none' },
    ] },
  }))
  await page.route(/\/api\/v1\/map\/route(?:\?|$)/, (route) => {
    const routeName = new URL(route.request().url()).searchParams.get('route') ?? '7301'
    return route.fulfill({ json: { variants: [tripRouteVariant(routeName)] } })
  })
}

test('keeps the route catalogue visual hierarchy', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await mockMap(page)
  await page.goto('/map?city=Tainan')

  const drawer = page.locator('#map-drawer')
  await expect(drawer.getByRole('heading', { name: '臺南' })).toBeVisible()
  await expect(drawer).toHaveScreenshot('map-route-catalogue.png', {
    animations: 'disabled',
    caret: 'hide',
  })
})

test('keeps nearby loading aligned with resolved station rows', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await mockMap(page)
  const releaseNearby = await holdJsonResponse(page, '**/api/v1/map/nearby*', { places: [] })

  try {
    await page.goto('/map?city=Tainan&lat=22.99000&lon=120.21000')

    const drawer = page.locator('#map-drawer')
    const loading = drawer.locator('.map-loading-list')
    await expect(drawer.getByRole('heading', { name: '附近站牌' })).toBeVisible()
    await expect(loading.locator('.nearby-place-skeleton')).toHaveCount(3)
    await expectClippedScreenshot(page, loading, 'map-nearby-loading.png')
  } finally {
    releaseNearby()
  }
})

test('keeps route loading aligned with resolved arrival rows', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await mockMap(page)
  const releaseArrivals = await holdJsonResponse(
    page,
    '**/api/v1/map/place/P1/arrivals?city=Tainan',
    { routes: arrivals },
  )

  try {
    await page.goto('/map?city=Tainan&place=P1')

    const drawer = page.locator('#map-drawer')
    const loading = drawer.locator('.map-loading-list')
    await expect(drawer.getByRole('heading', { name: '臺南火車站' })).toBeVisible()
    await expect(loading.locator('.place-route-loading-row')).toHaveCount(3)
    await expectClippedScreenshot(page, loading, 'map-place-arrivals-loading.png')
  } finally {
    releaseArrivals()
  }
})

test('keeps ETA numbers dominant without hiding freshness', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await mockMap(page)
  await page.goto('/map?city=Tainan&place=P1')

  const drawer = page.locator('#map-drawer')
  await expect(drawer.getByRole('heading', { name: '臺南火車站' })).toBeVisible()
  await expect(drawer.getByText('稍早', { exact: true })).toBeVisible()
  await expect(drawer).toHaveScreenshot('map-place-arrivals.png', {
    animations: 'disabled',
    caret: 'hide',
  })
})

test('keeps trip endpoints compact above transfer results', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await mockTripResults(page)
  await page.goto('/map?city=Tainan')

  await page.getByRole('button', { name: /路線規劃/ }).click()
  const map = page.locator('#map')
  await map.click({ position: { x: 150, y: 250 } })
  await map.click({ position: { x: 250, y: 330 } })

  const drawer = page.locator('#map-drawer')
  const tripHeading = drawer.getByRole('heading', { name: '彰化銀行(嘉義) → 南田市場' })
  await expect(tripHeading).toBeVisible()
  await expect(drawer.locator('.transfer-plan')).toHaveCount(1)
  const geometry = await drawer.evaluate((element) => {
    const heading = element.querySelector<HTMLElement>('.drawer-heading h1')!
    const controls = element.querySelector<HTMLElement>('.trip-matched-controls.compact')!
    const summaries = Array.from(controls.querySelectorAll<HTMLElement>('.trip-matched-summary'))
    const controlsRect = controls.getBoundingClientRect()
    const summaryRects = summaries.map((summary) => summary.getBoundingClientRect())
    return {
      controlsHeight: controlsRect.height,
      headingHeight: heading.getBoundingClientRect().height,
      summaryHeights: summaryRects.map((rect) => rect.height),
      topDifference: Math.abs(summaryRects[0].top - summaryRects[1].top),
      hasHorizontalOverflow: controls.scrollWidth > controls.clientWidth,
    }
  })
  expect(geometry.controlsHeight).toBeGreaterThanOrEqual(48)
  expect(geometry.controlsHeight).toBeLessThanOrEqual(64)
  expect(geometry.headingHeight).toBeLessThanOrEqual(30)
  expect(geometry.summaryHeights.every((height) => height >= 48)).toBe(true)
  expect(geometry.topDifference).toBeLessThanOrEqual(1)
  expect(geometry.hasHorizontalOverflow).toBe(false)
  await expect(drawer).toHaveScreenshot('map-trip-results.png', {
    animations: 'disabled',
    caret: 'hide',
  })
})
