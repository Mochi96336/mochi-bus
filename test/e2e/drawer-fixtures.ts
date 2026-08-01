// 抽屜尺寸/動線 spec 共用的鷹架。這些 spec 是一次修一個抽屜 bug 長出來的,每一個
// 都自帶一份 mock 與 helper;真正因 spec 而異的只有「路線清單長什麼樣」與「哪一個
// 回應要被扣住」,其餘完全相同。共用的部分集中在這裡,差異留在各自的 spec 裡。
import type { Route } from '@playwright/test'
import { expect, type Page } from './fixtures'

export const tainan = { code: 'Tainan', name: '臺南', region: 'south', center: [22.997, 120.212] }

/** 全路網 spec 的主角路線,同時也是站牌到站列表的那一筆。 */
export const routeEntry = {
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

export const place = {
  placeId: 'P1',
  name: '臺南火車站',
  latitude: 22.997,
  longitude: 120.212,
  distanceMeters: 76,
}

export const emptyTimetable = {
  mode: 'none',
  selectedStop: null,
  departureStop: null,
  stops: [],
  timedStopCount: 0,
  services: [],
}

export function deferred() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

export async function fulfillAfter(route: Route, gate: Promise<void>, json: unknown) {
  await gate
  try {
    await route.fulfill({ json })
  } catch {
    // A newer navigation may abort a delayed request; a closed route is expected in that case.
  }
}

/** 圖磚、城市清單、車輛與時刻表——每個抽屜 spec 都需要、但沒有一個在驗證的東西。 */
export async function mockMapShell(page: Page, timetable: unknown = emptyTimetable) {
  await page.route('https://tile.openstreetmap.org/**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/v1/map/cities', (route) => route.fulfill({ json: { cities: [tainan] } }))
  await page.route('**/api/v1/map/vehicles*', (route) => route.fulfill({ json: { vehicles: [] } }))
  await page.route('**/api/v1/map/timetable*', (route) => route.fulfill({ json: { timetable } }))
}

export async function mockRouteCatalogue(page: Page, routeNames: readonly string[]) {
  await page.route(/\/api\/v1\/map\/routes(?:\?|$)/, (route) => route.fulfill({
    json: {
      routes: routeNames.map((routeName, index) => ({
        routeName,
        category: index % 4 === 0 ? '幹線' : '數字',
      })),
    },
  }))
}

/** routeEntry 打頭的目錄,其餘補足數量用——用來把目錄撐到會捲動。 */
export function trunkRouteNames(count = 80): string[] {
  return Array.from(
    { length: count },
    (_, index) => (index === 0 ? routeEntry.routeName : `測試路線 ${index + 1}`),
  )
}

/** 0右 打頭的數字路線目錄。 */
export function numberedRouteNames(count: number, ...leading: string[]): string[] {
  return [...leading, ...Array.from({ length: count }, (_, index) => String(index + 1))]
}

/**
 * routeEntry 的單站牌變體,給全路網那組 spec 用。
 */
export function trunkVariant() {
  return {
    variantKey: routeEntry.variantKey,
    routeName: routeEntry.routeName,
    routeUid: routeEntry.routeUid,
    subRouteUid: routeEntry.subRouteUid,
    direction: routeEntry.direction,
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

/**
 * 臺南火車站 → 永康火車站 的兩站牌變體。
 *
 * subRouteName 是明講的參數而不是從 routeName 推出來的:route-detail-surface 只在它
 * 與 routeName 不同時才多畫一行,而那一行會改變 compact 抽屜的高度。量高度的 spec
 * 對這件事敏感,所以哪一種行為是有意的必須寫在呼叫端。
 */
export function twoStopVariant(routeName: string, index = 0, subRouteName = routeName) {
  return {
    variantKey: `${routeName}:${index}`,
    routeName,
    routeUid: `TNN-${routeName}`,
    direction: (index % 2 === 0 ? 0 : 1) as 0 | 1,
    label: index % 2 === 0 ? '臺南火車站 → 永康火車站' : '永康火車站 → 臺南火車站',
    subRouteName,
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

/**
 * 一幀抽屜狀態。幾何、dataset 與標題文字都原樣記錄,不在頁面內做任何分類——
 * 「這一幀算哪個階段」是各 spec 自己的判斷,留在 Node 端當純函式比較好讀也好改。
 */
export type DrawerFrame = {
  top: number
  height: number
  maxHeight: number
  overflowY: string
  view: string
  mode: string
  size: string
  heading: string
  description: string
  hasPlaceRows: boolean
  hasLoadingRows: boolean
  hasVariantList: boolean
}

/**
 * 開始逐幀取樣抽屜。停止前每個 requestAnimationFrame 記一筆。
 *
 * 第一幀同步取,不等 rAF:否則呼叫端「開始取樣 → 放行回應」之間若沒撐過一次繪製,
 * 起始狀態就漏掉了,取樣結果會看起來像從未發生過變化。
 */
export async function startDrawerCapture(page: Page) {
  await page.evaluate(() => {
    type Frame = Record<string, unknown>
    type Store = { active: boolean; frames: Frame[] }
    const store: Store = { active: true, frames: [] }
    ;(window as Window & { __drawerCapture?: Store }).__drawerCapture = store
    const drawer = document.getElementById('map-drawer')!

    const sample = () => {
      if (!store.active) return
      const rect = drawer.getBoundingClientRect()
      const style = getComputedStyle(drawer)
      store.frames.push({
        top: rect.top,
        height: rect.height,
        maxHeight: Number.parseFloat(style.maxHeight),
        overflowY: style.overflowY,
        view: drawer.dataset.view ?? '',
        mode: drawer.dataset.mode ?? '',
        size: drawer.dataset.size ?? '',
        heading: drawer.querySelector<HTMLElement>('.drawer-heading h1')?.textContent ?? '',
        description: drawer.querySelector<HTMLElement>('.drawer-heading p')?.textContent ?? '',
        hasPlaceRows: drawer.querySelector('.place-route-row') !== null,
        hasLoadingRows: drawer.querySelector('.map-loading-row') !== null,
        hasVariantList: drawer.querySelector('.variant-list') !== null,
      })
      window.requestAnimationFrame(sample)
    }

    sample()
  })
}

export async function stopDrawerCapture(page: Page): Promise<DrawerFrame[]> {
  return page.evaluate(() => {
    type Store = { active: boolean; frames: unknown[] }
    const store = (window as Window & { __drawerCapture?: Store }).__drawerCapture!
    store.active = false
    return store.frames
  }) as Promise<DrawerFrame[]>
}

export async function openNetwork(page: Page) {
  const network = page.getByRole('button', { name: '切換全路網與全部站點' })
  await network.click()
  await expect(network).toHaveAttribute('aria-pressed', 'true')
  await expect(network).not.toHaveAttribute('aria-busy')
}

// focusPoint places the city center in the drawer-aware visible stage. These offsets mirror
// the desktop camera padding constants: left 45, top 90, bottom 45, safety gap 48.
export async function clickDesktopStageCenter(page: Page) {
  const mapBox = await page.locator('#map').boundingBox()
  const drawerBox = await page.locator('#map-drawer').boundingBox()
  if (!mapBox || !drawerBox) throw new Error('map stage has no layout box')
  const targetX = mapBox.x + (drawerBox.x - mapBox.x + 45 - 48) / 2
  const targetY = mapBox.y + mapBox.height / 2 + (90 - 45) / 2
  await page.mouse.click(targetX, targetY)
}
