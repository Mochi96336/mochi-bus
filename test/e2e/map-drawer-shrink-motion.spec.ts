import { expect, test, type Page } from './fixtures'
import {
  mockMapShell,
  mockRouteCatalogue,
  numberedRouteNames,
  startDrawerCapture,
  stopDrawerCapture,
  twoStopVariant,
} from './drawer-fixtures'

const routeNames = numberedRouteNames(79, '0右')

async function mockMap(page: Page, routeGate: Promise<void>) {
  await mockMapShell(page)
  await mockRouteCatalogue(page, routeNames)
  await page.route(/\/api\/v1\/map\/route(?:\?|$)/, async (route) => {
    await routeGate
    const routeName = new URL(route.request().url()).searchParams.get('route') ?? '0右'
    await route.fulfill({ json: { variants: [twoStopVariant(routeName)] } })
  })
}

// 收合發生在路線資料到達時,不是點下去的當下:讀取中的畫面還不知道會走到變體挑選
// 還是路線詳情,所以它維持目錄的高度。這裡驗證的是那一次收合的動畫品質。
test('animates the mobile drawer from standard down to compact when the route settles', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  let releaseRoute!: () => void
  const routeGate = new Promise<void>((resolve) => { releaseRoute = resolve })
  await mockMap(page, routeGate)
  await page.goto('/map?city=Tainan')

  const drawer = page.locator('#map-drawer')
  await expect(drawer).toHaveAttribute('data-size', 'standard')
  await expect(drawer.locator('.map-route-button')).toHaveCount(routeNames.length)
  const standardHeight = await drawer.evaluate((element) => element.getBoundingClientRect().height)

  await startDrawerCapture(page)
  try {
    await drawer.getByRole('button', { name: '0右', exact: true }).click()
    await expect(drawer.locator('.drawer-heading p')).toContainText('正在拼起路線與站牌')
    // 讀取中不改高度:目錄的 standard 一路留到資料到達。
    await expect(drawer).toHaveAttribute('data-size', 'standard')
    const whileLoading = await drawer.evaluate((element) => element.getBoundingClientRect().height)
    expect(Math.abs(whileLoading - standardHeight)).toBeLessThanOrEqual(1)
  } finally {
    releaseRoute()
  }
  await expect(drawer).toHaveAttribute('data-size', 'compact')
  await page.waitForTimeout(320)

  const frames = await stopDrawerCapture(page)
  const first = frames[0]
  const last = frames.at(-1)!
  expect(Math.abs(first.height - standardHeight)).toBeLessThanOrEqual(1)
  expect(last.height).toBeGreaterThanOrEqual(215)
  expect(last.height).toBeLessThanOrEqual(241)
  expect(last.height).toBeLessThan(standardHeight - 120)

  // 瞬間被 max-height 截短時只會留下起點與終點；正常收合必須走過多個中間值。
  expect(new Set(frames.map((frame) => Math.round(frame.height))).size).toBeGreaterThan(3)
  expect(new Set(frames.map((frame) => Math.round(frame.maxHeight))).size).toBeGreaterThan(3)
  expect(frames.some((frame) => frame.height < first.height - 4 && frame.height > last.height + 4)).toBe(true)

  // height 與 max-height 同步移動，避免任何一個先截斷另一個；overflow 必須持續裁切內容。
  expect(frames.every((frame) => Math.abs(frame.height - frame.maxHeight) <= 2)).toBe(true)
  expect(frames.every((frame) => frame.overflowY !== 'visible')).toBe(true)
  expect(frames.slice(1).every((frame, index) => frame.height <= frames[index].height + 1)).toBe(true)
})
