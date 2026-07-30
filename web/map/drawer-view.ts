import { attachScrollFade } from '../lib/scroll-fade'
import './drawer-size.css'

export type DrawerScrollableMode = 'map-list' | 'results' | 'timetable'
export type DrawerSize = 'content' | 'compact' | 'standard' | 'tall' | 'expanded'

const DRAWER_SIZE_MEMORY_LIMIT = 32

export type DrawerView =
  | {
      key: string
      mode: 'compact'
      size?: DrawerSize
      preserveMobileHeight?: boolean
      preserveDesktopHeight?: boolean
      content: readonly Node[]
    }
  | {
      key: string
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

export function createDrawerRenderer(drawer: HTMLElement): DrawerRenderer {
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
    const nextSize = drawerSizeForView(view, sizesByViewKey.get(view.key))
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
    currentViewKey = view.key
    rememberDrawerSize(sizesByViewKey, view.key, nextSize)

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

  return { render, dispose }
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
