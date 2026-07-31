import {
  activeBoardId,
  busKey,
  clearLocalData,
  clearTdxAuth,
  consumeTdxAuthMigrationNotice,
  getTdxAuthState,
  migrateBoards,
  newBoardId,
  setActiveBoard,
  setTdxAuth,
  syncActiveBoard,
  writeBoards,
  type FavoriteBoard,
  type FavoriteBus,
} from '../boards/store'
import { requestMochiJson } from '../tdx/api-client'
import { clearTdxAccessTokenCache, verifyTdxCredentials } from '../tdx/client'
import { attachScrollFade } from '../lib/scroll-fade'
import { createAsyncAction } from '../lib/async-action-state'

type RouteItem = {
  routeName: string
  category?: string
  routeUid?: string
  departure?: string
  destination?: string
}

type DirectionGroup = {
  label: string
  subRouteName: string
  routeUid?: string
  subRouteUid?: string
  direction: 0 | 1 | 2
  stops: Array<{ stopUid: string; stopName: string; sequence: number }>
}

type SuggestionBus = FavoriteBus & { label?: string }

type StopPlaceIdentity = {
  placeId: string
  name: string
  latitude: number
  longitude: number
}

type SuggestionSnapshot = {
  stopName: string
  items: SuggestionBus[]
  selectedKey: string
  frequency: Record<string, number>
  place?: StopPlaceIdentity
}

type SetupHistoryState = {
  setupVersion: 1
  savedAt: number
  setupStep: 'closed' | 'routes' | 'stops' | 'suggestions'
  setupDepth: number
  city?: string
  filter?: string
  category?: string
  scrollTop?: number
  routes?: RouteItem[]
  selectedRoute?: RouteItem
  groups?: DirectionGroup[]
  suggestion?: SuggestionSnapshot
}

// Cloudflare Workers 的 HTMLRewriter 型別也叫 Element,兩者的全域宣告會合併,
// 汙染 DOM 的 Element 介面;query 一律用 cast 而不是 querySelector<T> 泛型,
// 跟既有的 web/map/main.ts 同一個做法,避開這個環境層級的型別衝突。
const city = document.querySelector('#city') as unknown as HTMLSelectElement
const filter = document.querySelector('#route-filter') as HTMLInputElement
const grid = document.querySelector('#route-grid') as HTMLDivElement
attachScrollFade(grid)
const categories = document.querySelector('#categories') as HTMLDivElement
const message = document.querySelector('#message') as HTMLParagraphElement
const directionStep = document.querySelector('#direction-step') as HTMLDivElement
const suggestionStep = document.querySelector('#suggestion-step') as HTMLDivElement
const boardList = document.querySelector('#board-list') as HTMLDivElement
const pickerPanel = document.querySelector('#picker-panel') as HTMLElement
const routePicker = document.querySelector('#route-picker') as HTMLDivElement
const addBoardButton = document.querySelector('#add-board-button') as HTMLButtonElement
const closePicker = document.querySelector('#close-picker') as HTMLButtonElement

let routes: RouteItem[] = []
let category = '全部'
let selectedRoute: RouteItem | null = null
let directionGroups: DirectionGroup[] = []
let suggestionSnapshot: SuggestionSnapshot | undefined
let pendingRouteScrollTop: number | undefined
// 快速連續操作(換城市、連點路線)時,慢的舊回應不能蓋掉快的新結果;
// 三段(路線/站牌/建議)共用一個 epoch,跟 web/map/main.ts 的 nav-request 同一套想法。
let requestId = 0

const boards = () => migrateBoards()

function saveBoards(value: FavoriteBoard[]) {
  writeBoards(value)
  renderBoards()
}

function showInlineUndo(card: HTMLElement, board: FavoriteBoard, index: number, wasActive: boolean) {
  card.classList.add('deleted')
  const text = document.createElement('span')
  text.textContent = '已刪除 ' + board.title
  const undo = document.createElement('button')
  undo.className = 'inline-undo'
  undo.textContent = '復原'
  card.replaceChildren(text, undo)
  const timer = setTimeout(() => {
    card.classList.add('collapsing')
    setTimeout(renderBoards, 260)
  }, 5000)
  undo.onclick = () => {
    clearTimeout(timer)
    const value = boards()
    if (!value.some((x) => x.id === board.id)) value.splice(Math.min(index, value.length), 0, board)
    writeBoards(value)
    if (wasActive) setActiveBoard(board.id)
    card.classList.add('restoring')
    setTimeout(renderBoards, 180)
  }
}

function renderBoards() {
  const value = boards()
  const active = activeBoardId()
  boardList.replaceChildren()
  boardList.classList.toggle('has-boards', value.length > 0)
  addBoardButton.classList.toggle('empty-state', value.length === 0)
  if (!value.length) {
    boardList.innerHTML = '<p class="empty">這裡還空著，加一塊常用站牌吧。</p>'
    return
  }
  value.forEach((board, index) => {
    const card = document.createElement('article')
    card.className = 'board-item'
    card.dataset.active = String(board.id === active)
    const copy = document.createElement('div')
    copy.className = 'board-copy'
    const titleLine = document.createElement('div')
    titleLine.className = 'board-title-line'
    const title = document.createElement('strong')
    title.className = 'favorite-stop-name'
    title.textContent = board.title
    titleLine.appendChild(title)
    if (board.id === active) {
      const status = document.createElement('span')
      status.className = 'board-status'
      status.textContent = '封面'
      titleLine.appendChild(status)
    }
    const detail = document.createElement('div')
    detail.className = 'board-route-chips'
    const ambiguous = board.buses.some((bus) => bus.identityStatus === 'legacy-ambiguous')
    for (const routeName of new Set(board.buses.map((bus) => bus.routeName))) {
      const chip = document.createElement('span')
      chip.className = 'favorite-route-number'
      chip.textContent = routeName
      detail.appendChild(chip)
    }
    if (ambiguous) {
      const note = document.createElement('span')
      note.className = 'route-chip-note'
      note.textContent = '需重新選擇路線'
      detail.appendChild(note)
    }
    copy.replaceChildren(titleLine, detail)
    const actions = document.createElement('div')
    actions.className = 'item-actions'
    if (board.id !== active) {
      const show = document.createElement('button')
      show.className = 'board-cover-action'
      show.textContent = '顯示在封面'
      show.onclick = () => {
        setActiveBoard(board.id)
        renderBoards()
      }
      actions.appendChild(show)
    }
    const remove = document.createElement('button')
    remove.className = 'board-delete-action'
    remove.textContent = '刪除'
    remove.onclick = () => {
      const current = boards()
      const wasActive = board.id === activeBoardId()
      const next = current.filter((x) => x.id !== board.id)
      writeBoards(next)
      if (wasActive) syncActiveBoard(next)
      showInlineUndo(card, board, index, wasActive)
    }
    actions.appendChild(remove)
    card.replaceChildren(copy, actions)
    boardList.appendChild(card)
  })
}

function openPicker() {
  if (setupHistoryState().setupStep === 'closed') {
    pushSetupState(routeHistoryState(1), setupUrl('routes'))
  }
  showRoutePicker()
}

function showRoutePicker() {
  pickerPanel.hidden = false
  routePicker.hidden = false
  directionStep.hidden = true
  suggestionStep.hidden = true
  pickerPanel.scrollIntoView({ behavior: 'smooth', block: 'start' })
  // Esc 關閉、焦點還回觸發它的按鈕,picker 展開時是整頁唯一可互動的區塊,
  // 行為上等同 modal。
  city.focus()
  if (!routes.length) void loadRoutes()
}

function hidePicker() {
  const state = setupHistoryState()
  if (state.setupDepth > 0) {
    history.go(-state.setupDepth)
    return
  }
  hidePickerView()
}

function hidePickerView(focusTrigger = true) {
  pickerPanel.hidden = true
  selectedRoute = null
  if (focusTrigger) addBoardButton.focus()
  // 清掉 selectedRoute 的同時要搶新 epoch:不這樣做,還在等 fetch 的
  // chooseRoute/loadSuggestions 回來後會通過「沒有更新」的檢查,
  // 卻讀到剛被清空的 selectedRoute 而炸掉。
  requestId += 1
}

function backToRoutes() {
  if (setupHistoryState().setupStep === 'stops') {
    history.back()
    return
  }
  directionStep.hidden = true
  suggestionStep.hidden = true
  routePicker.hidden = false
  selectedRoute = null
  requestId += 1
  routePicker.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function backToStops() {
  if (setupHistoryState().setupStep === 'suggestions') {
    history.back()
    return
  }
  suggestionStep.hidden = true
  directionStep.hidden = false
  directionStep.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function categoryOf(item: RouteItem): string {
  if (item.category) return item.category
  if ((item.routeUid || '').startsWith('THB')) return '公路客運'
  const name = item.routeName || ''
  const first = name.charAt(0)
  if (name.includes('台灣好行') || name.includes('觀光')) return '觀光'
  if (name.includes('幸福') || name.includes('樂活') || name.includes('社區')) return '幸福／社區'
  if (name.includes('小黃')) return '小黃'
  if (name.includes('幹線')) return '幹線'
  if ('紅藍綠棕橘黃小F'.includes(first)) return '接駁'
  if ('0123456789０１２３４５６７８９'.includes(first)) return '數字'
  return '其他'
}

function renderCategories() {
  const order = ['數字', '幹線', '接駁', '幸福／社區', '觀光', '小黃', '公路客運', '其他']
  const counts: Record<string, number> = {}
  routes.forEach((item) => {
    const name = categoryOf(item)
    counts[name] = (counts[name] || 0) + 1
  })
  const names = ['全部', ...order.filter((name) => counts[name])]
  if (!names.includes(category)) category = '全部'
  categories.replaceChildren(...names.map((name) => {
    const button = document.createElement('button')
    button.className = 'chip' + (name === category ? ' active' : '')
    button.textContent = name === '全部' ? '全部 ' + routes.length : name + ' ' + counts[name]
    button.onclick = () => {
      category = name
      renderCategories()
      renderRoutes()
      saveRouteHistoryState()
    }
    return button
  }))
}

function renderRoutes() {
  const query = filter.value.trim().toLowerCase()
  const visible = routes
    .filter((item) => (category === '全部' || categoryOf(item) === category)
      && (!query || item.routeName.toLowerCase().includes(query)))
    .slice(0, 120)
  grid.replaceChildren(...visible.map((item) => {
    const button = document.createElement('button')
    button.className = 'route-choice'
    // 編號當主角、起迄站當第二行小字:塞在同一行會在窄格子裡折成三四行,沒辦法掃視。
    const name = document.createElement('b')
    name.textContent = item.routeName
    button.appendChild(name)
    if (item.departure && item.destination) {
      const path = document.createElement('small')
      path.textContent = item.departure + ' → ' + item.destination
      button.appendChild(path)
      button.title = item.routeName + ' · ' + item.departure + ' → ' + item.destination
    }
    button.onclick = () => void chooseRoute(item)
    return button
  }))
  message.textContent = visible.length ? '' : '沒有符合的路線'
}

async function loadRoutes() {
  grid.replaceChildren()
  message.textContent = '正在載入路線…'
  directionStep.hidden = true
  suggestionStep.hidden = true
  const id = ++requestId
  try {
    const body = await requestMochiJson<{ routes?: RouteItem[] }>(
      '/api/v1/routes?schema=2&city=' + encodeURIComponent(city.value),
      { cache: 'no-store' },
      { authenticated: true, fallback: '路線載入失敗' },
    )
    if (id !== requestId) return
    routes = body.routes ?? []
    message.textContent = '共 ' + routes.length + ' 條路線'
    renderCategories()
    renderRoutes()
    if (pendingRouteScrollTop !== undefined) {
      const scrollTop = pendingRouteScrollTop
      pendingRouteScrollTop = undefined
      queueMicrotask(() => {
        grid.scrollTop = scrollTop
        saveRouteHistoryState()
      })
    } else {
      saveRouteHistoryState()
    }
  } catch (error) {
    if (id !== requestId) return
    message.textContent = error instanceof Error && error.message ? error.message : '路線載入失敗'
  }
}

async function chooseRoute(route: RouteItem) {
  saveRouteHistoryState()
  selectedRoute = route
  message.textContent = '正在載入 ' + route.routeName + ' 的站牌…'
  directionStep.hidden = true
  suggestionStep.hidden = true
  const id = ++requestId
  const params = new URLSearchParams({ city: city.value, route: route.routeName })
  if (route.routeUid) params.set('routeUid', route.routeUid)
  try {
    const body = await requestMochiJson<{ groups?: DirectionGroup[] }>(
      '/api/v1/stops?' + params,
      {},
      { authenticated: true, fallback: '站牌載入失敗' },
    )
    if (id !== requestId) return
    routePicker.hidden = true
    renderDirections(body.groups ?? [])
    pushSetupState({
      ...routeHistoryState(2),
      setupStep: 'stops',
      setupDepth: 2,
      selectedRoute: route,
      groups: body.groups ?? [],
    } satisfies SetupHistoryState, setupUrl('stops', route))
  } catch (error) {
    if (id !== requestId) return
    message.textContent = error instanceof Error && error.message ? error.message : '站牌載入失敗'
  }
}

function renderDirections(groups: DirectionGroup[]) {
  directionGroups = groups
  directionStep.replaceChildren()
  const head = document.createElement('div')
  head.className = 'step-head'
  const back = document.createElement('button')
  back.className = 'back-button'
  back.textContent = '← 返回路線'
  back.onclick = backToRoutes
  const title = document.createElement('strong')
  title.textContent = '已選路線 ' + selectedRoute!.routeName
  head.replaceChildren(back, title)
  directionStep.appendChild(head)
  groups.forEach((group) => {
    const card = document.createElement('article')
    card.className = 'result-card'
    const heading = document.createElement('h2')
    heading.textContent = group.label
    const meta = document.createElement('p')
    meta.textContent = group.subRouteName
    const select = document.createElement('select')
    group.stops.forEach((stop) => {
      const option = document.createElement('option')
      option.value = stop.stopUid
      option.textContent = stop.sequence + '. ' + stop.stopName
      select.appendChild(option)
    })
    const button = document.createElement('button')
    button.className = 'primary'
    button.textContent = '選這個站牌'
    button.onclick = () => {
      const stop = group.stops.find((candidate) => candidate.stopUid === select.value)
      if (stop) void loadSuggestions(group, stop)
    }
    card.replaceChildren(heading, meta, select, button)
    directionStep.appendChild(card)
  })
  directionStep.hidden = false
  directionStep.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function etaRank(label?: string): number {
  if (!label) return 9999
  if (label.includes('即將')) return 0
  const value = Number.parseInt(label, 10)
  return Number.isFinite(value) ? value : 9998
}

async function loadSuggestions(group: DirectionGroup, stop: DirectionGroup['stops'][number]) {
  directionStep.hidden = true
  suggestionStep.hidden = false
  suggestionStep.innerHTML = '<p>正在找同站其他公車…</p>'
  const id = ++requestId
  let suggestions: SuggestionBus[] = []
  let place: StopPlaceIdentity | undefined
  try {
    const params = new URLSearchParams({ city: city.value, stop: stop.stopName, stopUid: stop.stopUid })
    const body = await requestMochiJson<{ buses?: SuggestionBus[]; place?: StopPlaceIdentity | null }>(
      '/api/v1/stop-routes?' + params,
      {},
      { authenticated: true },
    )
    suggestions = body.buses ?? []
    place = body.place ?? undefined
  } catch {
    // 同站其他公車只是加分項,失敗就只留目前選擇的那一班。
  }
  if (id !== requestId) return
  const selected: SuggestionBus = {
    city: city.value,
    routeName: selectedRoute!.routeName,
    routeUid: group.routeUid,
    subRouteUid: group.subRouteUid,
    stopName: stop.stopName,
    stopUid: stop.stopUid,
    direction: group.direction,
    directionLabel: group.label,
  }
  const selectedKey = busKey(selected)
  const frequency: Record<string, number> = {}
  boards().flatMap((board) => board.buses).forEach((bus) => {
    const key = bus.routeUid || bus.routeName
    frequency[key] = (frequency[key] || 0) + 1
  })
  const all = [selected, ...suggestions]
    .filter((bus, index, array) => array.findIndex((other) => busKey(other) === busKey(bus)) === index)
    .sort((a, b) => {
      const selectedDiff = Number(busKey(b) === selectedKey) - Number(busKey(a) === selectedKey)
      if (selectedDiff) return selectedDiff
      const frequentDiff = (frequency[b.routeUid || b.routeName] || 0) - (frequency[a.routeUid || a.routeName] || 0)
      if (frequentDiff) return frequentDiff
      const etaDiff = etaRank(a.label) - etaRank(b.label)
      return etaDiff || a.routeName.localeCompare(b.routeName, 'zh-Hant', { numeric: true })
    })
    .slice(0, 12)
  renderSuggestions(stop.stopName, all, selectedKey, frequency, place)
  suggestionSnapshot = { stopName: stop.stopName, items: all, selectedKey, frequency, place }
  pushSetupState({
    ...routeHistoryState(3),
    setupStep: 'suggestions',
    setupDepth: 3,
    selectedRoute: selectedRoute ?? undefined,
    suggestion: suggestionSnapshot,
  } satisfies SetupHistoryState, setupUrl('suggestions', selectedRoute ?? undefined, stop))
}

function renderSuggestions(
  stopName: string,
  items: SuggestionBus[],
  selectedKey: string,
  frequency: Record<string, number>,
  place?: StopPlaceIdentity,
) {
  suggestionStep.replaceChildren()
  const head = document.createElement('div')
  head.className = 'step-head'
  const back = document.createElement('button')
  back.className = 'back-button'
  back.textContent = '← 返回方向與站牌'
  back.onclick = backToStops
  const title = document.createElement('strong')
  title.textContent = stopName
  head.replaceChildren(back, title)
  const description = document.createElement('p')
  description.textContent = '已依目前選擇、常搭與到站時間排序'
  const list = document.createElement('div')
  list.className = 'suggestion-list'
  items.forEach((bus, index) => {
    const selected = busKey(bus) === selectedKey
    const isFrequent = (frequency[bus.routeUid || bus.routeName] || 0) > 0
    const row = document.createElement('label')
    row.className = 'check-row' + (selected ? ' selected' : '')
    const check = document.createElement('input')
    check.type = 'checkbox'
    check.checked = selected
    check.disabled = selected
    check.value = String(index)
    const copy = document.createElement('span')
    copy.className = 'suggestion-copy'
    const top = document.createElement('span')
    top.className = 'suggestion-main'
    const route = document.createElement('strong')
    route.textContent = bus.routeName
    const eta = document.createElement('b')
    eta.textContent = bus.label || ''
    top.replaceChildren(route, eta)
    const direction = document.createElement('small')
    direction.textContent = bus.directionLabel || ''
    copy.replaceChildren(top, direction)
    const badge = document.createElement('em')
    badge.textContent = selected ? '目前選擇' : isFrequent ? '常搭' : ''
    row.replaceChildren(check, copy)
    if (badge.textContent) row.appendChild(badge)
    list.appendChild(row)
  })
  const save = document.createElement('button')
  save.className = 'primary sticky-save'
  save.textContent = '加入常用站牌'
  save.onclick = () => {
    const checked = Array.from(list.querySelectorAll('input:checked')) as HTMLInputElement[]
    const chosen = checked.map((input) => items[Number(input.value)])
    if (!chosen.length) return
    const now = new Date().toISOString()
    const board: FavoriteBoard = {
      version: 2,
      id: newBoardId(),
      title: stopName,
      city: city.value,
      placeId: place?.placeId,
      latitude: place?.latitude,
      longitude: place?.longitude,
      buses: chosen.map(({ label: _label, directionLabel: _directionLabel, ...bus }) => bus),
      createdAt: now,
      updatedAt: now,
    }
    const value = boards()
    value.push(board)
    setActiveBoard(board.id)
    saveBoards(value)
    location.href = '/'
  }
  suggestionStep.replaceChildren(head, description, list, save)
  suggestionStep.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

const tdxId = document.querySelector('#tdx-client-id') as HTMLInputElement
const tdxSecret = document.querySelector('#tdx-client-secret') as HTMLInputElement
const tdxRemember = document.querySelector('#tdx-remember') as HTMLInputElement
const tdxSave = document.querySelector('#tdx-save') as HTMLButtonElement
const tdxRemove = document.querySelector('#tdx-remove') as HTMLButtonElement
const tdxMessage = document.querySelector('#tdx-message') as HTMLParagraphElement

// 兩個欄位共用同一則 #tdx-message(aria-describedby 已指向它),錯誤時
// 額外把觸發欄位標成 aria-invalid 並移入焦點,螢幕閱讀器/鍵盤使用者才知道
// 「錯誤訊息對應哪一格」,不是只有視覺上的顏色差異。
function setTdxFieldValidity(invalidFields: HTMLInputElement[]) {
  tdxId.setAttribute('aria-invalid', String(invalidFields.includes(tdxId)))
  tdxSecret.setAttribute('aria-invalid', String(invalidFields.includes(tdxSecret)))
}

function showTdxError(message: string, invalidFields: HTMLInputElement[] = []) {
  tdxMessage.textContent = message
  tdxMessage.classList.add('form-message-error')
  setTdxFieldValidity(invalidFields)
  invalidFields[0]?.focus()
}

function renderTdx(overrideMessage?: string) {
  const state = getTdxAuthState()
  const auth = state.auth
  tdxRemove.hidden = !auth
  tdxRemember.checked = state.persistence === 'device'
  if (auth && !tdxId.value) tdxId.value = auth.clientId
  tdxSecret.placeholder = auth ? '留空沿用目前的 Client Secret' : 'Client Secret'
  const mode = state.persistence === 'device' ? '已記住於此裝置' : '只保留在此分頁'
  tdxMessage.textContent = overrideMessage
    ?? (auth ? '目前使用你的憑證（' + auth.clientId.slice(0, 10) + '…，' + mode + '）' : '')
  tdxMessage.classList.remove('form-message-error')
  setTdxFieldValidity([])
}

// 按鈕不跟著改文字:#tdx-message 已經是 aria-live,而且兩個輸入框都用
// aria-describedby 指著它,狀態文字有一個表面就夠了。這裡取的是
// createAsyncAction 的 pending 互斥與「pending 一定會結束」保證。
const tdxSaveAction = createAsyncAction({
  button: tdxSave,
  labels: { idle: '儲存並測試', pending: '儲存並測試' },
})

tdxSave.onclick = async () => {
  const current = getTdxAuthState().auth
  const clientId = tdxId.value.trim()
  const typedSecret = tdxSecret.value.trim()
  const clientSecret = typedSecret || (current && current.clientId === clientId ? current.clientSecret : '')
  if (!clientId) {
    showTdxError('Client ID 不能空白', [tdxId])
    return
  }
  if (!clientSecret) {
    showTdxError('Client Secret 不能空白', [tdxSecret])
    return
  }
  tdxMessage.textContent = '正在跟 TDX 打聲招呼…'
  tdxMessage.classList.remove('form-message-error')
  setTdxFieldValidity([])
  const persistence = tdxRemember.checked ? 'device' : 'session'
  const result = await tdxSaveAction.run(async () => {
    await verifyTdxCredentials({ clientId, clientSecret })
    setTdxAuth({ clientId, clientSecret }, persistence)
  })
  if (result.status === 'skipped') return
  if (result.status === 'rejected') {
    // 錯誤訊息要用原本的 reason 產生,所以 run 必須把它原樣交回,不能吞成 undefined。
    const { reason } = result
    showTdxError(reason instanceof Error && reason.message ? reason.message : '驗證失敗，稍後再試', [tdxId, tdxSecret])
    return
  }
  // renderTdx 留在 action 外:它是渲染,不是驗證。渲染爆掉是真的程式錯誤,
  // 不該被偽裝成「憑證驗證失敗」而讓使用者去查一組其實正確的憑證。
  tdxSecret.value = ''
  renderTdx(persistence === 'device' ? '憑證有效，已記住於此裝置。' : '憑證有效，只保留在此分頁；關閉分頁後即移除。')
}

tdxRemove.onclick = () => {
  clearTdxAccessTokenCache()
  clearTdxAuth()
  tdxId.value = ''
  tdxSecret.value = ''
  tdxRemember.checked = false
  renderTdx('已移除，回到共用額度。')
}

getTdxAuthState()
renderTdx(consumeTdxAuthMigrationNotice()
  ? '舊版長期保存的憑證已改為只保留在此分頁；若要繼續跨次使用，請勾選「記住於此裝置」後重新儲存。'
  : undefined)

;(document.querySelector('#clear-local-button') as HTMLButtonElement).onclick = () => {
  if (!confirm('確定清除所有本機資料？常用站牌、封面設定與 TDX 憑證會全部刪除，無法復原。')) return
  clearTdxAccessTokenCache()
  clearLocalData()
  tdxId.value = ''
  tdxSecret.value = ''
  tdxRemember.checked = false
  renderBoards()
  renderTdx()
}

addBoardButton.onclick = openPicker
closePicker.onclick = hidePicker
pickerPanel.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') hidePicker()
})
filter.addEventListener('input', renderRoutes)
filter.addEventListener('input', saveRouteHistoryState)
grid.addEventListener('scroll', saveRouteHistoryState, { passive: true })
city.addEventListener('change', () => {
  selectedRoute = null
  directionGroups = []
  suggestionSnapshot = undefined
  void loadRoutes()
})
renderBoards()

function isRouteItem(value: unknown): value is RouteItem {
  return Boolean(value && typeof value === 'object' && typeof (value as RouteItem).routeName === 'string')
}

function isDirectionGroup(value: unknown): value is DirectionGroup {
  if (!value || typeof value !== 'object') return false
  const group = value as Partial<DirectionGroup>
  return typeof group.label === 'string'
    && typeof group.subRouteName === 'string'
    && (group.direction === 0 || group.direction === 1 || group.direction === 2)
    && Array.isArray(group.stops)
    && group.stops.every((stop) => Boolean(stop
      && typeof stop.stopUid === 'string'
      && typeof stop.stopName === 'string'
      && typeof stop.sequence === 'number'))
}

function isSuggestionSnapshot(value: unknown): value is SuggestionSnapshot {
  if (!value || typeof value !== 'object') return false
  const snapshot = value as Partial<SuggestionSnapshot>
  const validPlace = snapshot.place === undefined || Boolean(snapshot.place
    && typeof snapshot.place.placeId === 'string'
    && typeof snapshot.place.name === 'string'
    && typeof snapshot.place.latitude === 'number' && Number.isFinite(snapshot.place.latitude)
    && typeof snapshot.place.longitude === 'number' && Number.isFinite(snapshot.place.longitude))
  return typeof snapshot.stopName === 'string'
    && Array.isArray(snapshot.items)
    && snapshot.items.every((item) => Boolean(item
      && typeof item.routeName === 'string'
      && typeof item.stopUid === 'string'
      && (item.direction === 0 || item.direction === 1 || item.direction === 2)))
    && typeof snapshot.selectedKey === 'string'
    && Boolean(snapshot.frequency && typeof snapshot.frequency === 'object')
    && Object.values(snapshot.frequency ?? {}).every((count) => typeof count === 'number' && Number.isFinite(count))
    && validPlace
}

function setupHistoryState(): SetupHistoryState {
  const state = history.state as Partial<SetupHistoryState> | null
  const params = new URLSearchParams(location.search)
  const urlStep = params.get('step')
  const expectedStep = urlStep === 'routes' || urlStep === 'stops' || urlStep === 'suggestions' ? urlStep : 'closed'
  const validStep = state?.setupStep === 'closed' || state?.setupStep === 'routes'
    || state?.setupStep === 'stops' || state?.setupStep === 'suggestions'
  const valid = state?.setupVersion === 1
    && validStep
    && state.setupStep === expectedStep
    && Number.isInteger(state.setupDepth)
    && (state.setupDepth ?? -1) >= 0
    && (state.setupDepth ?? 4) <= 3
    && typeof state.savedAt === 'number'
    && state.savedAt >= 0
    && state.savedAt <= Date.now() + 60_000
    && Date.now() - state.savedAt < 30 * 60 * 1000
    && (state.city === undefined || typeof state.city === 'string')
    && (state.filter === undefined || typeof state.filter === 'string')
    && (state.category === undefined || typeof state.category === 'string')
    && (state.scrollTop === undefined || typeof state.scrollTop === 'number')
    && (state.routes === undefined || (Array.isArray(state.routes) && state.routes.every(isRouteItem)))
    && (state.selectedRoute === undefined || isRouteItem(state.selectedRoute))
    && (state.groups === undefined || (Array.isArray(state.groups) && state.groups.every(isDirectionGroup)))
    && (state.suggestion === undefined || isSuggestionSnapshot(state.suggestion))
  if (valid) return state as SetupHistoryState
  const fallbackCity = params.get('city') ?? undefined
  if (expectedStep !== 'closed' && fallbackCity) {
    return {
      setupVersion: 1,
      savedAt: Date.now(),
      setupStep: 'routes',
      setupDepth: 1,
      city: fallbackCity,
    }
  }
  return { setupVersion: 1, savedAt: Date.now(), setupStep: 'closed', setupDepth: 0 }
}

function minimalSetupState(state: SetupHistoryState): SetupHistoryState {
  return {
    setupVersion: 1,
    savedAt: Date.now(),
    setupStep: state.setupStep,
    setupDepth: state.setupDepth,
    city: state.city,
    filter: state.filter,
    category: state.category,
    scrollTop: state.scrollTop,
  }
}

function replaceSetupState(state: SetupHistoryState, url: string) {
  try {
    history.replaceState(state, '', url)
  } catch {
    try {
      history.replaceState(minimalSetupState(state), '', url)
    } catch {
      if (`${location.pathname}${location.search}` !== url) location.replace(url)
    }
  }
}

function pushSetupState(state: SetupHistoryState, url: string) {
  try {
    history.pushState(state, '', url)
  } catch {
    try {
      history.pushState(minimalSetupState(state), '', url)
    } catch {
      location.assign(url)
    }
  }
}

function routeHistoryState(depth: number): SetupHistoryState {
  return {
    setupVersion: 1,
    savedAt: Date.now(),
    setupStep: 'routes',
    setupDepth: depth,
    city: city.value,
    filter: filter.value,
    category,
    scrollTop: grid.scrollTop,
  }
}

function saveRouteHistoryState() {
  const state = setupHistoryState()
  if (state.setupStep !== 'routes') return
  replaceSetupState(routeHistoryState(state.setupDepth), setupUrl('routes'))
}

function setupUrl(
  step: SetupHistoryState['setupStep'],
  route?: RouteItem,
  stop?: DirectionGroup['stops'][number],
): string {
  if (step === 'closed') return '/setup'
  const params = new URLSearchParams({ step, city: city.value })
  if (route) {
    params.set('route', route.routeName)
    if (route.routeUid) params.set('routeUid', route.routeUid)
  }
  if (stop) {
    params.set('stopUid', stop.stopUid)
    params.set('stop', stop.stopName)
  }
  return `/setup?${params}`
}

function hydrateSetupHistory(focusClosed = false) {
  requestId += 1
  const state = setupHistoryState()
  if (state.setupStep === 'closed') {
    hidePickerView(focusClosed)
    return
  }
  pickerPanel.hidden = false
  if (state.city && Array.from(city.options).some((option) => option.value === state.city)) city.value = state.city
  filter.value = state.filter ?? ''
  category = state.category ?? '全部'
  routes = state.routes ?? []
  selectedRoute = state.selectedRoute ?? null
  directionGroups = state.groups ?? []
  suggestionSnapshot = state.suggestion
  if (state.setupStep === 'routes') {
    pendingRouteScrollTop = state.scrollTop ?? 0
    showRoutePicker()
    renderCategories()
    renderRoutes()
    if (routes.length) {
      queueMicrotask(() => {
        grid.scrollTop = pendingRouteScrollTop ?? 0
        pendingRouteScrollTop = undefined
      })
    }
    return
  }
  routePicker.hidden = true
  suggestionStep.hidden = true
  if (state.setupStep === 'stops' && selectedRoute) {
    renderDirections(directionGroups)
    return
  }
  if (state.setupStep === 'suggestions' && selectedRoute && suggestionSnapshot) {
    directionStep.hidden = true
    renderSuggestions(
      suggestionSnapshot.stopName,
      suggestionSnapshot.items,
      suggestionSnapshot.selectedKey,
      suggestionSnapshot.frequency,
      suggestionSnapshot.place,
    )
    return
  }
  replaceSetupState(routeHistoryState(1), setupUrl('routes'))
  showRoutePicker()
}

const initialSetupState = setupHistoryState()
const initialUrlStep = new URLSearchParams(location.search).get('step')
replaceSetupState(
  initialSetupState,
  initialSetupState.setupStep === 'closed'
    ? '/setup'
    : initialSetupState.setupStep === initialUrlStep
      ? `${location.pathname}${location.search}`
      : `/setup?${new URLSearchParams({ step: 'routes', city: initialSetupState.city ?? city.value })}`,
)
window.addEventListener('popstate', () => hydrateSetupHistory(true))
hydrateSetupHistory()
