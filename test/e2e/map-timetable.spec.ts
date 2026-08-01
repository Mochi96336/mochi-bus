import { expect, test, type Page } from './fixtures'
import { calculateCameraPadding } from '../../src/domain/map/camera-padding'

const variant = {
  variantKey: 'CHI-7211:0', routeName: '7211', routeUid: 'CHI7211', subRouteUid: 'CHI-7211', direction: 0 as const,
  label: '嘉義公園 → 朴子轉運站', subRouteName: '7211', updatedAt: null,
  shape: { type: 'Feature' as const, properties: { routeUid: 'CHI7211', direction: 0 }, geometry: { type: 'LineString' as const, coordinates: [[120.45, 23.48], [120.44, 23.46], [120.24, 23.46]] } },
  stops: { type: 'FeatureCollection' as const, features: [
    { type: 'Feature' as const, properties: { stopUid: 'C1', stopName: '嘉義公園', sequence: 1 }, geometry: { type: 'Point' as const, coordinates: [120.45, 23.48] as [number, number] } },
    { type: 'Feature' as const, properties: { stopUid: 'C2', stopName: '嘉義火車站', sequence: 2 }, geometry: { type: 'Point' as const, coordinates: [120.44, 23.46] as [number, number] } },
    { type: 'Feature' as const, properties: { stopUid: 'C3', stopName: '朴子轉運站', sequence: 3 }, geometry: { type: 'Point' as const, coordinates: [120.24, 23.46] as [number, number] } },
  ] },
}

type TimetableFixture = 'multiple' | 'single' | 'no-today' | 'long' | 'time-states'

function timetable(stopUid = 'C1') {
  const stop = stopUid === 'C2'
    ? { stopUid: 'C2', stopName: '嘉義火車站', sequence: 2 }
    : { stopUid: 'C1', stopName: '嘉義公園', sequence: 1 }
  const offset = stopUid === 'C2' ? 12 : 0
  const time = (hour: number) => `${String(hour).padStart(2, '0')}:${String(offset).padStart(2, '0')}`
  return {
    schemaVersion: 1, city: 'ChiayiCounty', routeName: '7211', variantKey: variant.variantKey,
    routeUid: variant.routeUid, direction: 0, source: 'snapshot',
    timetable: {
      mode: 'stop', selectedStop: stop, departureStop: { stopUid: 'C1', stopName: '嘉義公園', sequence: 1 }, timedStopCount: 3,
      stops: [
        { stopUid: 'C1', stopName: '嘉義公園', sequence: 1, hasTimes: true },
        { stopUid: 'C2', stopName: '嘉義火車站', sequence: 2, hasTimes: true },
        { stopUid: 'C3', stopName: '朴子轉運站', sequence: 3, hasTimes: true },
      ],
      services: [
        // 故意把非今日服務放前面，確認 UI 依 today 選取，而不是偷靠陣列順序。
        { id: '6', label: '週六', days: [6], today: false, times: [time(7), time(19)], periods: [], firstTime: time(7), lastTime: time(19) },
        { id: '0-1-2-3-4-5-6', label: '每日', days: [0, 1, 2, 3, 4, 5, 6], today: true, times: [time(6), time(7), time(22)], periods: [], firstTime: time(6), lastTime: time(22) },
      ],
    },
  }
}

function timetableFixture(stopUid: string, fixture: TimetableFixture) {
  const data = timetable(stopUid)
  if (fixture === 'single') {
    data.timetable.services = data.timetable.services.filter((service) => service.label === '每日')
  }
  if (fixture === 'no-today') {
    const saturday = data.timetable.services[0]
    data.timetable.services = [
      saturday,
      { ...saturday, id: '0', label: '週日', days: [0], times: ['08:00', '20:00'], firstTime: '08:00', lastTime: '20:00' },
    ]
  }
  if (fixture === 'long') {
    const daily = data.timetable.services.find((service) => service.today)!
    daily.times = Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, '0')}:00`)
    daily.firstTime = daily.times[0]
    daily.lastTime = daily.times.at(-1)!
    data.timetable.services = [daily]
  }
  if (fixture === 'time-states') {
    const daily = data.timetable.services.find((service) => service.today)!
    daily.times = ['09:00', '09:30', '10:00']
    daily.firstTime = daily.times[0]
    daily.lastTime = daily.times.at(-1)!
    data.timetable.services = [daily]
  }
  return data
}

async function mockRoute(page: Page, fixture: TimetableFixture = 'multiple') {
  await page.route('https://tile.openstreetmap.org/**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/v1/map/cities', (route) => route.fulfill({ json: { cities: [{ code: 'ChiayiCounty', name: '嘉義縣', region: 'south', center: [23.46, 120.35] }] } }))
  await page.route(/\/api\/v1\/map\/route(?:\?|$)/, (route) => route.fulfill({ json: { variants: [variant] } }))
  await page.route('**/api/v1/map/vehicles*', (route) => route.fulfill({ json: { vehicles: [] } }))
  await page.route('**/api/v1/map/timetable*', (route) => {
    const stopUid = new URL(route.request().url()).searchParams.get('stopUid') ?? 'C1'
    return route.fulfill({ json: timetableFixture(stopUid, fixture) })
  })
}

test('opens a per-stop timetable without turning it into a wide table', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await mockRoute(page)
  await page.goto(`/map?city=ChiayiCounty&route=7211&variant=${encodeURIComponent(variant.variantKey)}`)

  const drawer = page.locator('#map-drawer')
  // 路線詳情跟其他抽屜次頁一致：退路在最上方，不再佔用底部整列。
  await expect(drawer.locator(':scope > .drawer-back')).toHaveText('← 更換路線')
  await expect(drawer.locator('.route-view-actions')).toHaveCount(0)
  // 時刻摘要列本身就是時刻表入口:載入完成前是佔位、完成後才可點。
  await expect(drawer.locator('.route-service-summary')).toContainText('首班 06:00 · 末班 22:00')
  await drawer.getByRole('button', { name: '查看時刻表' }).click()

  await expect(drawer.getByRole('heading', { name: '7211' })).toBeVisible()
  await expect(drawer).toHaveAttribute('data-mode', 'timetable')
  await expect(drawer.locator(':scope > .drawer-scroll-shell > .drawer-scroll-region > .timetable-panel')).toHaveCount(1)
  await expect(drawer.locator('.drawer-heading p')).toContainText('時刻')
  const activeTab = drawer.locator('.timetable-tab[aria-selected="true"]')
  await expect(activeTab).toHaveText('每日')
  await expect(activeTab).toHaveAttribute('aria-label', '每日')
  await expect(drawer.getByText('今天', { exact: true })).toHaveCount(0)

  const stopSelect = drawer.getByRole('combobox', { name: '站牌' })
  await expect(stopSelect).toBeVisible()
  await stopSelect.selectOption('C2')
  await expect(stopSelect).toHaveValue('C2')
  await expect(drawer.locator('.timetable-overview')).toContainText('嘉義火車站')
  await expect(drawer.locator('.timetable-hour-row').first()).toContainText('12')
  await expect.poll(async () => {
    const geometry = await page.evaluate(() => {
      const map = document.getElementById('map')!.getBoundingClientRect()
      const drawer = document.getElementById('map-drawer')!.getBoundingClientRect()
      const marker = document.querySelector<SVGElement>('.timetable-stop-focus[data-stop-uid="C2"]')?.getBoundingClientRect()
      return {
        map: { left: map.left, top: map.top, right: map.right, bottom: map.bottom, width: map.width, height: map.height },
        drawer: { left: drawer.left, top: drawer.top, right: drawer.right, bottom: drawer.bottom, width: drawer.width, height: drawer.height },
        marker: marker ? { left: marker.left, top: marker.top, right: marker.right, bottom: marker.bottom } : null,
      }
    })
    if (!geometry.marker) return false
    const padding = calculateCameraPadding(geometry.map, geometry.drawer)
    const expectedX = (geometry.map.left + padding.paddingTopLeft[0] + geometry.map.right - padding.paddingBottomRight[0]) / 2
    const expectedY = (geometry.map.top + padding.paddingTopLeft[1] + geometry.map.bottom - padding.paddingBottomRight[1]) / 2
    const markerX = (geometry.marker.left + geometry.marker.right) / 2
    const markerY = (geometry.marker.top + geometry.marker.bottom) / 2
    return Math.abs(markerX - expectedX) <= 10 && Math.abs(markerY - expectedY) <= 10
  }).toBe(true)
  await expect(drawer.getByRole('tab', { name: '週六' })).toBeVisible()

  const geometry = await drawer.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return { right: rect.right, bottom: rect.bottom, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth }
  })
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth)
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight)
  expect(geometry.overflow).toBe(false)
})

test('hides service tabs when only one timetable group exists', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await mockRoute(page, 'single')
  await page.goto(`/map?city=ChiayiCounty&route=7211&variant=${encodeURIComponent(variant.variantKey)}`)

  const drawer = page.locator('#map-drawer')
  await drawer.getByRole('button', { name: '查看時刻表' }).click()
  await expect(drawer.locator('.timetable-tabs')).toHaveCount(0)
  await expect(drawer.locator('.timetable-overview span')).toHaveText('嘉義公園 · 每日')
  await expect(drawer.getByText('今天', { exact: true })).toHaveCount(0)
})

test('selects the next service day without adding another row when today has no trips', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await mockRoute(page, 'no-today')
  await page.goto(`/map?city=ChiayiCounty&route=7211&variant=${encodeURIComponent(variant.variantKey)}`)

  const drawer = page.locator('#map-drawer')
  await expect(drawer.locator('.route-service-summary')).toContainText('下一服務日 週六')
  await drawer.getByRole('button', { name: '查看時刻表' }).click()
  await expect(drawer.locator('.timetable-tab[aria-selected="true"]')).toHaveText('週六')
  await expect(drawer.locator('.timetable-overview span')).toHaveText('嘉義公園 · 今日無班次')
})

test('distinguishes past, next, and future departures without changing chip geometry', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-07-14T01:15:00Z'))
  await mockRoute(page, 'time-states')
  await page.goto(`/map?city=ChiayiCounty&route=7211&variant=${encodeURIComponent(variant.variantKey)}`)

  const drawer = page.locator('#map-drawer')
  await drawer.getByRole('button', { name: '查看時刻表' }).click()
  const past = drawer.locator('.timetable-minute.past')
  const next = drawer.locator('.timetable-minute.next')
  const future = drawer.locator('.timetable-minute.future')
  await expect(past).toHaveCount(1)
  await expect(next).toHaveCount(1)
  await expect(future).toHaveCount(1)
  await expect(past).toHaveAttribute('aria-label', '09:00，已過')
  await expect(next).toHaveAttribute('aria-label', '09:30，下一班')
  await expect(future).toHaveAttribute('aria-label', '10:00，尚未發車')
  const widths = await drawer.locator('.timetable-minute').evaluateAll((chips) => chips.map((chip) => chip.getBoundingClientRect().width))
  expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1)
})

test('keeps the timetable header fixed and uses the shared fade lifecycle', async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 480 })
  await mockRoute(page, 'long')
  await page.goto(`/map?city=ChiayiCounty&route=7211&variant=${encodeURIComponent(variant.variantKey)}`)

  const drawer = page.locator('#map-drawer')
  await drawer.getByRole('button', { name: '查看時刻表' }).click()
  await expect(drawer).toHaveAttribute('data-mode', 'timetable')
  const shell = drawer.locator(':scope > .drawer-scroll-shell')
  const region = shell.locator(':scope > .drawer-scroll-region')
  const fade = shell.locator(':scope > .drawer-scroll-fade')
  await expect(shell).toHaveCount(1)
  await expect(region.locator(':scope > .timetable-panel')).toHaveCount(1)
  await expect.poll(() => region.evaluate((element) => element.scrollHeight > element.clientHeight + 4)).toBe(true)
  await expect.poll(() => region.evaluate((element) => element.classList.contains('scrollable-below'))).toBe(true)
  await expect.poll(() => fade.evaluate((element) => Number(getComputedStyle(element).opacity))).toBe(1)

  const before = await drawer.evaluate((element) => ({
    backTop: element.querySelector('.drawer-back')!.getBoundingClientRect().top,
    headingTop: element.querySelector('.drawer-heading')!.getBoundingClientRect().top,
    outerClientHeight: element.clientHeight,
    outerScrollHeight: element.scrollHeight,
  }))
  await region.evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  await expect.poll(() => region.evaluate((element) => element.scrollTop > 0)).toBe(true)
  await expect.poll(() => region.evaluate((element) => element.classList.contains('scrollable-below'))).toBe(false)
  await expect.poll(() => fade.evaluate((element) => Number(getComputedStyle(element).opacity))).toBe(0)
  const after = await drawer.evaluate((element) => ({
    backTop: element.querySelector('.drawer-back')!.getBoundingClientRect().top,
    headingTop: element.querySelector('.drawer-heading')!.getBoundingClientRect().top,
  }))

  expect(before.outerScrollHeight).toBeLessThanOrEqual(before.outerClientHeight + 1)
  expect(Math.abs(after.backTop - before.backTop)).toBeLessThanOrEqual(1)
  expect(Math.abs(after.headingTop - before.headingTop)).toBeLessThanOrEqual(1)
})

test('does not show a scrollbar when a short route detail drawer already fits', async ({ page }) => {
  await page.setViewportSize({ width: 636, height: 381 })
  await mockRoute(page)
  await page.goto(`/map?city=ChiayiCounty&route=7211&variant=${encodeURIComponent(variant.variantKey)}`)

  const drawer = page.locator('#map-drawer')
  await expect(drawer.locator('.route-service-summary')).toContainText('首班 06:00 · 末班 22:00')
  await expect(drawer.locator(':scope > .drawer-scroll-shell')).toHaveCount(0)
  await expect(drawer.locator('.drawer-scroll-fade')).toHaveCount(0)
  const geometry = await drawer.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }))
  expect(geometry.scrollHeight).toBeLessThanOrEqual(geometry.clientHeight + 1)
})

test('drives service tabs from the keyboard with a single stop in the tab order', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await mockRoute(page)
  await page.goto(`/map?city=ChiayiCounty&route=7211&variant=${encodeURIComponent(variant.variantKey)}`)

  const drawer = page.locator('#map-drawer')
  await drawer.getByRole('button', { name: '查看時刻表' }).click()

  const tabs = drawer.locator('.timetable-tab')
  const panel = drawer.locator('.timetable-content')
  const range = drawer.locator('.timetable-overview strong')

  // tablist 只佔一個 Tab 停留點,群組內才用方向鍵。
  await expect(tabs.locator('[tabindex="0"]')).toHaveCount(0)
  await expect(drawer.locator('.timetable-tab[tabindex="0"]')).toHaveCount(1)
  await expect(drawer.locator('.timetable-tab[aria-selected="true"]')).toHaveText('每日')
  await expect(range).toHaveText('06:00–22:00')

  await expect(panel).toHaveAttribute('role', 'tabpanel')
  const panelId = await panel.getAttribute('id')
  await expect(drawer.locator('.timetable-tab').first()).toHaveAttribute('aria-controls', panelId!)
  await expect(panel).toHaveAttribute(
    'aria-labelledby',
    (await drawer.locator('.timetable-tab[aria-selected="true"]').getAttribute('id'))!,
  )

  // ArrowRight 從最後一個環繞回第一個,內容必須跟著換。
  await drawer.locator('.timetable-tab[aria-selected="true"]').focus()
  await page.keyboard.press('ArrowRight')
  await expect(drawer.locator('.timetable-tab[aria-selected="true"]')).toHaveText('週六')
  await expect(range).toHaveText('07:00–19:00')
  await expect(drawer.locator('.timetable-tab[tabindex="0"]')).toHaveCount(1)

  await page.keyboard.press('End')
  await expect(drawer.locator('.timetable-tab[aria-selected="true"]')).toHaveText('每日')
  await page.keyboard.press('Home')
  await expect(drawer.locator('.timetable-tab[aria-selected="true"]')).toHaveText('週六')
  await expect(range).toHaveText('07:00–19:00')
})
