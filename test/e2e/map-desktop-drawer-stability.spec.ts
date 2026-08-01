import { expect, test, type Page } from './fixtures'
import {
  clickDesktopStageCenter,
  deferred,
  type DrawerFrame,
  fulfillAfter,
  mockMapShell,
  mockRouteCatalogue,
  openNetwork,
  place,
  routeEntry,
  startDrawerCapture,
  stopDrawerCapture,
  tainan as city,
  trunkRouteNames,
  trunkVariant as variant,
} from './drawer-fixtures'

// placeRoutesDrawerSize 在 8 條以上回 tall,轉運站是常態而不是邊界情況。
const busyStopRoutes = Array.from({ length: 9 }, (_, index) => ({
  ...routeEntry,
  routeName: index === 0 ? routeEntry.routeName : `測試路線 ${index + 1}`,
  routeUid: `R${index + 1}`,
  variantKey: `R${index + 1}:0`,
  stopUid: `P1-S${index + 1}`,
}))

async function mockBootstrap(page: Page, routeCount = 80) {
  await mockMapShell(page)
  await mockRouteCatalogue(page, trunkRouteNames(routeCount))
}

// 順序有意義:place-results 要贏過 loading rows(結果到齊的那一幀兩者可能並存),
// 而 route-loading 與 route-results 共用標題,只有描述文字分得出來。
function phaseOf(frame: DrawerFrame): string {
  if (frame.heading === city.name) return 'catalogue'
  if (frame.hasPlaceRows) return 'place-results'
  if (frame.hasLoadingRows) return frame.heading === '附近站牌' ? 'nearby-loading' : 'place-loading'
  if (frame.hasVariantList) return 'variant-picker'
  if (frame.heading === routeEntry.routeName) {
    return frame.description.includes('正在拼起路線與站牌') ? 'route-loading' : 'route-results'
  }
  return 'other'
}

function expectStableFrames(frames: DrawerFrame[], phases: string[], size = 'standard') {
  const selected = frames.filter((frame) => phases.includes(phaseOf(frame)))
  expect(new Set(selected.map(phaseOf))).toEqual(new Set(phases))
  expect(new Set(selected.map((frame) => frame.size))).toEqual(new Set([size]))
  expect(Math.max(...selected.map((frame) => frame.top)) - Math.min(...selected.map((frame) => frame.top))).toBeLessThanOrEqual(1)
  expect(Math.max(...selected.map((frame) => frame.height)) - Math.min(...selected.map((frame) => frame.height))).toBeLessThanOrEqual(1)
}

test('keeps one standard drawer size while auto-preview resolves into place results', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const nearby = deferred()
  const nearbyRequested = deferred()
  const arrivals = deferred()
  const arrivalsRequested = deferred()
  const preview = deferred()
  const previewRequested = deferred()

  await mockBootstrap(page)
  await page.route('**/api/v1/map/network*', (route) => route.fulfill({
    json: {
      version: 'desktop-stop-stability',
      routes: [],
      places: [{
        placeId: place.placeId,
        name: place.name,
        latitude: place.latitude,
        longitude: place.longitude,
      }],
    },
  }))
  await page.route(/\/api\/v1\/map\/nearby(?:\?|$)/, async (route) => {
    nearbyRequested.release()
    await fulfillAfter(route, nearby.promise, { places: [place] })
  })
  await page.route('**/api/v1/map/place/P1/arrivals?city=Tainan', async (route) => {
    arrivalsRequested.release()
    await fulfillAfter(route, arrivals.promise, { routes: [routeEntry] })
  })
  await page.route(/\/api\/v1\/map\/route(?:\?|$)/, async (route) => {
    previewRequested.release()
    await fulfillAfter(route, preview.promise, { variants: [variant()] })
  })

  await page.goto('/map?city=Tainan')
  const drawer = page.locator('#map-drawer')
  await expect(drawer.getByRole('heading', { name: city.name })).toBeVisible()
  await expect(drawer).toHaveAttribute('data-mode', 'map-list')
  await expect(drawer).toHaveAttribute('data-size', 'standard')
  await expect(drawer).toHaveJSProperty('style.height', '')
  await expect(drawer).toHaveJSProperty('style.minHeight', '')
  await startDrawerCapture(page)

  await openNetwork(page)
  await clickDesktopStageCenter(page)
  await nearbyRequested.promise
  await expect(drawer.getByRole('heading', { name: city.name })).toBeVisible()
  await expect(drawer.getByRole('heading', { name: '附近站牌' })).toHaveCount(0)
  await page.waitForTimeout(100)

  nearby.release()
  await arrivalsRequested.promise
  await expect(drawer.getByRole('heading', { name: place.name })).toBeVisible()
  await expect(drawer.locator('.map-loading-row')).toHaveCount(3)
  await page.waitForTimeout(100)

  arrivals.release()
  await previewRequested.promise
  await expect(drawer.locator('.place-route-row')).toHaveCount(1)
  await page.waitForTimeout(100)

  preview.release()
  await expect(page.locator('.leaflet-routePreview-pane svg path')).toHaveCount(1)
  await page.waitForTimeout(120)

  const frames = await stopDrawerCapture(page)
  expectStableFrames(frames, ['catalogue', 'place-loading', 'place-results'])
  expect(frames.some((frame) => phaseOf(frame) === 'nearby-loading')).toBe(false)
  await expect(drawer).toHaveJSProperty('style.height', '')
  await expect(drawer).toHaveJSProperty('style.minHeight', '')
})

test('keeps URL-opened nearby loading and results at the nearby size', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const nearby = deferred()
  const nearbyRequested = deferred()

  await mockBootstrap(page)
  await page.route(/\/api\/v1\/map\/nearby(?:\?|$)/, async (route) => {
    nearbyRequested.release()
    await fulfillAfter(route, nearby.promise, { places: [place] })
  })

  await page.goto('/map?city=Tainan&lat=22.99700&lon=120.21200')
  const drawer = page.locator('#map-drawer')
  await nearbyRequested.promise
  await expect(drawer.getByRole('heading', { name: '附近站牌' })).toBeVisible()
  await expect(drawer).toHaveAttribute('data-size', 'nearby')
  await expect(drawer).toHaveJSProperty('style.height', '')
  await expect(drawer).toHaveJSProperty('style.minHeight', '')
  const loadingHeight = await drawer.evaluate((element) => element.getBoundingClientRect().height)

  nearby.release()
  await expect(drawer.locator('.nearby-place-button')).toHaveCount(1)
  await expect(drawer).toHaveAttribute('data-size', 'nearby')
  await expect(drawer).toHaveJSProperty('style.height', '')
  await expect(drawer).toHaveJSProperty('style.minHeight', '')
  const resolvedHeight = await drawer.evaluate((element) => element.getBoundingClientRect().height)
  expect(Math.abs(resolvedHeight - loadingHeight)).toBeLessThanOrEqual(1)
})

async function openBusyStop(page: Page) {
  const arrivals = deferred()
  const arrivalsRequested = deferred()

  await mockBootstrap(page)
  await page.route(/\/api\/v1\/map\/nearby(?:\?|$)/, (route) => route.fulfill({ json: { places: [place] } }))
  await page.route('**/api/v1/map/place/P1?city=Tainan', (route) => route.fulfill({ json: { place } }))
  await page.route(/\/api\/v1\/map\/route(?:\?|$)/, (route) => route.fulfill({ json: { variants: [] } }))
  await page.route('**/api/v1/map/place/P1/arrivals?city=Tainan', async (route) => {
    arrivalsRequested.release()
    await fulfillAfter(route, arrivals.promise, { routes: busyStopRoutes })
  })

  await page.goto('/map?city=Tainan&place=P1')
  await arrivalsRequested.promise
  return arrivals
}

// 點站牌是 nearby → place 的跨 workspace 導覽,而且兩邊尺寸狀態本來就不同(nearby
// 比 standard 矮)。骨架標記為 transient,所以它沿用附近清單的高度,不套用 place
// workspace 自己的 standard,也不套用這個站牌上次落在的 tall。
test('holds the nearby height through the place skeleton, on a stop already seen at its content size', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const secondVisit = deferred()
  const secondVisitRequested = deferred()
  let arrivalsCalls = 0

  await mockBootstrap(page)
  await page.route(/\/api\/v1\/map\/nearby(?:\?|$)/, (route) => route.fulfill({ json: { places: [place] } }))
  await page.route('**/api/v1/map/place/P1?city=Tainan', (route) => route.fulfill({ json: { place } }))
  await page.route(/\/api\/v1\/map\/route(?:\?|$)/, (route) => route.fulfill({ json: { variants: [] } }))
  await page.route('**/api/v1/map/place/P1/arrivals?city=Tainan', async (route) => {
    arrivalsCalls += 1
    if (arrivalsCalls === 1) {
      await route.fulfill({ json: { routes: busyStopRoutes } })
      return
    }
    secondVisitRequested.release()
    await fulfillAfter(route, secondVisit.promise, { routes: busyStopRoutes })
  })

  await page.goto('/map?city=Tainan&lat=22.99700&lon=120.21200')
  const drawer = page.locator('#map-drawer')
  await drawer.locator('.nearby-place-button').first().click()
  await expect(drawer.locator('.place-route-row')).toHaveCount(busyStopRoutes.length)
  await expect(drawer).toHaveAttribute('data-size', 'tall')

  await drawer.locator('.drawer-back').click()
  await expect(drawer.locator('.nearby-place-button')).toHaveCount(1)
  await expect(drawer).toHaveAttribute('data-size', 'nearby')
  // 取樣要在 tall → nearby 的高度過渡(220ms)結束之後開始,否則錄到的是動畫中途值。
  await page.waitForTimeout(400)

  // 從附近清單一路錄到 skeleton 貼上去為止。斷言的不是頭尾相等,而是中間沒有任何
  // 一幀動過——高度過渡會讓「只比對兩個取樣點」放過一次真正的跳動。
  await startDrawerCapture(page)
  await drawer.locator('.nearby-place-button').first().click()
  await secondVisitRequested.promise
  await expect(drawer.locator('.map-loading-row')).toHaveCount(3)
  await page.waitForTimeout(300)
  const frames = await stopDrawerCapture(page)

  expect(frames.some((frame) => phaseOf(frame) === 'place-loading')).toBe(true)
  expect(new Set(frames.map((frame) => frame.size))).toEqual(new Set(['nearby']))
  const heights = frames.map((frame) => frame.height)
  expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(1)

  // 尺寸仍然會變,但只在資料到達時變一次。
  secondVisit.release()
  await expect(drawer.locator('.place-route-row')).toHaveCount(busyStopRoutes.length)
  await expect(drawer).toHaveAttribute('data-size', 'tall')
})

// 讀取骨架在還不知道路線數時就得決定尺寸,drawerSizeForTransition 給的預設是
// standard。1–7 條路線的站牌剛好對上,轉運站不會,所以結果到達時抽屜一定要長高。
// 鎖住的不是「不准變」,而是「只變一次,而且是長高不是跳動」。
test('grows a busy stop to its content size exactly once, as motion rather than a jump', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const arrivals = await openBusyStop(page)

  const drawer = page.locator('#map-drawer')
  await expect(drawer.locator('.map-loading-row')).toHaveCount(3)
  await expect(drawer).toHaveAttribute('data-size', 'standard')
  await startDrawerCapture(page)

  arrivals.release()
  await expect(drawer.locator('.place-route-row')).toHaveCount(busyStopRoutes.length)
  await page.waitForTimeout(400)
  const frames = await stopDrawerCapture(page)

  const sizeSequence = frames
    .map((frame) => frame.size)
    .filter((size, index, all) => size !== all[index - 1])
  expect(sizeSequence).toEqual(['standard', 'tall'])

  // 高度必須真的走過中間值。若是瞬間跳,取樣到的高度只會有起訖兩種。
  const heights = new Set(frames.map((frame) => Math.round(frame.height)))
  expect(heights.size).toBeGreaterThan(2)
  await expect(drawer).toHaveJSProperty('style.height', '')
})

test('resizes the drawer instantly when motion is not wanted', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  // 用 emulateMedia 而不是 test.use({ reducedMotion }):後者在 describe 層不會
  // 套用到這個 spec 的 page fixture,實測 matchMedia 仍回 false。
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const arrivals = await openBusyStop(page)

  const drawer = page.locator('#map-drawer')
  await expect(drawer.locator('.map-loading-row')).toHaveCount(3)
  arrivals.release()
  await expect(drawer.locator('.place-route-row')).toHaveCount(busyStopRoutes.length)

  await expect(drawer).toHaveAttribute('data-size', 'tall')
  await expect(drawer).toHaveCSS('transition-duration', '0s')
})

// 讀取中的畫面還不知道會走到變體挑選還是路線詳情,所以它不決定高度:全路網目錄的
// standard 一路留到路線資料到達,收合只發生一次。
test('holds the network catalogue height through route loading, then settles compact', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const routeGate = deferred()
  const routeRequested = deferred()

  await mockBootstrap(page)
  await page.route('**/api/v1/map/network*', (route) => route.fulfill({
    json: {
      version: 'desktop-route-stability',
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
  await expect(drawer).toHaveAttribute('data-mode', 'compact')
  await expect(drawer).toHaveAttribute('data-size', 'standard')
  await expect(drawer).toHaveJSProperty('style.minHeight', '')
  await page.waitForTimeout(320)
  await startDrawerCapture(page)
  await page.waitForTimeout(120)
  const loadingFrames = await stopDrawerCapture(page)
  expectStableFrames(loadingFrames, ['route-loading'], 'standard')

  routeGate.release()
  await expect(drawer.getByRole('button', { name: '← 更換路線' })).toBeVisible()
  await expect(drawer.locator('.route-service-summary')).toHaveCount(0)
  await expect(drawer).toHaveAttribute('data-size', 'compact')
  await page.waitForTimeout(320)
  await expect(drawer).toHaveJSProperty('style.height', '')
  await expect(drawer).toHaveJSProperty('style.minHeight', '')
})

test('keeps a sparse desktop catalogue in the standard workspace', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await mockBootstrap(page, 1)
  await page.goto('/map?city=Tainan')

  const drawer = page.locator('#map-drawer')
  await expect(drawer.getByRole('heading', { name: city.name })).toBeVisible()
  await expect(drawer).toHaveAttribute('data-size', 'standard')
  const geometry = await drawer.evaluate((element) => ({
    height: element.getBoundingClientRect().height,
    viewportHeight: window.innerHeight,
    inlineHeight: element.style.height,
    inlineMinHeight: element.style.minHeight,
  }))
  expect(geometry.inlineHeight).toBe('')
  expect(geometry.inlineMinHeight).toBe('')
  expect(geometry.height).toBeLessThanOrEqual(geometry.viewportHeight * 0.5)
  expect(geometry.height).toBeGreaterThan(geometry.viewportHeight * 0.4)
})
