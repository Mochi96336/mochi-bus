import { expect, test, type Page } from './fixtures'

const variant = {
  variantKey: 'CHI-7211:0',
  routeName: '7211',
  routeUid: 'CHI7211',
  subRouteUid: 'CHI-7211',
  direction: 0 as const,
  label: '嘉義公園 → 朴子轉運站',
  subRouteName: '7211',
  updatedAt: null,
  shape: {
    type: 'Feature' as const,
    properties: { routeUid: 'CHI7211', direction: 0 },
    geometry: {
      type: 'LineString' as const,
      coordinates: [[120.45, 23.48], [120.44, 23.46], [120.24, 23.46]],
    },
  },
  stops: {
    type: 'FeatureCollection' as const,
    features: [
      {
        type: 'Feature' as const,
        properties: { stopUid: 'C1', stopName: '嘉義公園', sequence: 1 },
        geometry: { type: 'Point' as const, coordinates: [120.45, 23.48] as [number, number] },
      },
      {
        type: 'Feature' as const,
        properties: { stopUid: 'C2', stopName: '嘉義火車站', sequence: 2 },
        geometry: { type: 'Point' as const, coordinates: [120.44, 23.46] as [number, number] },
      },
      {
        type: 'Feature' as const,
        properties: { stopUid: 'C3', stopName: '朴子轉運站', sequence: 3 },
        geometry: { type: 'Point' as const, coordinates: [120.24, 23.46] as [number, number] },
      },
    ],
  },
}

function deferred() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

function timetable(stopUid: 'C1' | 'C2') {
  const selectedStop = stopUid === 'C2'
    ? { stopUid: 'C2', stopName: '嘉義火車站', sequence: 2 }
    : { stopUid: 'C1', stopName: '嘉義公園', sequence: 1 }
  const times = stopUid === 'C1'
    ? Array.from({ length: 15 }, (_, hour) => `${String(hour + 5).padStart(2, '0')}:00`)
    : ['06:12', '08:12']

  return {
    schemaVersion: 1,
    city: 'ChiayiCounty',
    routeName: variant.routeName,
    variantKey: variant.variantKey,
    routeUid: variant.routeUid,
    direction: variant.direction,
    source: 'snapshot',
    timetable: {
      mode: 'stop',
      selectedStop,
      departureStop: { stopUid: 'C1', stopName: '嘉義公園', sequence: 1 },
      timedStopCount: 3,
      stops: [
        { stopUid: 'C1', stopName: '嘉義公園', sequence: 1, hasTimes: true },
        { stopUid: 'C2', stopName: '嘉義火車站', sequence: 2, hasTimes: true },
        { stopUid: 'C3', stopName: '朴子轉運站', sequence: 3, hasTimes: true },
      ],
      services: [{
        id: 'daily',
        label: '每日',
        days: [0, 1, 2, 3, 4, 5, 6],
        today: true,
        times,
        periods: [],
        firstTime: times[0],
        lastTime: times.at(-1)!,
      }],
    },
  }
}

async function mockRoute(page: Page, secondStopGate: Promise<void>, secondStopRequested: ReturnType<typeof deferred>) {
  await page.route('https://tile.openstreetmap.org/**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/v1/map/cities', (route) => route.fulfill({
    json: { cities: [{ code: 'ChiayiCounty', name: '嘉義縣', region: 'south', center: [23.46, 120.35] }] },
  }))
  await page.route(/\/api\/v1\/map\/route(?:\?|$)/, (route) => route.fulfill({ json: { variants: [variant] } }))
  await page.route('**/api/v1/map/vehicles*', (route) => route.fulfill({ json: { vehicles: [] } }))
  await page.route('**/api/v1/map/timetable*', async (route) => {
    const requestedStop = new URL(route.request().url()).searchParams.get('stopUid')
    if (requestedStop === 'C2') {
      secondStopRequested.release()
      await secondStopGate
      await route.fulfill({ json: timetable('C2') })
      return
    }
    await route.fulfill({ json: timetable('C1') })
  })
}

test('keeps the timetable workspace size while another stop is loading', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const secondStopGate = deferred()
  const secondStopRequested = deferred()
  await mockRoute(page, secondStopGate.promise, secondStopRequested)

  await page.goto(`/map?city=ChiayiCounty&route=7211&variant=${encodeURIComponent(variant.variantKey)}`)
  const drawer = page.locator('#map-drawer')
  await expect(drawer.locator('.route-service-summary')).toBeEnabled()
  await drawer.getByRole('button', { name: '查看時刻表' }).click()

  await expect(drawer).toHaveAttribute('data-size', 'expanded')
  const firstScrollRegion = drawer.locator('.drawer-scroll-region')
  await firstScrollRegion.evaluate((element) => { element.scrollTop = 120 })
  await expect.poll(() => firstScrollRegion.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)

  await drawer.getByRole('combobox', { name: '站牌' }).selectOption('C2')
  await secondStopRequested.promise

  await expect(drawer.locator('.drawer-heading p')).toContainText('時刻')
  await expect(drawer.getByText('正在整理表定班次…')).toBeVisible()
  await expect(drawer).toHaveAttribute('data-size', 'expanded')
  await expect(drawer.locator('.drawer-scroll-region')).toHaveJSProperty('scrollTop', 0)

  secondStopGate.release()
  await expect(drawer.locator('.timetable-overview')).toContainText('嘉義火車站')
  await expect(drawer).toHaveAttribute('data-size', 'compact')
})
