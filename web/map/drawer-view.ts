import { attachScrollFade } from '../lib/scroll-fade'
import './drawer-size.css'

export type DrawerScrollableMode = 'map-list' | 'results' | 'timetable'
export type DrawerSize = 'content' | 'compact' | 'nearby' | 'standard' | 'tall' | 'expanded'

/**
 * 這個畫面顯示的不是這次導覽的最終內容(skeleton、錯誤頁),所以它不決定高度:
 * 抽屜維持現在的高度,等真正的內容到達才改一次。標記必須是顯式的——曾經用
 * 「有沒有給 size」來推論,而那個推論兩個方向都會錯:showRouteLoading 是讀取中
 * 卻給了 size,trip-results 的 compact 是最終內容卻沒給。
 */
type TransientView = { transient?: boolean }

export type DrawerView =
  | (TransientView & {
      key: string
      mode: 'compact'
      size?: DrawerSize
      content: readonly Node[]
    })
  | (TransientView & {
      key: string
      mode: DrawerScrollableMode
      size?: DrawerSize
      header: readonly Node[]
      content: readonly Node[]
      footer?: readonly Node[]
    })

export type DrawerViewSession = {
  readonly signal: AbortSignal
  readonly scrollRegion?: HTMLDivElement
  onDispose(cleanup: () => void): void
}

export type DrawerRenderer = {
  render(view: DrawerView): DrawerViewSession
  dispose(): void
}

export type DrawerRendererOptions = {
  /** 注入以便測試;預設自行安裝在 document 上。 */
  isKeyboardActivation?: () => boolean
}

export function createDrawerRenderer(
  drawer: HTMLElement,
  options: DrawerRendererOptions = {},
): DrawerRenderer {
  const tracker = options.isKeyboardActivation ? undefined : createKeyboardActivationTracker()
  const isKeyboardActivation = options.isKeyboardActivation ?? (() => tracker?.consume() ?? false)
  let disposeCurrentView: (() => void) | undefined
  let currentViewKey: string | undefined
  let currentScrollRegion: HTMLDivElement | undefined
  let currentSize: DrawerSize | undefined

  const dispose = () => {
    disposeCurrentView?.()
    disposeCurrentView = undefined
  }

  const render = (view: DrawerView): DrawerViewSession => {
    const previousViewKey = currentViewKey
    const nextSize = drawerSizeForView(view, currentSize)
    const restoredScrollTop = drawerScrollTopForTransition(
      previousViewKey,
      view.key,
      currentScrollRegion?.scrollTop ?? 0,
    )
    dispose()

    const abortController = new AbortController()
    const cleanups: Array<() => void> = []
    let active = true
    let scrollRegion: HTMLDivElement | undefined
    const animateContent = shouldAnimateDrawerTransition(previousViewKey, view.key)
    // 每次 render 都消耗掉旗標,否則一次鍵盤操作留下的 true 會被後面某個
    // 非鍵盤觸發的 render(popstate、URL hydration、ETA 刷新)撿去用。
    const keyboardEntry = isKeyboardActivation()
    const hadVisibleFocusInside = hasVisibleFocusInside(drawer)
    currentViewKey = view.key
    currentSize = nextSize

    drawer.dataset.view = view.key
    drawer.dataset.mode = view.mode
    drawer.dataset.size = nextSize
    drawer.style.removeProperty('height')
    drawer.style.removeProperty('min-height')

    drawer.scrollTop = 0
    drawer.replaceChildren()

    if (view.mode === 'compact') {
      drawer.dataset.scrollable = 'false'
      currentScrollRegion = undefined
      appendNodes(drawer, view.content)
      if (animateContent) animateNodes(view.content)
    } else {
      drawer.dataset.scrollable = 'true'
      const shell = document.createElement('div')
      shell.className = 'drawer-scroll-shell'
      scrollRegion = document.createElement('div')
      scrollRegion.className = 'drawer-scroll-region'
      appendNodes(scrollRegion, view.content)
      if (animateContent) scrollRegion.classList.add('drawer-content-enter')

      const fade = document.createElement('div')
      fade.className = 'drawer-scroll-fade'
      fade.setAttribute('aria-hidden', 'true')
      shell.appendChild(scrollRegion)
      shell.appendChild(fade)
      appendNodes(drawer, view.header)
      drawer.appendChild(shell)
      appendNodes(drawer, view.footer ?? [])
      scrollRegion.scrollTop = restoredScrollTop
      currentScrollRegion = scrollRegion

      cleanups.push(attachScrollFade(scrollRegion))
    }

    // 只有鍵盤導覽才主動轉移焦點。滑鼠與地圖點擊不搶焦點——手機上搶焦點會叫出
    // 虛擬鍵盤,也會打斷正在進行的地圖操作。Drawer 不是 modal,不設 focus trap。
    //
    // 第二個條件是修復,不是搶奪:焦點本來就在 drawer 裡,是剛才的
    // replaceChildren 把那個節點拔掉的。loading 與 settled 共用 view key,
    // 所以這種情況很常見——不接回來的話焦點會掉到 body,下一次 Tab 就從
    // 整頁最上面重來。焦點原本在 drawer 之外時一律不碰。
    //
    // 而且只修復「看得見的」焦點。手機上點一顆按鈕也會讓它得到焦點,接回來等於
    // 憑空生出一個焦點框:使用者從沒用鍵盤,卻在返回鍵上看到一圈 focus ring。
    // 這條路徑要保住的是 Tab 序,而 Tab 序只對正在用鍵盤的人有意義,那正是
    // :focus-visible 的定義。
    const orphanedFocus = hadVisibleFocusInside && !drawer.contains(document.activeElement)
    if ((animateContent && keyboardEntry) || orphanedFocus) focusDrawerEntry(drawer)

    const disposeView = () => {
      if (!active) return
      active = false
      abortController.abort()
      for (const cleanup of cleanups.splice(0).reverse()) cleanup()
    }
    disposeCurrentView = disposeView

    return {
      signal: abortController.signal,
      scrollRegion,
      onDispose(cleanup) {
        if (active) cleanups.push(cleanup)
        else cleanup()
      },
    }
  }

  return {
    render,
    dispose() {
      dispose()
      tracker?.dispose()
    },
  }
}

export type KeyboardActivationTracker = {
  /** 一次性讀取:讀完歸零,一次鍵盤操作只授權一次焦點轉移。 */
  consume(): boolean
  dispose(): void
}

// 由 Enter 或 Space 觸發的 click 在多數瀏覽器仍然是 PointerEvent,
// 用 instanceof KeyboardEvent 判斷不出鍵盤操作。可靠的訊號是 detail:
// 滑鼠與觸控的 click 一定帶著點擊次數,鍵盤觸發的是 0。
export function createKeyboardActivationTracker(
  target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> = document,
): KeyboardActivationTracker {
  let keyboard = false
  const onClick = (event: Event) => { keyboard = (event as MouseEvent).detail === 0 }
  const onPointerDown = () => { keyboard = false }
  target.addEventListener('click', onClick, true)
  target.addEventListener('pointerdown', onPointerDown, true)
  return {
    consume() {
      const value = keyboard
      keyboard = false
      return value
    },
    dispose() {
      target.removeEventListener('click', onClick, true)
      target.removeEventListener('pointerdown', onPointerDown, true)
    },
  }
}

// 抽屜裡是否有一個「正在顯示焦點指示」的元素。:focus-visible 就是瀏覽器對這件事
// 的判斷,不必自己重寫一套 heuristic。舊瀏覽器不認得這個選擇器時 matches 會丟出
// SyntaxError,那時退回只看有沒有焦點——寧可多修復一次,不要整條路徑失效。
export function hasVisibleFocusInside(drawer: HTMLElement): boolean {
  const active = document.activeElement
  if (!(active instanceof HTMLElement) || !drawer.contains(active)) return false
  try {
    return active.matches(':focus-visible')
  } catch {
    return true
  }
}

// 焦點移到第一個可聚焦控制(通常是返回鍵),不是標題:標題在 DOM 上排在返回鍵
// 之後,聚焦標題會讓返回鍵只剩 Shift+Tab 才到得了。第一個控制則讓整個 drawer
// 都還在往前的 Tab 序上。
function focusDrawerEntry(drawer: HTMLElement): void {
  const control = drawer.querySelector<HTMLElement>(
    'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled])',
  )
  if (control) {
    control.focus()
    return
  }
  const heading = drawer.querySelector<HTMLElement>('h1')
  if (!heading) return
  heading.tabIndex = -1
  heading.focus()
}

export function shouldAnimateDrawerTransition(previousKey: string | undefined, nextKey: string): boolean {
  return previousKey !== undefined && previousKey !== nextKey
}

export function drawerScrollTopForTransition(
  previousKey: string | undefined,
  nextKey: string,
  previousScrollTop: number,
): number {
  return previousKey === nextKey ? Math.max(0, previousScrollTop) : 0
}

// 只有帶著最終內容的畫面決定尺寸。transient 的畫面沿用抽屜當下的高度,跨 workspace
// 也一樣——點站牌是 nearby → place 的跨 workspace 導覽,限定在同一個 workspace 內
// 沿用的話,骨架就會在那裡改高度。一次導覽因此只剩一次尺寸變化,發生在資料到達時,
// 而且是 drawer-size.css 的過渡。
export function drawerSizeForView(
  view: DrawerView,
  currentSize: DrawerSize | undefined,
): DrawerSize {
  if (view.transient && currentSize) return currentSize
  return drawerSizeForTransition(view.size, view.mode)
}

// 沒有指定尺寸時,可捲動的畫面落在中性的 standard 工作區,compact 則貼著內容。
// 需要別的尺寸(例如目錄的讀取與失敗狀態要留在 standard)由呼叫端明講 size——
// renderer 不去解讀 view key 的命名慣例。
export function drawerSizeForTransition(
  explicitSize: DrawerSize | undefined,
  mode: DrawerView['mode'],
): DrawerSize {
  if (explicitSize) return explicitSize
  if (mode === 'map-list' || mode === 'results' || mode === 'timetable') return 'standard'
  return 'content'
}

function animateNodes(nodes: readonly Node[]) {
  for (const node of nodes) {
    if (node instanceof HTMLElement) node.classList.add('drawer-content-enter')
  }
}

function appendNodes(parent: Node, nodes: readonly Node[]) {
  for (const node of nodes) parent.appendChild(node)
}
