import { attachScrollFade } from '../lib/scroll-fade'

export type DrawerScrollableMode = 'map-list' | 'results' | 'timetable'

export type DrawerView =
  | {
      key: string
      mode: 'compact'
      preserveMobileHeight?: boolean
      preserveDesktopHeight?: boolean
      content: readonly Node[]
    }
  | {
      key: string
      mode: DrawerScrollableMode
      preserveMobileHeight?: boolean
      preserveDesktopHeight?: boolean
      header: readonly Node[]
      content: readonly Node[]
      footer?: readonly Node[]
    }

export type DrawerViewSession = {
  readonly signal: AbortSignal
  readonly scrollRegion?: HTMLDivElement
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

  const dispose = () => {
    disposeCurrentView?.()
    disposeCurrentView = undefined
  }

  const render = (view: DrawerView): DrawerViewSession => {
    const mobileLayout = window.matchMedia('(max-width: 640px)')
    const desktopLayout = window.matchMedia('(min-width: 641px) and (min-height: 560px)')
    const preserveHeight = shouldPreserveDrawerHeight(
      view.preserveMobileHeight,
      view.preserveDesktopHeight,
      mobileLayout.matches,
      desktopLayout.matches,
    )
    const previousHeight = preserveHeight ? drawer.getBoundingClientRect().height : 0
    const restoredScrollTop = drawerScrollTopForTransition(
      currentViewKey,
      view.key,
      currentScrollRegion?.scrollTop ?? 0,
    )
    dispose()

    const abortController = new AbortController()
    const cleanups: Array<() => void> = []
    let active = true
    let scrollRegion: HTMLDivElement | undefined
    const animateContent = shouldAnimateDrawerTransition(currentViewKey, view.key)
    currentViewKey = view.key

    const preservedMinHeight = drawerMinHeightForTransition(preserveHeight, previousHeight)
    const applyPreservedMinHeight = () => {
      const activeLayout = shouldPreserveDrawerHeight(
        view.preserveMobileHeight,
        view.preserveDesktopHeight,
        mobileLayout.matches,
        desktopLayout.matches,
      )
      if (preservedMinHeight && activeLayout) drawer.style.minHeight = preservedMinHeight
      else drawer.style.removeProperty('min-height')
    }
    applyPreservedMinHeight()
    if (preservedMinHeight) {
      if (view.preserveMobileHeight) mobileLayout.addEventListener('change', applyPreservedMinHeight)
      if (view.preserveDesktopHeight ?? view.preserveMobileHeight) {
        desktopLayout.addEventListener('change', applyPreservedMinHeight)
      }
      cleanups.push(() => {
        if (view.preserveMobileHeight) mobileLayout.removeEventListener('change', applyPreservedMinHeight)
        if (view.preserveDesktopHeight ?? view.preserveMobileHeight) {
          desktopLayout.removeEventListener('change', applyPreservedMinHeight)
        }
        drawer.style.removeProperty('min-height')
      })
    }

    drawer.dataset.view = view.key
    drawer.dataset.mode = view.mode
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

export function shouldPreserveDrawerHeight(
  preserveMobileHeight: boolean | undefined,
  preserveDesktopHeight: boolean | undefined,
  mobileLayout: boolean,
  desktopLayout: boolean,
): boolean {
  const desktopPreservation = preserveDesktopHeight ?? preserveMobileHeight
  return Boolean(
    (preserveMobileHeight && mobileLayout)
    || (desktopPreservation && desktopLayout),
  )
}

export function drawerMinHeightForTransition(
  preserveHeight: boolean | undefined,
  previousHeight: number,
): string {
  if (!preserveHeight || !Number.isFinite(previousHeight) || previousHeight <= 0) return ''
  return `${Math.ceil(previousHeight)}px`
}

function animateNodes(nodes: readonly Node[]) {
  for (const node of nodes) {
    if (node instanceof HTMLElement) node.classList.add('drawer-content-enter')
  }
}

function appendNodes(parent: Node, nodes: readonly Node[]) {
  for (const node of nodes) parent.appendChild(node)
}
