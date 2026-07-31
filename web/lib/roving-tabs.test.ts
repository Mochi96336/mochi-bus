import { beforeEach, describe, expect, it, vi } from 'vitest'
import { attachRovingTabs, type RovingTabs } from './roving-tabs'

// 專案沒有 jsdom(見 vitest.config.ts):web 層測試一律手刻最小 DOM 替身。
// roving-tabs 只操作傳進來的節點,不碰 document,所以這裡連 document 都不需要 stub。
let activeElement: FakeElement | undefined

type FakeEvent = { key?: string; defaultPrevented: boolean; preventDefault(): void }

function fakeEvent(key?: string): FakeEvent {
  return {
    key,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true },
  }
}

class FakeElement {
  id = ''
  tabIndex = -1
  disabled = false
  readonly classes = new Set<string>()
  private readonly attributes = new Map<string, string>()
  private readonly listeners = new Map<string, Array<(event: FakeEvent) => void>>()

  readonly classList = {
    toggle: (token: string, force: boolean) => {
      if (force) this.classes.add(token)
      else this.classes.delete(token)
    },
    contains: (token: string) => this.classes.has(token),
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }

  addEventListener(type: string, listener: (event: FakeEvent) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  removeEventListener(type: string, listener: (event: FakeEvent) => void): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((entry) => entry !== listener))
  }

  focus(): void {
    activeElement = this
  }

  dispatch(type: string, event: FakeEvent): FakeEvent {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event)
    return event
  }

  click(): void {
    this.dispatch('click', fakeEvent())
  }
}

type Harness = {
  tablist: FakeElement
  tabs: FakeElement[]
  panel: FakeElement
  onSelect: ReturnType<typeof vi.fn>
  controller: RovingTabs
}

function mount(count: number, options: { initialIndex?: number; disabled?: number[] } = {}): Harness {
  const tablist = new FakeElement()
  const panel = new FakeElement()
  const tabs = Array.from({ length: count }, () => new FakeElement())
  for (const index of options.disabled ?? []) tabs[index].disabled = true

  const onSelect = vi.fn()
  const controller = attachRovingTabs({
    tablist: tablist as unknown as HTMLElement,
    tabs: tabs as unknown as HTMLButtonElement[],
    panel: panel as unknown as HTMLElement,
    idPrefix: 'service',
    initialIndex: options.initialIndex ?? 0,
    onSelect,
  })
  return { tablist, tabs, panel, onSelect, controller }
}

function press(tablist: FakeElement, key: string): FakeEvent {
  return tablist.dispatch('keydown', fakeEvent(key))
}

function selectedIndexes(tabs: FakeElement[]): number[] {
  return tabs.flatMap((tab, index) => tab.getAttribute('aria-selected') === 'true' ? [index] : [])
}

function focusableIndexes(tabs: FakeElement[]): number[] {
  return tabs.flatMap((tab, index) => tab.tabIndex === 0 ? [index] : [])
}

describe('roving tabs', () => {
  beforeEach(() => {
    activeElement = undefined
  })

  it('wires ARIA relationships in both directions', () => {
    const { tabs, panel, tablist } = mount(3)

    expect(tablist.getAttribute('role')).toBe('tablist')
    expect(panel.getAttribute('role')).toBe('tabpanel')
    expect(panel.id).toBe('service-panel')
    // tabpanel 要可聚焦,否則從 tab 按 Tab 會整段跳過內容。
    expect(panel.tabIndex).toBe(0)
    for (const tab of tabs) {
      expect(tab.getAttribute('role')).toBe('tab')
      expect(tab.getAttribute('aria-controls')).toBe('service-panel')
    }
    expect(panel.getAttribute('aria-labelledby')).toBe(tabs[0].id)
  })

  it('renders the initial selection so the panel never disagrees with aria-selected', () => {
    const { onSelect, tabs, panel } = mount(2, { initialIndex: 1 })

    expect(onSelect.mock.calls).toEqual([[1]])
    expect(selectedIndexes(tabs)).toEqual([1])
    expect(panel.getAttribute('aria-labelledby')).toBe(tabs[1].id)
  })

  it('moves with arrow keys and wraps at both edges', () => {
    const { tablist, tabs, onSelect } = mount(3)

    press(tablist, 'ArrowRight')
    expect(selectedIndexes(tabs)).toEqual([1])
    press(tablist, 'ArrowRight')
    press(tablist, 'ArrowRight')
    expect(selectedIndexes(tabs)).toEqual([0])
    press(tablist, 'ArrowLeft')
    expect(selectedIndexes(tabs)).toEqual([2])
    expect(onSelect.mock.calls.map(([index]) => index)).toEqual([0, 1, 2, 0, 2])
  })

  it('jumps to the first and last tab with Home and End', () => {
    const { tablist, tabs } = mount(3, { initialIndex: 1 })

    press(tablist, 'End')
    expect(selectedIndexes(tabs)).toEqual([2])
    press(tablist, 'Home')
    expect(selectedIndexes(tabs)).toEqual([0])
  })

  it('skips disabled tabs when moving and when landing on an edge', () => {
    const { tablist, tabs } = mount(4, { disabled: [1, 3] })

    press(tablist, 'ArrowRight')
    expect(selectedIndexes(tabs)).toEqual([2])
    press(tablist, 'End')
    expect(selectedIndexes(tabs)).toEqual([2])
    press(tablist, 'ArrowRight')
    expect(selectedIndexes(tabs)).toEqual([0])
  })

  it('starts on the next enabled tab when the requested initial tab is disabled', () => {
    const { tabs, onSelect } = mount(2, { initialIndex: 0, disabled: [0] })

    expect(selectedIndexes(tabs)).toEqual([1])
    expect(onSelect.mock.calls).toEqual([[1]])
  })

  it('keeps exactly one tab in the page tab order', () => {
    const { tablist, tabs } = mount(3)

    expect(focusableIndexes(tabs)).toEqual([0])
    press(tablist, 'ArrowRight')
    expect(focusableIndexes(tabs)).toEqual([1])
    tabs[2].click()
    expect(focusableIndexes(tabs)).toEqual([2])
  })

  it('moves focus with the selection so the keyboard user follows the panel', () => {
    const { tablist, tabs } = mount(2)

    press(tablist, 'ArrowRight')
    expect(activeElement).toBe(tabs[1])
  })

  it('does not steal focus when the tab is chosen by pointer', () => {
    const { tabs } = mount(2)

    tabs[1].click()
    expect(selectedIndexes(tabs)).toEqual([1])
    expect(activeElement).toBeUndefined()
  })

  it('claims arrow and Home/End keys but leaves other keys to the page', () => {
    const { tablist } = mount(2)

    const claimed = ['ArrowLeft', 'ArrowRight', 'Home', 'End']
      .map((key) => press(tablist, key).defaultPrevented)

    expect(claimed).toEqual([true, true, true, true])
    expect(press(tablist, 'ArrowDown').defaultPrevented).toBe(false)
  })

  it('ignores a repeated selection instead of re-rendering the panel', () => {
    const { tablist, onSelect } = mount(1)

    onSelect.mockClear()
    press(tablist, 'ArrowRight')
    press(tablist, 'Home')
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('stops handling keys after dispose', () => {
    const { tablist, tabs, controller } = mount(2)

    controller.dispose()
    press(tablist, 'ArrowRight')
    expect(selectedIndexes(tabs)).toEqual([0])
  })

  it('rejects an empty tab set instead of rendering a headless panel', () => {
    expect(() => attachRovingTabs({
      tablist: new FakeElement() as unknown as HTMLElement,
      tabs: [],
      panel: new FakeElement() as unknown as HTMLElement,
      idPrefix: 'service',
      initialIndex: 0,
      onSelect: () => {},
    })).toThrow(/at least one tab/)
  })
})
