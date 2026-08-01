import type { Route } from '@playwright/test'
import { expect, test, type Page } from './fixtures'

const city = { code: 'Tainan', name: '臺南', region: 'south', center: [22.997, 120.212] }
const place = {
  placeId: 'P1',
  name: '臺南火車站',
  latitude: 22.997,
  longitude: 120.212,
  distanceMeters: 76,
}
const routeEntry = {
  routeName: '中山幹線',
  routeUid: 'R1',
  variantKey: 'R1:0',
  direction: 0 as const,
  label: '大臺南公園 → 嘉義大學校區內',
  subRouteUid: 'R1',
  subRouteName: '中山幹線',
  stopUid: 'P1-S',
  stopName: '臺南火車站',
  stopSequence: 2,
  estimateSeconds: 120,
  etaLabel: '2 分',
  stopStatus: 0,
  source: 'realtime' as const,
}

// placeRoutesDrawerSize 在 8 條以上回 tall,轉運站是常態而不是邊界情況。
const busyStopRoutes = Array.from({ length: 9 }, (_, index) => ({
  ...routeEntry,
  routeName: index === 0 ? routeEntry.routeName : `測試路線 ${index + 1}`,
  routeUid: `R${index + 1}`,
  variantKey: `R${index + 1}:0`,
  stopUid: `P1-S${index + 1}`,
}))

type DrawerFrame = {
  top: number
  height: number
  view: string
  mode: string
  size: string
  phase: string
}

function variant() {
  return {
    variantKey: routeEntry.variantKey,
    routeName: routeEntry.routeName,
    routeUid: routeEntry.routeUid,
    subRouteUid: routeEntry.subRouteUid,
    direction: 0 as const,
    label: routeEntry.label,
    subRouteName: routeEntry.subRouteName,
    updatedAt: null,
    shape: {
      type: 'Feature' as const,
      properties: {},
      geometry: {
        type: 'LineString' as const,
        coordinates: [[120.209, 22.997], [120.212, 22.997], [120.215, 22.997]],
      },
    },
    stops: {
      type: 'FeatureCollection' as const,
      features: [{
        type: 'Feature' as const,
        properties: { stopUid: routeEntry.stopUid, stopName: routeEntry.stopName, sequence: 2 },
        geometry: { type: 'Point' as const, coordinates: [120.212, 22.997] as [number, number] },
      }],
    },
  }
}

function deferred() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

async function fulfillAfter(route: Route, gate: Promise<void>, json: unknown) {
  await gate
  try {
    await route.fulfill({ json })
  } catch {
    // A newer navigation may abort a delayed request; a closed route is expected in that case.
  }
}

async function mockBootstrap(page: Page, routeCount = 80) {
  await page.route('https://tile.openstreetmap.org/**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/v1/map/cities', (route) => route.fulfill({ json: { cities: [city] } }))
  await page.route(/\/api\/v1\/map\/routes(?:\?|$)/, (route) => route.fulfill({
    json: {
      routes: Array.from({ length: routeCount }, (_, index) => ({
        routeName: index === 0 ? routeEntry.routeName : `測試路線 ${index + 1}`,
        category: index % 4 === 0 ? '幹線' : '數字',
      })),
    },
  }))
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

async function startDrawerFrameCapture(page: Page) {
  await page.evaluate(() => {
    type Frame = { top: number; height: number; view: string; mode: string; size: string; phase: string }
    type FrameStore = { active: boolean; frames: Frame[] }
    const store: FrameStore = { active: true, frames: [] }
    ;(window as Window & { __drawerFrameStore?: FrameStore }).__drawerFrameStore = store
    const drawer = document.getElementById('map-drawer')!
    const sample = () => {
      if (!store.active) return
      const rect = drawer.getBoundingClientRect()
      const heading = drawer.querySelector<HTMLElement>('.drawer-heading h1')?.textContent ?? ''
      const description = drawer.querySelector<HTMLElement>('.drawer-heading p')?.textContent ?? ''
      let phase = 'other'
      if (heading === '臺南') phase = 'catalogue'
      else if (drawer.querySelector('.place-route-row')) phase = 'place-results'
      else if (drawer.querySelector('.map-loading-row')) {
        phase = heading === '附近站牌' ? 'nearby-loading' : 'place-loading'
      } else if (drawer.querySelector('.variant-list')) phase = 'variant-picker'
      else if (heading === '中山幹線' && description.includes('正在拼起路線與站牌')) phase = 'route-loading'
      else if (heading === '中山幹線') phase = 'route-results'
      store.frames.push({
        top: rect.top,
        height: rect.height,
        view: drawer.dataset.view ?? '',
        mode: drawer.dataset.mode ?? '',
        size: drawer.dataset.size ?? '',
        phase,
      })
      window.requestAnimationFrame(sample)
    }
    // 第一幀同步取,不等 rAF。否則呼叫端「開始取樣 → 放行回應」之間若沒撐過一次
    // 繪製,起始狀態就漏掉了,取樣結果會看起來像從未發生過變化。
    sample()
  })
}

async function stopDrawerFrameCapture(page: Page): Promise<DrawerFrame[]> {
  return page.evaluate(() => {
    type Frame = { top: number; height: number; view: string; mode: string; size: string; phase: string }
    type FrameStore = { active: boolean; frames: Frame[] }
    const store = (window as Window & { __drawerFrameStore?: FrameStore }).__drawerFrameStore!
    store.active = false
    return store.frames
  })
}

function expectStableFrames(frames: DrawerFrame[], phases: string[], size = 'standard') {
  const selected = frames.filter((frame) => phases.includes(frame.phase))
  expect(new Set(selected.map((frame) => frame.phase))).toEqual(new Set(phases))
  expect(new Set(selected.map((frame) => frame.size))).toEqual(new Set([size]))
  expect(Math.max(...selected.map((frame) => frame.top)) - Math.min(...selected.map((frame) => frame.top))).toBeLessThanOrEqual(1)
  expect(Math.max(...selected.map((frame) => frame.height)) - Math.min(...selected.map((frame) => frame.height))).toBeLessThanOrEqual(1)
}

async function openNetwork(page: Page) {
  const network = page.getByRole('button', { name: '切換全路網與全部站點' })
  await network.click()
  await expect(network).toHaveAttribute('aria-pressed', 'true')
  await expect(network).not.toHaveAttribute('aria-busy')
}

async function clickDesktopStageCenter(page: Page) {
  const mapBox = await page.locator('#map').boundingBox()
  const drawerBox = await page.locator('#map-drawer').boundingBox()
  if (!mapBox || !drawerBox) throw new Error('map stage has no layout box')
  // focusPoint places the city center in the drawer-aware visible stage. These offsets mirror
  // the desktop camera padding constants: left 45, top 90, bottom 45, safety gap 48.
  const targetX = mapBox.x + (drawerBox.x - mapBox.x + 45 - 48) / 2
  const targetY = mapBox.y + mapBox.height / 2 + (90 - 45) / 2
  await page.mouse.click(targetX, targetY)
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
  await startDrawerFrameCapture(page)

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

  const frames = await stopDrawerFrameCapture(page)
  expectStableFrames(frames, ['catalogue', 'place-loading', 'place-results'])
  expect(frames.some((frame) => frame.phase === 'nearby-loading')).toBe(false)
  await expect(drawer).toHaveJSProperty('style.height', '')
  await expect(drawer).toHaveJSProperty('style.minHeight', '')
})

test('keeps URL-opened nearby loading and results at the standard size', async ({ page }) => {
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
  await expect(drawer).toHaveAttribute('data-size', 'standard')
  await expect(drawer).toHaveJSProperty('style.height', '')
  await expect(drawer).toHaveJSProperty('style.minHeight', '')
  const loadingHeight = await drawer.evaluate((element) => element.getBoundingClientRect().height)

  nearby.release()
  await expect(drawer.locator('.nearby-place-button')).toHaveCount(1)
  await expect(drawer).toHaveAttribute('data-size', 'standard')
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

// 曾經有一份 size memory 讓 skeleton 照著上次的尺寸開,於是重訪轉運站時抽屜會在
// skeleton 貼上去的瞬間從 standard 跳到 tall——只是把落地時的跳動提前到讀取中發生。
// 現在 skeleton 沿用抽屜當下的高度,讀取中一律不動。
test('does not resize when the skeleton returns to a stop already seen at its content size', async ({ page }) => {
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
  await expect(drawer).toHaveAttribute('data-size', 'standard')
  // 取樣要在 tall → standard 的高度過渡(220ms)結束之後開始,否則錄到的是動畫中途值。
  await page.waitForTimeout(400)

  // 從附近清單一路錄到 skeleton 貼上去為止。斷言的不是頭尾相等,而是中間沒有任何
  // 一幀動過——高度過渡會讓「只比對兩個取樣點」放過一次真正的跳動。
  await startDrawerFrameCapture(page)
  await drawer.locator('.nearby-place-button').first().click()
  await secondVisitRequested.promise
  await expect(drawer.locator('.map-loading-row')).toHaveCount(3)
  await page.waitForTimeout(300)
  const frames = await stopDrawerFrameCapture(page)

  expect(frames.some((frame) => frame.phase === 'place-loading')).toBe(true)
  expect(new Set(frames.map((frame) => frame.size))).toEqual(new Set(['standard']))
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
  await startDrawerFrameCapture(page)

  arrivals.release()
  await expect(drawer.locator('.place-route-row')).toHaveCount(busyStopRoutes.length)
  await page.waitForTimeout(400)
  const frames = await stopDrawerFrameCapture(page)

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

test('keeps a full-network route click compact through loading and result', async ({ page }) => {
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
  await expect(drawer).toHaveAttribute('data-size', 'compact')
  await expect(drawer).toHaveJSProperty('style.minHeight', '')
  await page.waitForTimeout(220)
  await startDrawerFrameCapture(page)
  await page.waitForTimeout(40)

  routeGate.release()
  await expect(drawer.getByRole('button', { name: '← 更換路線' })).toBeVisible()
  await expect(drawer.locator('.route-service-summary')).toHaveCount(0)
  await expect(drawer).toHaveAttribute('data-size', 'compact')
  await page.waitForTimeout(120)

  const frames = await stopDrawerFrameCapture(page)
  expectStableFrames(frames, ['route-loading', 'route-results'], 'compact')
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
