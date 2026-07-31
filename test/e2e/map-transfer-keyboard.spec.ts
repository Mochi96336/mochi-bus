import { expect, test } from './fixtures'

const city = {
  code: 'Taipei',
  name: 'Taipei',
  region: 'north',
  center: [25, 121] as [number, number],
}

const places = {
  from: { placeId: 'Taipei:transfer-from', name: 'Transfer From', latitude: 25, longitude: 121 },
  to: { placeId: 'Taipei:transfer-to', name: 'Transfer To', latitude: 25.01, longitude: 121.02 },
}

const plans = [
  {
    transferPlaceId: 'Taipei:transfer-place-1',
    transferName: 'Transfer One',
    transferWalkMeters: 80,
    totalStops: 5,
    first: { routeName: 'A', variantKey: 'A:0', label: 'A to transfer', boardSequence: 1, alightSequence: 2, stopCount: 2 },
    second: { routeName: 'B', variantKey: 'B:0', label: 'B to destination', boardSequence: 1, alightSequence: 3, stopCount: 3 },
  },
  {
    transferPlaceId: 'Taipei:transfer-place-2',
    transferName: 'Transfer Two',
    transferWalkMeters: 120,
    totalStops: 7,
    first: { routeName: 'C', variantKey: 'C:0', label: 'C to transfer', boardSequence: 1, alightSequence: 2, stopCount: 3 },
    second: { routeName: 'D', variantKey: 'D:0', label: 'D to destination', boardSequence: 1, alightSequence: 3, stopCount: 4 },
  },
]

function routeVariant(routeName: string, variantKey: string, offset: number) {
  return {
    variantKey,
    routeName,
    routeUid: `${routeName}-uid`,
    direction: 0 as const,
    label: `${routeName} mocked route`,
    subRouteName: routeName,
    shape: {
      type: 'Feature' as const,
      properties: { routeUid: `${routeName}-uid`, direction: 0 },
      geometry: { type: 'LineString' as const, coordinates: [[121 + offset, 25], [121.005 + offset, 25.005], [121.01 + offset, 25.01]] },
    },
    stops: {
      type: 'FeatureCollection' as const,
      features: [1, 2, 3].map((sequence) => ({
        type: 'Feature' as const,
        properties: { stopUid: `${routeName}-${sequence}`, stopName: `${routeName} stop ${sequence}`, sequence },
        geometry: { type: 'Point' as const, coordinates: [121 + offset + sequence * .005, 25 + sequence * .005] as [number, number] },
      })),
    },
    updatedAt: null,
  }
}

test('transfer cards isolate keyboard selection from inner route actions', async ({ page }) => {
  const routeCalls: string[] = []
  let transferCalls = 0

  await page.route('**/api/v1/map/cities', async (route) => {
    await route.fulfill({ json: { cities: [city] } })
  })
  await page.route(/\/api\/v1\/map\/routes(?:\?|$)/, async (route) => {
    await route.fulfill({ json: { routes: [{ routeName: 'Mock', category: 'bus' }] } })
  })
  await page.route('**/api/v1/map/search*', async (route) => {
    const query = new URL(route.request().url()).searchParams.get('q')
    const place = query === 'Transfer From' ? places.from : query === 'Transfer To' ? places.to : undefined
    await route.fulfill({ json: { places: place ? [place] : [] } })
  })
  await page.route('**/api/v1/map/direct*', async (route) => {
    await route.fulfill({ json: { routes: [] } })
  })
  await page.route('**/api/v1/map/transfer*', async (route) => {
    transferCalls += 1
    await route.fulfill({ json: { plans } })
  })
  await page.route('**/api/v1/map/journey-eta', async (route) => {
    await route.fulfill({ json: { estimates: [
      { key: 'transfer:0:first', minutes: 5, source: 'realtime' },
      { key: 'transfer:0:second', minutes: 8, source: 'realtime' },
      { key: 'transfer:1:first', minutes: 6, source: 'realtime' },
      { key: 'transfer:1:second', minutes: 9, source: 'realtime' },
    ] } })
  })
  await page.route(/\/api\/v1\/map\/route(?:\?|$)/, async (route) => {
    const routeName = new URL(route.request().url()).searchParams.get('route') ?? 'A'
    routeCalls.push(routeName)
    const routeIndex = ['A', 'B', 'C', 'D'].indexOf(routeName)
    await route.fulfill({ json: { variants: [routeVariant(routeName, `${routeName}:0`, routeIndex * .02)] } })
  })

  await page.goto('/map?city=Taipei')
  await page.getByRole('button', { name: /路線規劃/ }).click()
  const search = page.locator('.map-search')
  await search.fill('Transfer From')
  await page.locator('.nearby-place-button').filter({ hasText: 'Transfer From' }).click()
  await search.fill('Transfer To')
  await page.locator('.nearby-place-button').filter({ hasText: 'Transfer To' }).click()

  const cards = page.locator('.transfer-plan')
  await expect(cards).toHaveCount(2)
  await expect(cards.nth(0)).toHaveClass(/selected/)
  await expect(cards.nth(1)).not.toHaveClass(/selected/)
  await expect.poll(() => transferCalls).toBe(1)
  await expect.poll(() => routeCalls.length).toBe(2)

  await cards.nth(1).focus()
  await cards.nth(1).press('Enter')
  await expect(cards.nth(1)).toHaveClass(/selected/)
  await expect(cards.nth(0)).not.toHaveClass(/selected/)
  await expect.poll(() => routeCalls.length).toBe(4)

  await cards.nth(1).locator('.transfer-leg-button').nth(0).focus()
  await cards.nth(1).locator('.transfer-leg-button').nth(0).press('Enter')
  await expect.poll(() => routeCalls.length).toBe(5)
  expect(routeCalls.at(-1)).toBe('C')
  await expect(page.getByRole('heading', { name: 'C', exact: true })).toBeVisible()
  await page.getByRole('button', { name: /返回行程候選/ }).click()
  await expect.poll(() => routeCalls.length).toBe(7)
  await expect(page.locator('.transfer-plan').nth(1)).toHaveClass(/selected/)

  await page.locator('.transfer-plan').nth(0).focus()
  await page.locator('.transfer-plan').nth(0).press('Space')
  await expect(page.locator('.transfer-plan').nth(0)).toHaveClass(/selected/)
  await expect(page.locator('.transfer-plan').nth(1)).not.toHaveClass(/selected/)
  await expect.poll(() => routeCalls.length).toBe(9)

  await page.locator('.transfer-plan').nth(0).locator('.transfer-leg-button').nth(1).focus()
  await page.locator('.transfer-plan').nth(0).locator('.transfer-leg-button').nth(1).press('Space')
  await expect.poll(() => routeCalls.length).toBe(10)
  expect(routeCalls.at(-1)).toBe('B')
  await expect(page.getByRole('heading', { name: 'B', exact: true })).toBeVisible()
  await page.getByRole('button', { name: /返回行程候選/ }).click()
  await expect.poll(() => routeCalls.length).toBe(12)
  await expect(page.locator('.transfer-plan').nth(0)).toHaveClass(/selected/)

  await page.locator('.transfer-plan').nth(0).locator('.transfer-leg-button').nth(0).click()
  await expect.poll(() => routeCalls.length).toBe(13)
  expect(routeCalls.at(-1)).toBe('A')
  await expect(page.getByRole('heading', { name: 'A', exact: true })).toBeVisible()
  await page.getByRole('button', { name: /返回行程候選/ }).click()
  await expect.poll(() => routeCalls.length).toBe(15)
  await expect(page.locator('.transfer-plan').nth(0)).toHaveClass(/selected/)
})

const overviewCity = { code: 'Tainan', name: '臺南', region: 'south', center: [22.99, 120.21] }

function overviewVariant(routeName: string) {
  return {
    variantKey: `TNN-${routeName}:0`, routeName, routeUid: `TNN-${routeName}`, direction: 0 as const,
    label: '奇美醫院 → 大成路口', subRouteName: routeName, updatedAt: null,
    shape: { type: 'Feature' as const, properties: {}, geometry: { type: 'LineString' as const, coordinates: [[120.2, 22.99], [120.24, 23.02]] } },
    stops: { type: 'FeatureCollection' as const, features: [
      { type: 'Feature' as const, properties: { stopUid: 'S1', stopName: '奇美醫院', sequence: 1 }, geometry: { type: 'Point' as const, coordinates: [120.2, 22.99] as [number, number] } },
    ] },
  }
}

async function mockCatalogue(page: import('./fixtures').Page) {
  await page.route('https://tile.openstreetmap.org/**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/v1/map/cities', (route) => route.fulfill({ json: { cities: [overviewCity] } }))
  await page.route(/\/api\/v1\/map\/routes(?:\?|$)/, (route) => route.fulfill({
    json: { routes: [{ routeName: '15', category: '數字' }] },
  }))
  await page.route(/\/api\/v1\/map\/route(?:\?|$)/, (route) => route.fulfill({
    json: { variants: [overviewVariant('15')] },
  }))
  await page.route('**/api/v1/map/timetable*', (route) => route.fulfill({ json: { timetable: { mode: 'none', services: [] } } }))
  await page.route('**/api/v1/map/vehicles*', (route) => route.fulfill({ json: { vehicles: [] } }))
}

const activeElementInDrawer = (page: import('./fixtures').Page) => page.evaluate(() => {
  const active = document.activeElement
  return Boolean(active && document.getElementById('map-drawer')?.contains(active))
})

test('a keyboard-opened drawer view moves focus into the new content', async ({ page }) => {
  await mockCatalogue(page)
  await page.goto('/map?city=Tainan')

  const drawer = page.locator('#map-drawer')
  const routeButton = drawer.getByRole('button', { name: '15', exact: true })
  await routeButton.focus()
  await page.keyboard.press('Enter')

  await expect(drawer.getByRole('heading', { name: '15' })).toBeVisible()
  expect(await activeElementInDrawer(page)).toBe(true)
})

test('a pointer-opened drawer view leaves focus where the user put it', async ({ page }) => {
  await mockCatalogue(page)
  await page.goto('/map?city=Tainan')

  const drawer = page.locator('#map-drawer')
  const search = drawer.getByRole('textbox', { name: '篩選路線，或搜尋站牌名稱' })
  await search.focus()
  // 滑鼠與觸控不搶焦點:手機上搶焦點會叫出虛擬鍵盤,也會打斷地圖操作。
  await drawer.getByRole('button', { name: '15', exact: true }).click()

  await expect(drawer.getByRole('heading', { name: '15' })).toBeVisible()
  await expect(search).toHaveCount(0)
  expect(await activeElementInDrawer(page)).toBe(false)
})
