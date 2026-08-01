import {
  migrateBoards,
  persistHomeBoard,
  resolveHomeBoard,
  setActiveCity,
  type FavoriteBoard,
  type FavoriteBus,
} from '../boards/store'
import { createAsyncAction } from '../lib/async-action-state'
import { isTdxTokenRejectedError, requestMochiJson } from '../tdx/api-client'
import type { EtaSource } from '../../src/domain/eta-presentation'
import { createEtaRow, updateEtaRow, type EtaRowViewModel } from './eta-row-view'

type EtaBootstrap = {
  initialBoard: FavoriteBoard
  useLocalBoard: boolean
  tdxWarningMessages: Record<string, string>
}

type EtaData = {
  label?: string
  estimateSeconds?: number | null
  source?: EtaSource
  fetchedAt?: string
  dataTime?: string | null
  stale?: boolean
  warning?: string
}

type StopGroup = {
  direction: 0 | 1 | 2
  label: string
  subRouteUid?: string
  stops?: Array<{ stopUid: string; stopName: string; routeUid?: string; subRouteUid?: string }>
}

type PlaceRoute = {
  routeName: string
  variantKey: string
  direction: 0 | 1 | 2
  label: string
  routeUid: string
  subRouteUid?: string
  stopUid: string
  stopName: string
  estimateSeconds: number | null
  etaLabel: string
  source?: EtaSource
}

type RefreshResponse = {
  bus: FavoriteBus
  data?: EtaData
  failed?: boolean
  error?: unknown
}

type PlaceArrivalsLoad = {
  routes: PlaceRoute[] | null
  warning?: string
  error?: unknown
}

function requiredElement<T extends globalThis.Element>(selector: string): T {
  const element = document.querySelector(selector)
  if (!element) throw new Error(`ETA page is missing required element: ${selector}`)
  return element as T
}

function readBootstrap(): EtaBootstrap {
  const node = requiredElement<HTMLScriptElement>('#eta-bootstrap')
  const raw = node.textContent
  if (!raw) throw new Error('ETA bootstrap is empty')

  let value: unknown
  try {
    value = JSON.parse(raw) as unknown
  } catch {
    throw new Error('ETA bootstrap is not valid JSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('ETA bootstrap must be an object')
  }
  const record = value as Record<string, unknown>
  const initialBoard = record.initialBoard
  if (!initialBoard || typeof initialBoard !== 'object' || Array.isArray(initialBoard)) {
    throw new Error('ETA bootstrap initialBoard must be an object')
  }
  const buses = (initialBoard as Record<string, unknown>).buses
  if (!Array.isArray(buses)) throw new Error('ETA bootstrap initialBoard.buses must be an array')
  if (typeof record.useLocalBoard !== 'boolean') throw new Error('ETA bootstrap useLocalBoard must be a boolean')
  const warnings = record.tdxWarningMessages
  if (!warnings || typeof warnings !== 'object' || Array.isArray(warnings)) {
    throw new Error('ETA bootstrap tdxWarningMessages must be an object')
  }
  return {
    initialBoard: initialBoard as FavoriteBoard,
    useLocalBoard: record.useLocalBoard,
    tdxWarningMessages: warnings as Record<string, string>,
  }
}

const { initialBoard, useLocalBoard, tdxWarningMessages } = readBootstrap()
let currentBoard = initialBoard
// 示範模式:使用者沒有正式常用或地圖暫存封面時，顯示示範站牌且不寫入本機資料。
let demoBoard = false
const listNode = requiredElement<HTMLDivElement>('#bus-list')
const titleNode = requiredElement<HTMLHeadingElement>('#board-title')
const noticeNode = requiredElement<HTMLParagraphElement>('#notice')
const updatedNode = requiredElement<HTMLSpanElement>('#updated')
const refreshButton = requiredElement<HTMLButtonElement>('#refresh')
const refreshStatusNode = requiredElement<HTMLSpanElement>('#refresh-status')
const onboardNode = requiredElement<HTMLDivElement>('#onboard')
const onboardSignNode = requiredElement<HTMLDivElement>('#onboard-sign')
const mapLink = document.querySelector<HTMLAnchorElement>('.top-actions a')
if (!mapLink) throw new Error('ETA page is missing the map link')

function paramsFor(bus: FavoriteBus): URLSearchParams {
  const params = new URLSearchParams({ city: bus.city || currentBoard.city || '', route: bus.routeName, direction: String(bus.direction) })
  if (bus.stopName) params.set('stop', bus.stopName)
  if (bus.stopUid) params.set('stopUid', bus.stopUid)
  if (bus.routeUid) params.set('routeUid', bus.routeUid)
  if (bus.subRouteUid) params.set('subRouteUid', bus.subRouteUid)
  return params
}

function routeLink(bus: FavoriteBus): string {
  if (bus.stopName && bus.stopUid) return '/route?' + paramsFor(bus)
  return '#'
}

function makeRow(bus: FavoriteBus, data?: EtaData, failed = false): HTMLAnchorElement {
  return createEtaRow(etaRowViewModel(bus, data, failed))
}

function etaRowViewModel(bus: FavoriteBus, data?: EtaData, failed = false): EtaRowViewModel {
  return {
    key: paramsFor(bus).toString(),
    href: routeLink(bus),
    routeName: bus.routeName,
    directionLabel: bus.directionLabel,
    label: failed ? '暫無資料' : data?.label || '更新中',
    estimateSeconds: data?.estimateSeconds,
    source: failed ? 'none' : data?.source,
    stale: !failed && (data?.stale === true || data?.source === 'stale-realtime'),
  }
}

function reconcileRows(responses: RefreshResponse[]): void {
  const existingRows = new Map(
    Array.from(listNode.children)
      .filter((node): node is HTMLAnchorElement => node instanceof HTMLAnchorElement && Boolean(node.dataset.busKey))
      .map((row) => [row.dataset.busKey!, row]),
  )
  const rows = responses.map((item) => {
    const model = etaRowViewModel(item.bus, item.data, item.failed)
    const row = existingRows.get(model.key)
    if (!row) return createEtaRow(model)
    updateEtaRow(row, model)
    return row
  })
  listNode.replaceChildren(...rows)
}

async function fillDirectionLabel(bus: FavoriteBus): Promise<void> {
  if (bus.directionLabel) return
  try {
    const params = new URLSearchParams({ city: bus.city || '', route: bus.routeName })
    if (bus.routeUid) params.set('routeUid', bus.routeUid)
    const body = await requestMochiJson<{ groups?: StopGroup[] }>(
      '/api/v1/stops?' + params,
      {},
      { authenticated: true },
    )
    const group = body.groups?.find((candidate) =>
      candidate.direction === bus.direction
      && (!bus.subRouteUid || candidate.subRouteUid === bus.subRouteUid)
      && candidate.stops?.some((stop) => stop.stopUid === bus.stopUid))
    if (group?.label) bus.directionLabel = group.label
  } catch {}
}

let placeRoutesPromise: Promise<{ routes?: PlaceRoute[] }> | undefined
async function repairBusFromPlace(bus: FavoriteBus): Promise<boolean> {
  // 地圖舊收藏即使已有站牌，也要補齊 patternId，避免同路線變體誤配。
  if (bus.stopName && bus.stopUid && (!currentBoard.placeId || bus.patternId)) return true
  const city = bus.city || currentBoard.city
  if (!city) return false
  try {
    if (currentBoard.placeId) {
      // 失敗的 promise 不能快取,否則一次網路失敗會讓修復永遠癱瘓到重新整理為止。
      placeRoutesPromise ||= requestMochiJson<{ routes?: PlaceRoute[] }>(
        '/api/v1/map/place/' + encodeURIComponent(currentBoard.placeId) + '/routes?city=' + encodeURIComponent(city),
      )
        .catch((error: unknown) => { placeRoutesPromise = undefined; throw error })
      const body = await placeRoutesPromise
      const candidates = (body.routes || []).filter((route) =>
        route.routeName === bus.routeName
        && route.direction === bus.direction
        && (!bus.routeUid || route.routeUid === bus.routeUid)
        && (!bus.subRouteUid || !route.subRouteUid || route.subRouteUid === bus.subRouteUid)
        && (!bus.patternId || route.variantKey === bus.patternId))
      const labeled = bus.directionLabel
        ? candidates.filter((route) => route.label === bus.directionLabel)
        : candidates
      const match = labeled.length === 1 ? labeled[0] : undefined
      if (match) {
        bus.city = city
        bus.routeUid = match.routeUid
        bus.subRouteUid = match.subRouteUid
        bus.patternId = match.variantKey
        delete bus.identityStatus
        bus.stopName = match.stopName
        bus.stopUid = match.stopUid
        bus.directionLabel = match.label
        return true
      }
    }
    const params = new URLSearchParams({ city, route: bus.routeName })
    if (bus.routeUid) params.set('routeUid', bus.routeUid)
    const body = await requestMochiJson<{ groups?: StopGroup[] }>(
      '/api/v1/stops?' + params,
      {},
      { authenticated: true },
    )
    const groups = (body.groups || []).filter((group) =>
      group.direction === bus.direction
      && (!bus.directionLabel || group.label === bus.directionLabel))
    const matches = groups.flatMap((group) => (group.stops || [])
      .filter((stop) => stop.stopName === currentBoard.title)
      .map((stop) => ({ group, stop })))
    if (matches.length !== 1) return false
    bus.city = city
    bus.routeUid = matches[0].stop.routeUid || bus.routeUid
    bus.subRouteUid = matches[0].stop.subRouteUid || bus.subRouteUid
    delete bus.identityStatus
    bus.stopName = matches[0].stop.stopName
    bus.stopUid = matches[0].stop.stopUid
    bus.directionLabel = matches[0].group.label
    return true
  } catch { return false }
}

async function loadPlaceArrivals(): Promise<PlaceArrivalsLoad> {
  const city = currentBoard.city || currentBoard.buses[0]?.city
  if (!city || !currentBoard.placeId) return { routes: null }
  try {
    const params = new URLSearchParams({ city })
    const focus = currentBoard.buses[0]
    if (focus?.stopUid) params.set('focusStopUid', focus.stopUid)
    if (focus?.subRouteUid) params.set('focusSubRouteUid', focus.subRouteUid)
    if (focus && (focus.direction === 0 || focus.direction === 1 || focus.direction === 2)) {
      params.set('focusDirection', String(focus.direction))
    }
    const body = await requestMochiJson<{ routes?: PlaceRoute[]; warning?: string }>(
      '/api/v1/map/place/' + encodeURIComponent(currentBoard.placeId) + '/arrivals?' + params,
      { cache: 'no-store' },
      { authenticated: true },
    )
    return {
      routes: Array.isArray(body.routes) ? body.routes : null,
      warning: typeof body.warning === 'string' ? body.warning : undefined,
    }
  } catch (error) {
    return { routes: null, error }
  }
}

// #notice 是專屬 live region(見 src/ui.ts)。30 秒自動刷新每輪都清空再寫回同一句話,
// 會讓螢幕閱讀器每 30 秒重播一次相同的降級提示,因此內容沒變就不碰 DOM。
let renderedNotice: string | undefined = noticeNode.textContent?.trim() || undefined

function showRefreshNotice(message: string, includeSetup = false): void {
  const signature = `${includeSetup ? 'setup:' : ''}${message}`
  if (signature === renderedNotice) return
  renderedNotice = signature
  noticeNode.replaceChildren(document.createTextNode(message))
  if (!includeSetup) return
  noticeNode.appendChild(document.createTextNode(' '))
  const setup = document.createElement('a')
  setup.href = '/setup'
  setup.textContent = '檢查 TDX 設定'
  noticeNode.appendChild(setup)
}

function clearRefreshNotice(): void {
  if (renderedNotice === undefined) return
  renderedNotice = undefined
  noticeNode.replaceChildren()
}

// 互斥、按鈕文字、aria-busy 與宣告都由 refreshAction 負責:這個函式本身
// 只描述「刷新一次看板」要做的事,不再自己管狀態(見下方 refreshAction)。
async function refreshBoard(): Promise<void> {
  const placeLoad = await loadPlaceArrivals()
  const placeArrivals = placeLoad.routes
  const credentialError = isTdxTokenRejectedError(placeLoad.error) ? placeLoad.error : undefined
  const responses: RefreshResponse[] = credentialError
    ? currentBoard.buses.map((bus) => ({ bus, failed: true, error: credentialError }))
    : await Promise.all(currentBoard.buses.map(async (bus): Promise<RefreshResponse> => {
    const repaired = await repairBusFromPlace(bus)
    // 沒有站牌識別就不打 ETA,避免必然的 400。
    if (!repaired || (!bus.stopUid && !bus.stopName)) return { bus, failed: true }
    await fillDirectionLabel(bus)
    if (placeArrivals) {
      const arrival = placeArrivals.find((route) =>
        route.routeUid === bus.routeUid
        && route.stopUid === bus.stopUid
        && route.direction === bus.direction
        && (!bus.subRouteUid || !route.subRouteUid || route.subRouteUid === bus.subRouteUid)
        && (!bus.patternId || route.variantKey === bus.patternId))
      if (!arrival) return { bus, failed: true }
      return { bus, data: {
        label: arrival.etaLabel,
        estimateSeconds: arrival.estimateSeconds,
        source: arrival.source,
        fetchedAt: new Date().toISOString(),
        dataTime: null,
        stale: arrival.source === 'stale-realtime',
        warning: placeLoad.warning,
      }}
    }
    try {
      const body = await requestMochiJson<EtaData>(
        '/api/v1/eta?' + paramsFor(bus),
        { cache: 'no-store' },
        { authenticated: true },
      )
      return { bus, data: body }
    } catch (error) { return { bus, failed: true, error } }
  }))
  responses.sort((a, b) => {
    const aEta = typeof a.data?.estimateSeconds === 'number' ? a.data.estimateSeconds : Number.POSITIVE_INFINITY
    const bEta = typeof b.data?.estimateSeconds === 'number' ? b.data.estimateSeconds : Number.POSITIVE_INFINITY
    return aEta - bEta || a.bus.routeName.localeCompare(b.bus.routeName, 'zh-Hant', { numeric: true })
  })
  reconcileRows(responses)
  if (useLocalBoard && !demoBoard) persistHomeBoard(currentBoard)
  const fresh = responses.filter((item) => item.data).map((item) => item.data as EtaData)
  const rejected = credentialError ?? responses.find((item) => isTdxTokenRejectedError(item.error))?.error
  const tdxWarning = placeLoad.warning
    ?? ['tdx-quota', 'tdx-rate-limit', 'tdx-unavailable'].find((kind) => fresh.some((item) => item.warning === kind))
  if (isTdxTokenRejectedError(rejected)) showRefreshNotice(rejected.message, true)
  else if (tdxWarning) showRefreshNotice(tdxWarningMessages[tdxWarning] ?? 'TDX 即時資料目前無法更新。', true)
  else if (fresh.some((item) => item.stale)) showRefreshNotice('部分資料有些延遲，以現場站牌為準')
  else if (fresh.some((item) => item.source === 'schedule')) showRefreshNotice('部分依時刻表推估，實際到站可能略有出入')
  else clearRefreshNotice()
  updatedNode.textContent = fresh[0] ? '資料 ' + new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(fresh[0].dataTime || fresh[0].fetchedAt || Date.now())) : '暫時無法更新'
}

// 舊版用 refreshButton.disabled 當互斥鎖,但 refreshBoard 沒有 try/finally:
// reconcileRows、persistHomeBoard 或 Intl 格式化任何一處拋例外,按鈕就永久 disabled,
// 之後每一輪定時器與 visibilitychange 都在入口早退——首頁 ETA 從此不再更新,
// 只能重新整理整頁才能恢復。改由 createAsyncAction 保證 pending 一定會結束。
//
// aria-busy 掛在 #bus-list 而非按鈕:按鈕在 pending 期間是 disabled,
// 已經被移出 AT 的互動模型,真正在變動的是清單。
const refreshAction = createAsyncAction({
  button: refreshButton,
  labels: { idle: '重新整理', pending: '更新中', success: '已更新', error: '更新失敗' },
  announce: (message) => { refreshStatusNode.textContent = message },
  busyTarget: listNode,
})

// quiet:自動更新不播成功回饋。失敗仍會呈現,否則 renderer bug 會每 30 秒靜默失敗。
function refreshQuietly(): void {
  void refreshAction.run(refreshBoard, { quiet: true })
}

if (useLocalBoard) {
  // 顯示用方向文字可能因舊資料、API 降級或暫時缺欄位而不存在；
  // 缺少 directionLabel 不能證明看板損壞，更不能據此刪除使用者資料。
  const boards = migrateBoards()
  const resolved = resolveHomeBoard(boards)
  demoBoard = !resolved
  currentBoard = resolved ?? initialBoard
  if (demoBoard) {
    onboardNode.hidden = false
    onboardSignNode.hidden = false
  }
  titleNode.textContent = demoBoard ? '示範 · ' + currentBoard.title : currentBoard.title
  const firstBus = currentBoard.buses[0]
  const city = currentBoard.city || firstBus?.city
  // 示範看板的城市(config.ts 的預設值)不是使用者選的,不能寫進 activeCity——
  // 否則使用者從沒去過台北,打開地圖卻直接跳台北而不是台灣總覽。
  if (city && !demoBoard) {
    setActiveCity(city)
    const mapParams = new URLSearchParams({ city })
    if (currentBoard.placeId) mapParams.set('place', currentBoard.placeId)
    if (firstBus?.stopUid) mapParams.set('stopUid', firstBus.stopUid)
    mapLink.href = '/map?' + mapParams
  }
  if (currentBoard.id !== initialBoard.id || currentBoard.buses.length > 1 || firstBus?.stopUid !== initialBoard.buses[0].stopUid || firstBus?.routeName !== initialBoard.buses[0].routeName || firstBus?.direction !== initialBoard.buses[0].direction) {
    listNode.replaceChildren(...currentBoard.buses.map((bus) => makeRow(bus)))
  }
  refreshQuietly()
}
refreshButton.addEventListener('click', () => { void refreshAction.run(refreshBoard) })
setInterval(() => { if (!document.hidden) refreshQuietly() }, 30_000)
// 通勤時是「從口袋掏出來瞄一眼」:切回前景那一刻就要是最新的,不能等下一輪定時器。
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshQuietly() })
if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js')
