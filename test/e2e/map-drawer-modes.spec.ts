import { expect, test, type Page } from './fixtures'
import {
  mockMapShell,
  mockRouteCatalogue,
  numberedRouteNames,
  twoStopVariant,
} from './drawer-fixtures'

// 直接重現回報中的兩種長列表：181 條路線與 29 個行車方向。
const routeNames = numberedRouteNames(179, '0右', '0左')
const drawerViewports = [
  { label: '390 × 844', width: 390, height: 844 },
  { label: '420 × 480', width: 420, height: 480 },
  { label: '636 × 381', width: 636, height: 381 },
]

function arrivals() {
  return Array.from({ length: 29 }, (_, index) => ({
    routeName: `路線${String(index + 1).padStart(2, '0')}`,
    routeUid: `ARR-${index + 1}`,
    variantKey: `ARR-${index + 1}:0`,
    direction: 0 as const,
    label: `終點${index + 1} → 臺南火車站`,
    subRouteUid: `ARR-${index + 1}`,
    subRouteName: `路線${index + 1}`,
    stopUid: 'P1-S',
    stopName: '臺南火車站(成功路A)',
    stopSequence: 1,
    estimateSeconds: index === 0 ? 540 : null,
    etaLabel: index === 0 ? '9 分後發車' : `明日 05:${String(40 + (index % 20)).padStart(2, '0')} 發車`,
    stopStatus: 0,
    source: index === 0 ? 'realtime' as const : 'schedule' as const,
  }))
}

async function mockMap(page: Page) {
  await mockMapShell(page)
  await mockRouteCatalogue(page, routeNames)
  await page.route(/\/api\/v1\/map\/route(?:\?|$)/, (route) => {
    const routeName = new URL(route.request().url()).searchParams.get('route') ?? '0右'
    return route.fulfill({ json: { variants: [twoStopVariant(routeName)] } })
  })
  await page.route('**/api/v1/map/place/P1?city=Tainan', (route) => route.fulfill({
    json: { place: { placeId: 'P1', name: '臺南火車站(成功路A)', latitude: 22.997, longitude: 120.212, distanceMeters: 101 } },
  }))
  await page.route('**/api/v1/map/place/P1/arrivals?city=Tainan', (route) => route.fulfill({ json: { routes: arrivals() } }))
}

async function drawerMetrics(page: Page) {
  return page.locator('#map-drawer').evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return {
      height: rect.height,
      viewportHeight: window.innerHeight,
      outerClientHeight: element.clientHeight,
      outerScrollHeight: element.scrollHeight,
    }
  })
}

test('keeps the city route catalogue below half the map with one internal scroller', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await mockMap(page)
  await page.goto('/map?city=Tainan')

  const drawer = page.locator('#map-drawer')
  await expect(drawer.getByRole('heading', { name: '臺南' })).toBeVisible()
  await expect(drawer).toHaveAttribute('data-mode', 'map-list')
  const region = drawer.locator(':scope > .drawer-scroll-shell > .drawer-scroll-region')
  await expect(region).toHaveCount(1)
  await expect(drawer.getByRole('button', { name: /^全部 \d+$/ })).toBeVisible()
  const controls = await drawer.evaluate((element) => {
    const searchRect = element.querySelector<HTMLElement>('.map-search')!.getBoundingClientRect()
    const categoriesRect = element.querySelector<HTMLElement>('.map-categories')!.getBoundingClientRect()
    const chipRect = element.querySelector<HTMLElement>('.map-chip')!.getBoundingClientRect()
    const regionRect = element.querySelector<HTMLElement>(':scope > .drawer-scroll-shell > .drawer-scroll-region')!.getBoundingClientRect()
    return {
      searchHeight: searchRect.height,
      categoriesHeight: categoriesRect.height,
      chipTopGap: chipRect.top - categoriesRect.top,
      chipBottomGap: categoriesRect.bottom - chipRect.bottom,
      regionTopGap: regionRect.top - categoriesRect.bottom,
    }
  })
  expect(controls.searchHeight).toBeGreaterThanOrEqual(38)
  expect(controls.categoriesHeight).toBeGreaterThanOrEqual(28)
  expect(controls.chipTopGap).toBeGreaterThanOrEqual(-1)
  expect(controls.chipBottomGap).toBeGreaterThanOrEqual(-1)
  expect(controls.regionTopGap).toBeGreaterThanOrEqual(0)
  await expect.poll(() => region.evaluate((element) => element.scrollHeight > element.clientHeight + 4)).toBe(true)

  const metrics = await drawerMetrics(page)
  expect(metrics.height).toBeLessThanOrEqual(metrics.viewportHeight * 0.5 + 3)
  expect(metrics.outerScrollHeight).toBeLessThanOrEqual(metrics.outerClientHeight + 1)

  const before = await drawer.evaluate((element) => ({
    backTop: element.querySelector('.drawer-back')!.getBoundingClientRect().top,
    headingTop: element.querySelector('.drawer-heading')!.getBoundingClientRect().top,
  }))
  await region.evaluate((element) => { element.scrollTop = element.scrollHeight })
  await expect.poll(() => region.evaluate((element) => element.scrollTop > 0)).toBe(true)
  const after = await drawer.evaluate((element) => ({
    backTop: element.querySelector('.drawer-back')!.getBoundingClientRect().top,
    headingTop: element.querySelector('.drawer-heading')!.getBoundingClientRect().top,
  }))
  expect(Math.abs(after.backTop - before.backTop)).toBeLessThanOrEqual(1)
  expect(Math.abs(after.headingTop - before.headingTop)).toBeLessThanOrEqual(1)

  const gridMetrics = await drawer.locator('.map-route-grid').evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    overflowY: getComputedStyle(element).overflowY,
  }))
  expect(gridMetrics.scrollHeight).toBeGreaterThan(gridMetrics.clientHeight)
  expect(gridMetrics.overflowY).not.toMatch(/auto|scroll/)

  await region.evaluate((element) => { element.scrollTop = 0 })
  await drawer.getByRole('button', { name: '0右', exact: true }).click()
  await expect(drawer).toHaveAttribute('data-mode', 'compact')
  await expect(drawer.getByRole('heading', { name: '0右' })).toBeVisible()
  await drawer.locator(':scope > .drawer-back').click()
  await expect(drawer).toHaveAttribute('data-mode', 'map-list')
  await expect(drawer.locator(':scope > .drawer-scroll-shell > .drawer-scroll-region')).toHaveJSProperty('scrollTop', 0)
})

test('keeps a 29-direction stop list compact while its header remains visible', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await mockMap(page)
  await page.goto('/map?city=Tainan&place=P1')

  const drawer = page.locator('#map-drawer')
  await expect(drawer.getByRole('heading', { name: '臺南火車站(成功路A)' })).toBeVisible()
  await expect(drawer.locator('.drawer-heading p')).toContainText('29 個行車方向')
  await expect(drawer).toHaveAttribute('data-mode', 'map-list')
  await expect(drawer.locator('.place-route-row')).toHaveCount(29)
  const region = drawer.locator(':scope > .drawer-scroll-shell > .drawer-scroll-region')
  await expect(region).toHaveCount(1)
  await expect.poll(() => region.evaluate((element) => element.scrollHeight > element.clientHeight + 4)).toBe(true)

  const metrics = await drawerMetrics(page)
  expect(metrics.height).toBeLessThanOrEqual(metrics.viewportHeight * 0.5 + 3)
  expect(metrics.outerScrollHeight).toBeLessThanOrEqual(metrics.outerClientHeight + 1)

  const before = await drawer.evaluate((element) => ({
    backTop: element.querySelector('.drawer-back')!.getBoundingClientRect().top,
    headingTop: element.querySelector('.drawer-heading')!.getBoundingClientRect().top,
  }))
  await region.evaluate((element) => { element.scrollTop = element.scrollHeight })
  await expect.poll(() => region.evaluate((element) => element.scrollTop > 0)).toBe(true)
  const after = await drawer.evaluate((element) => ({
    backTop: element.querySelector('.drawer-back')!.getBoundingClientRect().top,
    headingTop: element.querySelector('.drawer-heading')!.getBoundingClientRect().top,
  }))
  expect(Math.abs(after.backTop - before.backTop)).toBeLessThanOrEqual(1)
  expect(Math.abs(after.headingTop - before.headingTop)).toBeLessThanOrEqual(1)
})

for (const viewport of drawerViewports) {
  test(`draws the scroll fade above list content and hides it at the bottom at ${viewport.label}`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await mockMap(page)
    await page.goto('/map?city=Tainan')

    const drawer = page.locator('#map-drawer')
    const shell = drawer.locator(':scope > .drawer-scroll-shell')
    const region = shell.locator(':scope > .drawer-scroll-region')
    const fade = shell.locator(':scope > .drawer-scroll-fade')
    await expect(shell).toHaveCount(1)
    await expect(region).toHaveCount(1)
    await expect(fade).toHaveCount(1)
    await expect.poll(() => region.evaluate((element) => element.classList.contains('scrollable-below'))).toBe(true)
    await expect.poll(() => fade.evaluate((element) => Number(getComputedStyle(element).opacity))).toBe(1)

    const initial = await shell.evaluate((element) => {
      const region = element.querySelector<HTMLElement>(':scope > .drawer-scroll-region')!
      const fade = element.querySelector<HTMLElement>(':scope > .drawer-scroll-fade')!
      const shellRect = element.getBoundingClientRect()
      const regionRect = region.getBoundingClientRect()
      const fadeRect = fade.getBoundingClientRect()
      const fadeStyle = getComputedStyle(fade)
      return {
        shellPosition: getComputedStyle(element).position,
        regionBoxShadow: getComputedStyle(region).boxShadow,
        fadePosition: fadeStyle.position,
        fadePointerEvents: fadeStyle.pointerEvents,
        fadeZIndex: Number(fadeStyle.zIndex),
        fadeOpacity: Number(fadeStyle.opacity),
        fadeBackground: fadeStyle.backgroundImage,
        fadeTop: fadeRect.top,
        fadeBottom: fadeRect.bottom,
        regionBottom: regionRect.bottom,
        shellBottom: shellRect.bottom,
      }
    })
    expect(initial.shellPosition).toBe('relative')
    expect(initial.regionBoxShadow).toBe('none')
    expect(initial.fadePosition).toBe('absolute')
    expect(initial.fadePointerEvents).toBe('none')
    expect(initial.fadeZIndex).toBeGreaterThan(0)
    expect(initial.fadeOpacity).toBe(1)
    expect(initial.fadeBackground).toContain('linear-gradient')
    expect(initial.fadeTop).toBeLessThan(initial.regionBottom)
    expect(Math.abs(initial.fadeBottom - initial.regionBottom)).toBeLessThanOrEqual(1)
    expect(Math.abs(initial.fadeBottom - initial.shellBottom)).toBeLessThanOrEqual(1)

    await region.evaluate((element) => {
      element.scrollTop = (element.scrollHeight - element.clientHeight) / 2
    })
    await expect.poll(() => region.evaluate((element) => element.classList.contains('scrollable-below'))).toBe(true)
    await expect.poll(() => fade.evaluate((element) => Number(getComputedStyle(element).opacity))).toBe(1)

    await region.evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    await expect.poll(() => region.evaluate((element) => element.classList.contains('scrollable-below'))).toBe(false)
    await expect.poll(() => fade.evaluate((element) => Number(getComputedStyle(element).opacity))).toBe(0)
  })
}

test('disconnects the previous drawer observers before rendering a new scroll region', async ({ page }) => {
  await page.addInitScript(() => {
    const state = {
      resizeCreated: 0,
      resizeDisconnected: 0,
      resizeActive: 0,
      mutationCreated: 0,
      mutationDisconnected: 0,
      mutationActive: 0,
    }
    Object.defineProperty(window, '__drawerFadeObserverState', { value: state })

    const NativeResizeObserver = window.ResizeObserver
    window.ResizeObserver = class extends NativeResizeObserver {
      private tracksDrawer = false

      observe(target: Element, options?: ResizeObserverOptions): void {
        if (!this.tracksDrawer && target instanceof HTMLElement && target.classList.contains('drawer-scroll-region')) {
          this.tracksDrawer = true
          state.resizeCreated += 1
          state.resizeActive += 1
        }
        super.observe(target, options)
      }

      disconnect(): void {
        if (this.tracksDrawer) {
          this.tracksDrawer = false
          state.resizeDisconnected += 1
          state.resizeActive -= 1
        }
        super.disconnect()
      }
    }

    const NativeMutationObserver = window.MutationObserver
    window.MutationObserver = class extends NativeMutationObserver {
      private tracksDrawer = false

      observe(target: Node, options?: MutationObserverInit): void {
        if (!this.tracksDrawer && target instanceof HTMLElement && target.classList.contains('drawer-scroll-region')) {
          this.tracksDrawer = true
          state.mutationCreated += 1
          state.mutationActive += 1
        }
        super.observe(target, options)
      }

      disconnect(): void {
        if (this.tracksDrawer) {
          this.tracksDrawer = false
          state.mutationDisconnected += 1
          state.mutationActive -= 1
        }
        super.disconnect()
      }
    }
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await mockMap(page)
  await page.goto('/map?city=Tainan')

  const observerState = () => page.evaluate(() => (
    window as typeof window & {
      __drawerFadeObserverState: {
        resizeCreated: number
        resizeDisconnected: number
        resizeActive: number
        mutationCreated: number
        mutationDisconnected: number
        mutationActive: number
      }
    }
  ).__drawerFadeObserverState)

  await expect.poll(observerState).toMatchObject({
    resizeCreated: 1,
    resizeDisconnected: 0,
    resizeActive: 1,
    mutationCreated: 1,
    mutationDisconnected: 0,
    mutationActive: 1,
  })

  const drawer = page.locator('#map-drawer')
  await drawer.getByRole('button', { name: '0右', exact: true }).click()
  await expect(drawer).toHaveAttribute('data-mode', 'compact')
  await expect.poll(observerState).toMatchObject({
    resizeCreated: 1,
    resizeDisconnected: 1,
    resizeActive: 0,
    mutationCreated: 1,
    mutationDisconnected: 1,
    mutationActive: 0,
  })

  await drawer.locator(':scope > .drawer-back').click()
  await expect(drawer).toHaveAttribute('data-mode', 'map-list')
  await expect.poll(observerState).toMatchObject({
    resizeCreated: 2,
    resizeDisconnected: 1,
    resizeActive: 1,
    mutationCreated: 2,
    mutationDisconnected: 1,
    mutationActive: 1,
  })
})
