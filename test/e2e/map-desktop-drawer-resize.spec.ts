import { expect, test, type Page } from './fixtures'
import {
  clickDesktopStageCenter,
  deferred,
  fulfillAfter,
  mockMapShell,
  mockRouteCatalogue,
  openNetwork,
  routeEntry,
  tainan as city,
  trunkRouteNames,
  trunkVariant as variant,
} from './drawer-fixtures'

async function mockBootstrap(page: Page) {
  await mockMapShell(page)
  await mockRouteCatalogue(page, trunkRouteNames())
}

test('recomputes the compact desktop drawer size when the viewport shrinks during route loading', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const routeGate = deferred()
  const routeRequested = deferred()

  await mockBootstrap(page)
  await page.route('**/api/v1/map/network*', (route) => route.fulfill({
    json: {
      version: 'desktop-route-resize',
      routes: [{
        routeName: routeEntry.routeName,
        variantKey: routeEntry.variantKey,
        label: routeEntry.label,
        shape: variant().shape,
      }],
      places: [],
    },
  }))
  await page.route(/\/api\/v1\/map\/route(?:\?|$)/, async (route) => {
    routeRequested.release()
    await fulfillAfter(route, routeGate.promise, { variants: [variant()] })
  })

  await page.goto('/map?city=Tainan')
  const drawer = page.locator('#map-drawer')
  await expect(drawer.getByRole('heading', { name: city.name })).toBeVisible()

  await openNetwork(page)
  await clickDesktopStageCenter(page)
  await routeRequested.promise
  await expect(drawer.getByRole('heading', { name: routeEntry.routeName })).toBeVisible()
  // 讀取中沿用全路網的 standard;compact 要等路線資料到達。這裡要驗的是尺寸重算,
  // 所以先讓它落到 compact 再縮視窗。
  await expect(drawer).toHaveAttribute('data-size', 'standard')
  routeGate.release()
  await expect(drawer).toHaveAttribute('data-size', 'compact')
  await expect(drawer).toHaveJSProperty('style.minHeight', '')
  await page.waitForTimeout(320)
  const beforeResize = await drawer.evaluate((element) => element.getBoundingClientRect().height)

  await page.setViewportSize({ width: 1280, height: 600 })
  await expect.poll(() => drawer.evaluate((element) => {
    const height = element.getBoundingClientRect().height
    const maximumHeight = Number.parseFloat(getComputedStyle(element).maxHeight)
    return Math.abs(height - maximumHeight)
  })).toBeLessThanOrEqual(1)

  const resized = await drawer.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return {
      height: rect.height,
      bottom: rect.bottom,
      maximumHeight: Number.parseFloat(getComputedStyle(element).maxHeight),
      viewportHeight: window.innerHeight,
      inlineMinHeight: element.style.minHeight,
    }
  })
  expect(resized.inlineMinHeight).toBe('')
  expect(resized.height).toBeLessThan(beforeResize)
  expect(resized.height).toBeLessThanOrEqual(resized.maximumHeight + 1)
  expect(resized.bottom).toBeLessThanOrEqual(resized.viewportHeight)

  routeGate.release()
  await expect(drawer.getByRole('button', { name: '← 更換路線' })).toBeVisible()
  await expect(drawer).toHaveAttribute('data-size', 'compact')
  await expect(drawer).toHaveJSProperty('style.minHeight', '')
})
