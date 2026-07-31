import { expect, test } from './fixtures'

const board = {
  version: 2,
  id: 'visibility-board',
  title: '捷運景安站',
  city: 'NewTaipei',
  placeId: 'NWT:jing-an',
  buses: [{
    city: 'NewTaipei',
    routeName: '307',
    routeUid: 'NWT307',
    patternId: 'NWT307-0',
    stopName: '捷運景安站',
    stopUid: 'NWT1',
    direction: 0,
  }],
  createdAt: '2026-07-18T00:00:00.000Z',
  updatedAt: '2026-07-18T00:00:00.000Z',
}

test('visibility resume refreshes once and coalesces repeated visible events', async ({ page }) => {
  await page.addInitScript((savedBoard) => {
    localStorage.setItem('mochi.bus.boards.v2', JSON.stringify([savedBoard]))
    localStorage.setItem('mochi.bus.activeBoard.v2', savedBoard.id)
  }, board)

  let arrivalsCalls = 0
  let releaseForegroundRefresh: (() => void) | undefined
  await page.route('**/api/v1/map/place/*/arrivals?*', async (route) => {
    arrivalsCalls += 1
    if (arrivalsCalls === 2) {
      await new Promise<void>((resolve) => { releaseForegroundRefresh = resolve })
    }
    await route.fulfill({ json: { routes: [{
      routeName: '307', routeUid: 'NWT307', variantKey: 'NWT307-0', direction: 0,
      label: '往板橋', stopUid: 'NWT1', stopName: '捷運景安站',
      estimateSeconds: 300, etaLabel: '5 分', source: 'realtime',
    }] } })
  })

  await page.goto('/')
  await expect.poll(() => arrivalsCalls).toBe(1)
  await expect(page.getByRole('button', { name: '重新整理' })).toBeEnabled()

  await page.evaluate(() => {
    let hidden = true
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => hidden ? 'hidden' : 'visible',
    })
    ;(window as typeof window & { setMochiTestVisibility?: (value: boolean) => void }).setMochiTestVisibility = (value) => {
      hidden = value
      document.dispatchEvent(new Event('visibilitychange'))
    }
    document.dispatchEvent(new Event('visibilitychange'))
  })
  expect(arrivalsCalls).toBe(1)
  await page.evaluate(() => {
    ;(window as typeof window & { setMochiTestVisibility: (value: boolean) => void }).setMochiTestVisibility(false)
  })
  await expect.poll(() => arrivalsCalls).toBe(2)
  await expect(page.getByRole('button', { name: '更新中' })).toBeDisabled()

  await page.evaluate(() => {
    document.dispatchEvent(new Event('visibilitychange'))
    document.dispatchEvent(new Event('visibilitychange'))
  })
  expect(arrivalsCalls).toBe(2)
  releaseForegroundRefresh?.()
  await expect(page.getByRole('button', { name: '重新整理' })).toBeEnabled()

  await page.getByRole('button', { name: '重新整理' }).click()
  await expect.poll(() => arrivalsCalls).toBe(3)
})

const localBoard = {
  ...board,
  id: 'local-board',
  placeId: undefined,
  buses: [{ ...board.buses[0], directionLabel: '往板橋' }],
}

// 迴歸:refreshBoard 曾經用 refreshButton.disabled 當互斥鎖卻沒有 try/finally,
// 收尾階段(reconcile / persist / Intl 格式化)任何一處拋例外就讓按鈕永久 disabled,
// 之後每一輪定時器都在入口早退——首頁 ETA 從此不再更新,只能重整整頁才能恢復。
// 這裡用無效的 dataTime 讓 Intl.DateTimeFormat.format 丟 RangeError 重現該收尾例外。
test('a failing refresh surfaces the error and still runs the next scheduled round', async ({ page }) => {
  await page.clock.install()
  await page.addInitScript((savedBoard) => {
    localStorage.setItem('mochi.bus.boards.v2', JSON.stringify([savedBoard]))
    localStorage.setItem('mochi.bus.activeBoard.v2', savedBoard.id)
  }, localBoard)

  let etaCalls = 0
  await page.route('**/api/v1/eta*', async (route) => {
    etaCalls += 1
    await route.fulfill({ json: {
      label: '5 分', estimateSeconds: 300, source: 'realtime',
      dataTime: 'not-a-date', fetchedAt: 'not-a-date', stale: false,
    } })
  })

  await page.goto('/')
  await expect.poll(() => etaCalls).toBe(1)

  const refresh = page.getByRole('button', { name: '更新失敗' })
  // 自動更新是 quiet,但 quiet 只抑制成功回饋:失敗仍要看得見,
  // 否則卡死只是換成「靜默失敗」。
  await expect(refresh).toBeVisible()
  await expect(refresh).toBeEnabled()
  await expect(page.locator('#refresh-status')).toHaveText('更新失敗')

  await page.clock.runFor(1_200)
  await expect(page.getByRole('button', { name: '重新整理' })).toBeEnabled()
  await expect(page.locator('#refresh-status')).toBeEmpty()

  // 真正的迴歸斷言:下一輪定時器仍然跑得起來。
  await page.clock.runFor(30_000)
  await expect.poll(() => etaCalls).toBe(2)
})
