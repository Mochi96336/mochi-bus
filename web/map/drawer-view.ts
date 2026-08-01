import { attachScrollFade } from '../lib/scroll-fade'
import './drawer-size.css'

export type DrawerScrollableMode = 'map-list' | 'results' | 'timetable'
export type DrawerSize = 'content' | 'compact' | 'standard' | 'tall' | 'expanded'

const DRAWER_SIZE_MEMORY_LIMIT = 32

export type DrawerView =
  | {
      key: string
      sizeKey?: string
      mode: 'compact'
      size?: DrawerSize
      preserveMobileHeight?: boolean
      preserveDesktopHeight?: boolean
      content: readonly Node[]
    }
  | {
      key: string
      sizeKey?: string
      mode: DrawerScrollableMode
      size?: DrawerSize
      preserveMobileHeight?: boolean
      preserveDesktopHeight?: boolean
      header: readonly Node[]
      content: readonly Node[]
      footer?: readonly Node[]
    }

export type DrawerViewSession = {
  readonly signal: AbortSignal
  readonly scrollRegion?: HTMLDivElement
  releasePreservedHeight(): void
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
  const sizesByViewKey = new Map<string, DrawerSize>()

  const dispose = () => {
    disposeCurrentView?.()
    disposeCurrentView = undefined
  }

  const render = (view: DrawerView): DrawerViewSession => {
    const previousViewKey = currentViewKey
    const sizeKey = drawerSizeMemoryKey(view)
    const nextSize = drawerSizeForView(view, sizesByViewKey.get(sizeKey))
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
    const hadFocusInside = drawer.contains(document.activeElement)
    currentViewKey = view.key
    rememberDrawerSize(sizesByViewKey, sizeKey, nextSize)

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
    const orphanedFocus = hadFocusInside && !drawer.contains(document.activeElement)
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
      // Legacy callers release a measured transition height after rendering.
      // Size states no longer depend on DOM measurement, so this is intentionally a no-op.
      releasePreservedHeight() {},
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

export function drawerSizeMemoryKey(view: DrawerView): string {
  return view.sizeKey ?? view.key
}

export function drawerSizeForView(
  view: DrawerView,
  rememberedSize: DrawerSize | undefined,
): DrawerSize {
  // A view key names the navigation workspace. Catalogue loading, failure, and the final
  // route list share that workspace even though their temporary content modes differ.
  const workspaceSize = view.size
    ?? (view.key.startsWith('catalogue:') ? 'standard' : undefined)
  return drawerSizeForTransition(
    workspaceSize,
    view.mode,
    Boolean(view.preserveMobileHeight || view.preserveDesktopHeight),
    rememberedSize,
  )
}

export function drawerSizeForTransition(
  explicitSize: DrawerSize | undefined,
  mode: DrawerView['mode'],
  preserveHeight: boolean,
  rememberedSize: DrawerSize | undefined,
): DrawerSize {
  if (explicitSize) return explicitSize
  if (rememberedSize && rememberedSize !== 'content') return rememberedSize
  if (mode === 'map-list' || mode === 'results' || mode === 'timetable') return 'standard'
  if (preserveHeight) return 'standard'
  return 'content'
}

// Transitional helpers are retained for compatibility with focused unit tests and callers
// that have not yet migrated from measured heights. The renderer no longer uses them.
export function shouldPreserveDrawerHeight(
  preserveMobileHeight: boolean | undefined,
  preserveDesktopHeight: boolean | undefined,
  mobileLayout: boolean,
  desktopLayout: boolean,
): boolean {
  return Boolean(
    (preserveMobileHeight && mobileLayout)
    || (preserveDesktopHeight && desktopLayout),
  )
}

export function drawerMinHeightForTransition(
  preserveHeight: boolean | undefined,
  previousHeight: number,
  maximumHeight = Number.POSITIVE_INFINITY,
): string {
  if (!preserveHeight || !Number.isFinite(previousHeight) || previousHeight <= 0) return ''
  const boundedHeight = Number.isFinite(maximumHeight)
    ? Math.min(previousHeight, Math.max(0, maximumHeight))
    : previousHeight
  return boundedHeight > 0 ? `${Math.ceil(boundedHeight)}px` : ''
}

function rememberDrawerSize(memory: Map<string, DrawerSize>, key: string, size: DrawerSize) {
  if (size === 'content') {
    memory.delete(key)
    return
  }
  memory.delete(key)
  memory.set(key, size)
  if (memory.size <= DRAWER_SIZE_MEMORY_LIMIT) return
  const oldestKey = memory.keys().next().value
  if (oldestKey) memory.delete(oldestKey)
}

function animateNodes(nodes: readonly Node[]) {
  for (const node of nodes) {
    if (node instanceof HTMLElement) node.classList.add('drawer-content-enter')
  }
}

function appendNodes(parent: Node, nodes: readonly Node[]) {
  for (const node of nodes) parent.appendChild(node)
}
