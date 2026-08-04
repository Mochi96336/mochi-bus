import { expect, test, type Page } from './fixtures'

async function mockSetupApi(page: Page, routeCount = 1) {
  await page.route('**/api/v1/routes?*', (route) => route.fulfill({ json: {
    routes: Array.from({ length: routeCount }, (_, index) => ({
      routeName: routeCount === 1 ? '307' : String(index + 1),
      category: '數字',
      routeUid: routeCount === 1 ? 'NWT307' : `NWT-${index + 1}`,
      departure: '板橋',
      destination: '撫遠街',
    })),
  } }))
  await page.route('**/api/v1/stops?*', (route) => route.fulfill({ json: {
    groups: [{
      label: '往板橋',
      subRouteName: '307',
      routeUid: 'NWT307',
      subRouteUid: 'NWT307-0',
      direction: 0,
      stops: [{ stopUid: 'NWT1', stopName: '捷運景安站', sequence: 1 }],
    }],
  } }))
  await page.route('**/api/v1/stop-routes?*', (route) => route.fulfill({ json: {
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
  } }))
}

type Viewport = { width: number; height: number }

async function openPickerFromScrolledPage(page: Page, viewport: Viewport): Promise<number> {
  await page.setViewportSize(viewport)
  await mockSetupApi(page)
  await page.goto('/setup')
  await page.locator('.advanced-panel').evaluate((details: HTMLDetailsElement) => { details.open = true })
  await page.evaluate(() => {
    history.scrollRestoration = 'auto'
    window.scrollTo(0, 120)
  })
  const scrollBeforeOpen = await page.evaluate(() => window.scrollY)
  expect(scrollBeforeOpen).toBeGreaterThan(0)

  await page.locator('#add-board-button').evaluate((button: HTMLButtonElement) => button.click())

  await expect(page.getByRole('dialog', { name: '新增常用站牌' })).toBeVisible()
  await expect(page.locator('.picker-modal-backdrop')).toBeVisible()
  await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains('picker-modal-open'))).toBe(true)
  await expect.poll(() => page.evaluate(() => document.body.classList.contains('picker-modal-open'))).toBe(true)
  await expect.poll(() => page.evaluate(() => history.scrollRestoration)).toBe('manual')

  return scrollBeforeOpen
}

async function expectPickerClosedAndRestored(page: Page, scrollBeforeOpen: number): Promise<void> {
  await expect(page).toHaveURL('/setup')
  await expect(page.getByRole('dialog', { name: '新增常用站牌' })).toBeHidden()
  await expect(page.locator('.picker-modal-backdrop')).toBeHidden()
  await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains('picker-modal-open'))).toBe(false)
  await expect.poll(() => page.evaluate(() => document.body.classList.contains('picker-modal-open'))).toBe(false)
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(scrollBeforeOpen)
  await expect.poll(() => page.evaluate(() => history.scrollRestoration)).toBe('auto')
  await expect(page.locator('#add-board-button')).toBeFocused()
}

test.describe('/setup favorite picker modal', () => {
  test('makes the blocked background explicit on a compact viewport', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await mockSetupApi(page)
    await page.goto('/setup')

    await page.locator('#add-board-button').evaluate((button: HTMLButtonElement) => button.click())

    const modal = page.getByRole('dialog', { name: '新增常用站牌' })
    const backdrop = page.locator('.picker-modal-backdrop')
    await expect(modal).toBeVisible()
    await expect(modal).toHaveAttribute('aria-modal', 'true')
    await expect(backdrop).toBeVisible()
    expect(await backdrop.evaluate((element) => element.parentElement === document.body)).toBe(true)
    await expect(page.locator('.picker-modal-subtitle')).toHaveText('第 1 步，共 3 步 · 先選路線')
    await expect(modal).toHaveCSS('position', 'fixed')
    await expect(modal).toHaveCSS('border-radius', '0px')
    await expect.poll(() => page.evaluate(() => document.body.classList.contains('picker-modal-open'))).toBe(true)

    const background = page.locator('main.setup-page > :not(#picker-panel)')
    expect(await background.count()).toBeGreaterThan(0)
    for (const node of await background.all()) await expect(node).toHaveAttribute('inert', '')
    await expect(modal).not.toHaveAttribute('inert', '')

    if (testInfo.project.name === 'mobile-touch') {
      expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true)
    }

    const bounds = await modal.boundingBox()
    expect(bounds).not.toBeNull()
    expect(bounds!.x).toBeLessThanOrEqual(1)
    expect(bounds!.y).toBeLessThanOrEqual(1)
    expect(bounds!.width).toBeGreaterThanOrEqual(389)
    expect(bounds!.height).toBeGreaterThanOrEqual(843)
  })

  const closePaths: Array<{
    name: string
    viewport: Viewport
    close: (page: Page) => Promise<void>
  }> = [
    {
      name: 'Cancel',
      viewport: { width: 390, height: 844 },
      close: async (page) => {
        await page.getByRole('button', { name: '取消', exact: true }).click()
      },
    },
    {
      name: 'Escape',
      viewport: { width: 390, height: 844 },
      close: async (page) => {
        await page.keyboard.press('Escape')
      },
    },
    {
      name: 'backdrop click',
      viewport: { width: 1100, height: 800 },
      close: async (page) => {
        await page.locator('.picker-modal-backdrop').click({ position: { x: 12, y: 12 } })
      },
    },
    {
      name: 'Browser Back',
      viewport: { width: 390, height: 844 },
      close: async (page) => {
        await page.goBack()
      },
    },
  ]

  for (const closePath of closePaths) {
    test(`restores page state after ${closePath.name}`, async ({ page }) => {
      const scrollBeforeOpen = await openPickerFromScrolledPage(page, closePath.viewport)

      await closePath.close(page)

      await expectPickerClosedAndRestored(page, scrollBeforeOpen)
    })
  }

  test('centers the desktop modal', async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 800 })
    await mockSetupApi(page)
    await page.goto('/setup')
    await page.click('#add-board-button')

    const modal = page.getByRole('dialog', { name: '新增常用站牌' })
    const backdrop = page.locator('.picker-modal-backdrop')
    await expect(modal).toBeVisible()
    await expect(backdrop).toBeVisible()
    await expect(modal).toHaveCSS('border-radius', '28px')
    await expect(modal).not.toHaveCSS('box-shadow', 'none')

    const bounds = await modal.boundingBox()
    expect(bounds).not.toBeNull()
    expect(Math.abs((bounds!.x + bounds!.width / 2) - 550)).toBeLessThan(2)
    expect(Math.abs((bounds!.y + bounds!.height / 2) - 400)).toBeLessThan(2)
  })

  test('keeps the modal heading aligned with the three picker steps', async ({ page }) => {
    await mockSetupApi(page)
    await page.goto('/setup')
    await page.click('#add-board-button')
    await expect(page.locator('.picker-modal-subtitle')).toHaveText('第 1 步，共 3 步 · 先選路線')

    await page.locator('.route-choice').first().click()
    await expect(page.locator('#direction-step .result-card')).toBeVisible()
    await expect(page.locator('.picker-modal-subtitle')).toHaveText('第 2 步，共 3 步 · 選擇方向與站牌')

    await page.getByRole('button', { name: '選這個站牌' }).click()
    await expect(page.locator('#suggestion-step .suggestion-list')).toBeVisible()
    await expect(page.locator('.picker-modal-subtitle')).toHaveText('第 3 步，共 3 步 · 確認同站公車')
  })

  test('keeps a long route catalogue as an internal scroller', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 700 })
    await mockSetupApi(page, 180)
    await page.goto('/setup')
    await page.click('#add-board-button')
    await page.locator('#city').selectOption('NewTaipei')
    await expect(page.locator('.route-choice')).toHaveCount(120)

    const grid = page.locator('#route-grid')
    const dimensions = await grid.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      overflowY: getComputedStyle(element).overflowY,
    }))
    expect(dimensions.overflowY).toBe('auto')
    expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight)

    await grid.evaluate((element) => { element.scrollTop = 320 })
    await expect.poll(() => grid.evaluate((element) => element.scrollTop)).toBeGreaterThan(100)
  })
})
