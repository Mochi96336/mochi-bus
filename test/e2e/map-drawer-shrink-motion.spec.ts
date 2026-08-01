import { expect, test, type Page } from './fixtures'

const city = { code: 'Tainan', name: '臺南', region: 'south', center: [22.99, 120.21] }
const routeNames = ['0右', ...Array.from({ length: 79 }, (_, index) => String(index + 1))]

function routeVariant(routeName: string) {
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
    await route.fulfill({ json: { variants: [routeVariant(routeName)] } })
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

type DrawerMotionFrame = {
  height: number
  maxHeight: number
  overflowY: string
}

async function startDrawerMotionCapture(page: Page) {
  await page.evaluate(() => {
    type Frame = { height: number; maxHeight: number; overflowY: string }
    type Store = { active: boolean; frames: Frame[] }
    const store: Store = { active: true, frames: [] }
    ;(window as Window & { __drawerMotionStore?: Store }).__drawerMotionStore = store
    const drawer = document.getElementById('map-drawer')!

    const sample = () => {
      if (!store.active) return
      const style = getComputedStyle(drawer)
      store.frames.push({
        height: drawer.getBoundingClientRect().height,
        maxHeight: Number.parseFloat(style.maxHeight),
        overflowY: style.overflowY,
      })
      window.requestAnimationFrame(sample)
    }

    // 同步留住切換前的 standard 起點；否則 click 可能在第一個 rAF 前就完成 DOM 更新。
    sample()
  })
}

async function stopDrawerMotionCapture(page: Page): Promise<DrawerMotionFrame[]> {
  return page.evaluate(() => {
    type Frame = { height: number; maxHeight: number; overflowY: string }
    type Store = { active: boolean; frames: Frame[] }
    const store = (window as Window & { __drawerMotionStore?: Store }).__drawerMotionStore!
    store.active = false
    return store.frames
  })
}

test('animates the mobile drawer from standard down to compact without exposing content', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  let releaseRoute!: () => void
  const routeGate = new Promise<void>((resolve) => { releaseRoute = resolve })
  await mockMap(page, routeGate)
  await page.goto('/map?city=Tainan')

  const drawer = page.locator('#map-drawer')
  await expect(drawer).toHaveAttribute('data-size', 'standard')
  await expect(drawer.locator('.map-route-button')).toHaveCount(routeNames.length)
  const standardHeight = await drawer.evaluate((element) => element.getBoundingClientRect().height)

  await startDrawerMotionCapture(page)
  try {
    await drawer.getByRole('button', { name: '0右', exact: true }).click()
    await expect(drawer).toHaveAttribute('data-size', 'compact')
    await expect(drawer.locator('.drawer-heading p')).toContainText('正在拼起路線與站牌')
    await page.waitForTimeout(320)
  } finally {
    releaseRoute()
  }

  const frames = await stopDrawerMotionCapture(page)
  const first = frames[0]
  const last = frames.at(-1)!
  expect(Math.abs(first.height - standardHeight)).toBeLessThanOrEqual(1)
  expect(last.height).toBeGreaterThanOrEqual(239)
  expect(last.height).toBeLessThanOrEqual(301)
  expect(last.height).toBeLessThan(standardHeight - 60)

  // 瞬間被 max-height 截短時只會留下起點與終點；正常收合必須走過多個中間值。
  expect(new Set(frames.map((frame) => Math.round(frame.height))).size).toBeGreaterThan(3)
  expect(new Set(frames.map((frame) => Math.round(frame.maxHeight))).size).toBeGreaterThan(3)
  expect(frames.some((frame) => frame.height < first.height - 4 && frame.height > last.height + 4)).toBe(true)

  // height 與 max-height 同步移動，避免任何一個先截斷另一個；overflow 必須持續裁切內容。
  expect(frames.every((frame) => Math.abs(frame.height - frame.maxHeight) <= 2)).toBe(true)
  expect(frames.every((frame) => frame.overflowY !== 'visible')).toBe(true)
  expect(frames.slice(1).every((frame, index) => frame.height <= frames[index].height + 1)).toBe(true)
})
