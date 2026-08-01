import { expect, test, type Page } from './fixtures'

async function mockSetupApi(page: Page, stopRoutesDelayMs = 0) {
  await page.route('**/api/v1/routes?*', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      routes: [{
        routeName: '307',
        category: '數字',
        routeUid: 'NWT307',
        departure: '板橋',
        destination: '撫遠街',
      }],
    }),
  }))
  await page.route('**/api/v1/stops?*', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      groups: [{
        label: '往板橋',
        subRouteName: '307',
        routeUid: 'NWT307',
        subRouteUid: 'NWT307-0',
        direction: 0,
        stops: [{ stopUid: 'NWT1', stopName: '捷運景安站', sequence: 1 }],
      }],
    }),
  }))
  await page.route('**/api/v1/stop-routes?*', async (route) => {
    if (stopRoutesDelayMs) await new Promise((resolve) => setTimeout(resolve, stopRoutesDelayMs))
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        place: {
          placeId: 'NWT:jing-an',
          name: '捷運景安站',
          latitude: 24.993,
          longitude: 121.505,
        },
        buses: [{
          city: 'NewTaipei',
          routeName: '918',
          routeUid: 'NWT918',
          stopName: '捷運景安站',
          stopUid: 'NWT1',
          direction: 0,
          label: '5 分',
        }],
      }),
    })
  })
}

test.describe('/setup page', () => {
  test('a legacy deep link without history state degrades to the requested city route picker', async ({ page }) => {
    await mockSetupApi(page)

    await page.goto('/setup?step=stops&city=NewTaipei&route=307')

    await expect(page).toHaveURL('/setup?step=routes&city=NewTaipei')
    await expect(page.locator('#city')).toHaveValue('NewTaipei')
    await expect(page.locator('#route-picker')).toBeVisible()
    await expect(page.locator('.route-choice').first()).toBeVisible()
  })

  test('a history quota failure keeps the current step usable and reloads through a compact fallback', async ({ page }) => {
    await mockSetupApi(page)
    await page.addInitScript(() => {
      const nativePushState = history.pushState.bind(history)
      history.pushState = ((state: unknown, unused: string, url?: string | URL | null) => {
        if (JSON.stringify(state).length > 250) throw new DOMException('state too large', 'DataCloneError')
        nativePushState(state, unused, url)
      }) as History['pushState']
    })

    await page.goto('/setup')
    await page.click('#add-board-button')
    await page.locator('#city').selectOption('NewTaipei')
    await page.locator('.route-choice').first().click()

    await expect(page.locator('#direction-step .result-card').first()).toBeVisible()
    await expect(page).toHaveURL(/step=stops/)
    await page.reload()
    await expect(page).toHaveURL('/setup?step=routes&city=NewTaipei')
    await expect(page.locator('#route-picker')).toBeVisible()
  })

  test('restores route scroll after Back even though the catalogue is refetched', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 700 })
    await mockSetupApi(page)
    await page.route('**/api/v1/routes?*', (route) => route.fulfill({ json: {
      routes: Array.from({ length: 180 }, (_, index) => ({
        routeName: String(index + 1), category: '數字', routeUid: `NWT-${index + 1}`,
      })),
    } }))

    await page.goto('/setup')
    await page.click('#add-board-button')
    await page.locator('#city').selectOption('NewTaipei')
    await expect(page.locator('.route-choice')).toHaveCount(120)
    const grid = page.locator('#route-grid')
    await grid.evaluate((element) => { element.scrollTop = 320 })
    await expect.poll(() => grid.evaluate((element) => element.scrollTop)).toBeGreaterThan(100)
    await page.locator('.route-choice').first().evaluate((button: HTMLButtonElement) => button.click())
    await expect(page).toHaveURL(/step=stops/)

    await page.goBack()
    await expect(page).toHaveURL(/step=routes/)
    await expect(page.locator('.route-choice')).toHaveCount(120)
    await expect.poll(() => grid.evaluate((element) => element.scrollTop)).toBeGreaterThan(100)
  })

  test('renders saved boards as one divided list and keeps the active state separate from actions', async ({ page }) => {
    const boards = [
      {
        version: 2,
        id: 'active-board',
        title: '捷運景安站',
        city: 'NewTaipei',
        buses: [{ city: 'NewTaipei', routeName: '307', routeUid: 'NWT307', patternId: 'NWT307-0', stopName: '捷運景安站', stopUid: 'NWT1', direction: 0 }],
        createdAt: '2026-07-17T00:00:00.000Z',
        updatedAt: '2026-07-17T00:00:00.000Z',
      },
      {
        version: 2,
        id: 'second-board',
        title: '秀朗橋北',
        city: 'NewTaipei',
        buses: [{ city: 'NewTaipei', routeName: '918', routeUid: 'NWT918', patternId: 'NWT918-0', stopName: '秀朗橋北', stopUid: 'NWT2', direction: 0 }],
        createdAt: '2026-07-17T00:00:00.000Z',
        updatedAt: '2026-07-17T00:00:00.000Z',
      },
    ]
    await page.addInitScript((savedBoards) => {
      localStorage.setItem('mochi.bus.appearance.v2', JSON.stringify({
        version: 2,
        general: 'light',
        mapUi: 'light',
        mapTiles: 'light',
      }))
      localStorage.setItem('mochi.bus.boards.v2', JSON.stringify(savedBoards))
      localStorage.setItem('mochi.bus.activeBoard.v2', savedBoards[0].id)
    }, boards)

    await page.goto('/setup')

    const rows = page.locator('.board-list > .board-item')
    await expect(rows).toHaveCount(2)
    await expect(rows.nth(0).locator('.board-status')).toHaveText('封面')
    await expect(rows.nth(0).getByRole('button', { name: '顯示在封面' })).toHaveCount(0)
    await expect(rows.nth(1).getByRole('button', { name: '顯示在封面' })).toBeVisible()
    await expect(rows.nth(0)).toHaveCSS('border-radius', '14px')
    await expect(rows.nth(0).locator('.favorite-stop-name')).toHaveCSS('font-size', '17px')
    await expect(rows.nth(0).locator('.favorite-route-number')).toHaveCSS('font-variant-numeric', 'tabular-nums')
    await expect(rows.nth(0).locator('.board-status')).toHaveCSS('border-radius', '5px')
    await expect(rows.nth(0).locator('.board-status')).toHaveCSS('color', 'rgb(155, 71, 53)')
    const deleteButton = rows.nth(0).getByRole('button', { name: '刪除' })
    await expect(deleteButton).toHaveCSS('color', 'rgb(107, 99, 89)')
    await deleteButton.hover()
    await expect(deleteButton).toHaveCSS('color', 'rgb(148, 62, 54)')

    await rows.nth(1).getByRole('button', { name: '顯示在封面' }).click()
    await expect(page.locator('.board-item[data-active="true"]')).toContainText('秀朗橋北')
    await expect(page.locator('.board-status')).toHaveCount(1)
  })

  test('golden path: pick a route, pick a stop, see suggestions', async ({ page }) => {
    await mockSetupApi(page)
    await page.goto('/setup')
    await expect(page.locator('#board-list')).toBeVisible()

    await page.click('#add-board-button')
    await page.waitForSelector('.route-choice')
    await expect(page).toHaveURL(/step=routes/)
    await page.getByLabel('快速篩選').fill('30')

    await page.locator('.route-choice').first().click()
    await page.waitForSelector('#direction-step .result-card')
    await expect(page).toHaveURL(/step=stops/)

    await page.goBack()
    await expect(page).toHaveURL(/step=routes/)
    await expect(page.getByLabel('快速篩選')).toHaveValue('30')
    await page.goForward()
    await expect(page.locator('#direction-step .result-card')).toBeVisible()

    await page.locator('#direction-step .result-card').first().locator('button.primary').click()
    await page.waitForSelector('#suggestion-step .sticky-save')
    await expect(page).toHaveURL(/step=suggestions/)

    await expect(page.locator('#suggestion-step .check-row')).not.toHaveCount(0)
    await page.getByRole('button', { name: '← 返回方向與站牌' }).click()
    await expect(page).toHaveURL(/step=stops/)
    await page.goForward()
    await expect(page.locator('#suggestion-step .sticky-save')).toBeVisible()
    await page.reload()
    await expect(page.locator('#suggestion-step .sticky-save')).toBeVisible()
    await page.goBack()
    await page.goBack()
    await expect(page).toHaveURL(/step=routes/)
    await expect(page.getByLabel('快速篩選')).toHaveValue('30')
  })

  test('setup and map favorites for the same stop share one homepage map entry', async ({ page }) => {
    await mockSetupApi(page)
    await page.route('**/api/v1/map/place/**', (route) => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ routes: [] }),
    }))

    await page.goto('/setup')
    await page.click('#add-board-button')
    await page.waitForSelector('.route-choice')
    await page.locator('#city').selectOption('NewTaipei')
    await page.waitForSelector('.route-choice')
    await page.locator('.route-choice').first().click()
    await page.waitForSelector('#direction-step .result-card')
    await page.locator('#direction-step .result-card').first().locator('button.primary').click()
    await page.waitForSelector('#suggestion-step .sticky-save')
    await page.locator('#suggestion-step .sticky-save').click()

    await expect(page).toHaveURL('/')
    await expect(page.locator('.top-actions a').first()).toHaveAttribute(
      'href',
      '/map?city=NewTaipei&place=NWT%3Ajing-an&stopUid=NWT1',
    )
    const setupMapHref = await page.locator('.top-actions a').first().getAttribute('href')
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('mochi.bus.boards.v2') || '[]'))
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({
      city: 'NewTaipei',
      placeId: 'NWT:jing-an',
      latitude: 24.993,
      longitude: 121.505,
    })

    const mapPlace = {
      placeId: 'NWT:jing-an',
      name: '捷運景安站',
      latitude: 24.993,
      longitude: 121.505,
      distanceMeters: 0,
    }
    await page.route('https://tile.openstreetmap.org/**', (route) => route.fulfill({ status: 204 }))
    await page.route('**/api/v1/map/cities', (route) => route.fulfill({ json: { cities: [{
      code: 'NewTaipei', name: '新北', region: 'north', center: [24.993, 121.505],
    }] } }))
    await page.route(/\/api\/v1\/map\/routes(?:\?|$)/, (route) => route.fulfill({ json: { routes: [] } }))
    await page.route(/\/api\/v1\/map\/place\/[^/]+\?city=NewTaipei$/, (route) => route.fulfill({
      json: { place: mapPlace },
    }))
    await page.route(/\/api\/v1\/map\/place\/[^/]+\/arrivals\?city=NewTaipei$/, (route) => route.fulfill({ json: {
      routes: [{
        routeName: '307',
        routeUid: 'NWT307',
        variantKey: 'NWT307-0',
        direction: 0,
        label: '往板橋',
        subRouteUid: 'NWT307-0',
        subRouteName: '307',
        stopUid: 'NWT1',
        stopName: '捷運景安站',
        stopSequence: 1,
        estimateSeconds: 300,
        etaLabel: '5 分',
        stopStatus: 0,
        source: 'realtime',
      }],
    } }))
    await page.evaluate(() => {
      localStorage.removeItem('mochi.bus.boards.v2')
      localStorage.removeItem('mochi.bus.activeBoard.v2')
    })

    await page.goto(setupMapHref!)
    await expect(page.locator('#map-drawer').getByRole('heading', { name: '捷運景安站' })).toBeVisible()
    await page.getByRole('button', { name: '將這個方向加入首頁' }).click()
    await page.goto('/')

    await expect(page.locator('.top-actions a').first()).toHaveAttribute('href', setupMapHref!)
    await page.locator('.top-actions a').first().click()
    await expect(page).toHaveURL(setupMapHref!)
    await expect(page.locator('#map-drawer').getByRole('heading', { name: '捷運景安站' })).toBeVisible()
  })

  test('duplicate route activation creates only one wizard history step', async ({ page }) => {
    await mockSetupApi(page)

    await page.goto('/setup')
    await page.click('#add-board-button')
    await page.waitForSelector('.route-choice')
    await page.locator('.route-choice').first().dblclick()
    await expect(page.locator('#direction-step .result-card')).toBeVisible()
    await expect(page).toHaveURL(/step=stops/)

    await page.goBack()
    await expect(page).toHaveURL(/step=routes/)
    await expect(page.locator('.route-choice')).toBeVisible()
    await page.goBack()
    await expect(page).toHaveURL('/setup')
    await expect(page.locator('#picker-panel')).toBeHidden()
  })

  // 回歸測試:hidePicker/backToRoutes 曾經只清 selectedRoute、不搶新 epoch,
  // 使用者在 loadSuggestions 的 stop-routes fetch 還沒回來前就關掉 picker,
  // fetch 回來後會用「沒有更新」的舊檢查通過,卻讀到已經被清空的
  // selectedRoute,炸出 TypeError。見 web/setup/main.ts 的 hidePicker/backToRoutes。
  test('closing the picker mid-flight does not throw when the delayed fetch resolves', async ({ page }) => {
    await mockSetupApi(page, 1500)

    await page.goto('/setup')
    await page.click('#add-board-button')
    await page.waitForSelector('.route-choice')
    await page.locator('.route-choice').first().click()
    await page.waitForSelector('#direction-step .result-card')
    await page.locator('#direction-step .result-card').first().locator('button.primary').click()
    await page.waitForSelector('#suggestion-step p')

    // 故意在延遲的 fetch 還沒回來時關閉 picker。
    await page.click('#close-picker')
    await page.waitForTimeout(2200)
  })

  test('Escape closes the picker and returns focus to the trigger button (A11Y-001)', async ({ page }) => {
    await page.goto('/setup')
    await page.click('#add-board-button')
    await expect(page.locator('#picker-panel')).toBeVisible()
    await expect(page.locator('#city')).toBeFocused()

    await page.keyboard.press('Escape')

    await expect(page.locator('#picker-panel')).toBeHidden()
    await expect(page.locator('#add-board-button')).toBeFocused()
  })
})

test.describe('/setup picker focus boundary', () => {
  test('makes the background inert so Tab cannot leave the picker (A11Y-002)', async ({ page }) => {
    await page.goto('/setup')
    await page.click('#add-board-button')
    await expect(page.locator('#picker-panel')).toBeVisible()

    // 背景真的退出 Tab 序,才不必自己寫 focus trap。
    const background = page.locator('main.setup-page > :not(#picker-panel)')
    expect(await background.count()).toBeGreaterThan(0)
    for (const node of await background.all()) await expect(node).toHaveAttribute('inert', '')
    await expect(page.locator('#picker-panel')).not.toHaveAttribute('inert', '')

    // inert 的語意不是 focus trap:Tab 走到文件尾端仍會經過 body 再繞回來。
    // 要保證的是焦點永遠不會落在背景的任何一個控制上。
    for (let step = 0; step < 14; step += 1) {
      await page.keyboard.press('Tab')
      const landedInBackground = await page.evaluate(() => {
        const active = document.activeElement
        if (!active || active === document.body || active === document.documentElement) return false
        return !document.getElementById('picker-panel')?.contains(active)
      })
      expect(landedInBackground).toBe(false)
    }
  })

  test('lifts inert before returning focus to the trigger', async ({ page }) => {
    await page.goto('/setup')
    await page.click('#add-board-button')
    await page.keyboard.press('Escape')

    await expect(page.locator('#add-board-button')).toBeFocused()
    for (const node of await page.locator('main.setup-page > :not(#picker-panel)').all()) {
      await expect(node).not.toHaveAttribute('inert', '')
    }
  })
})
