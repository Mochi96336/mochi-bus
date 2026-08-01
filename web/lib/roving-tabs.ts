// APG tabs 的鍵盤模型:tablist 只佔一個 Tab 停留點,群組內用方向鍵移動。
// 採自動啟動(follow focus)——方向鍵移到哪一個 tab,內容就換到哪一個,
// 因為服務日期切換是純本機資料,沒有等待成本。
export type RovingTabsOptions = {
  tablist: HTMLElement
  tabs: readonly HTMLButtonElement[]
  panel: HTMLElement
  /** 同頁可能同時存在多組 tablist,id 必須帶上路線之類的識別。 */
  idPrefix: string
  initialIndex: number
  onSelect: (index: number) => void
}

export type RovingTabs = {
  select(index: number): void
  selectedIndex(): number
  dispose(): void
}

export function attachRovingTabs(options: RovingTabsOptions): RovingTabs {
  const { tablist, tabs, panel, idPrefix, onSelect } = options
  if (!tabs.length) throw new Error('Roving tabs need at least one tab')

  const panelId = `${idPrefix}-panel`
  panel.id = panelId
  panel.setAttribute('role', 'tabpanel')
  // tabpanel 本身要可聚焦,否則從 tab 按 Tab 之後會直接跳過整段內容。
  panel.tabIndex = 0

  tabs.forEach((tab, index) => {
    tab.id = `${idPrefix}-tab-${index}`
    tab.setAttribute('role', 'tab')
    tab.setAttribute('aria-controls', panelId)
    tab.addEventListener('click', () => select(index))
  })

  let selected = clampToEnabled(options.initialIndex)

  function clampToEnabled(index: number): number {
    if (isEnabled(index)) return index
    return nextEnabled(index, 1) ?? index
  }

  function isEnabled(index: number): boolean {
    const tab = tabs[index]
    return Boolean(tab) && !tab.disabled
  }

  // 環繞搜尋,最多走一圈;全部 disabled 時回 undefined,呼叫端保持原狀。
  function nextEnabled(from: number, step: number): number | undefined {
    for (let offset = 1; offset <= tabs.length; offset += 1) {
      const index = (((from + step * offset) % tabs.length) + tabs.length) % tabs.length
      if (isEnabled(index)) return index
    }
  }

  function edgeEnabled(step: 1 | -1): number | undefined {
    const start = step === 1 ? 0 : tabs.length - 1
    if (isEnabled(start)) return start
    return nextEnabled(start, step)
  }

  function paint(): void {
    tabs.forEach((tab, index) => {
      const active = index === selected
      tab.classList.toggle('active', active)
      tab.setAttribute('aria-selected', String(active))
      // roving tabIndex:群組內恆定只有一個 0,Tab 鍵才不會逐個走過每個日期。
      tab.tabIndex = active ? 0 : -1
    })
    panel.setAttribute('aria-labelledby', tabs[selected].id)
  }

  function select(index: number): void {
    if (!isEnabled(index)) return
    selected = index
    paint()
    onSelect(index)
  }

  function move(index: number | undefined): void {
    if (index === undefined || index === selected) return
    select(index)
    tabs[index].focus()
  }

  function onKeydown(event: KeyboardEvent): void {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (step !== 0) {
      event.preventDefault()
      move(nextEnabled(selected, step))
      return
    }
    if (event.key === 'Home') {
      event.preventDefault()
      move(edgeEnabled(1))
      return
    }
    if (event.key === 'End') {
      event.preventDefault()
      move(edgeEnabled(-1))
    }
  }

  tablist.setAttribute('role', 'tablist')
  tablist.addEventListener('keydown', onKeydown)
  // 掛載時就把面板畫成選中的那一個:aria-selected 與內容永遠由同一條路徑決定,
  // 呼叫端不需要另外記得先渲染一次初始內容。
  paint()
  onSelect(selected)

  return {
    select,
    selectedIndex: () => selected,
    dispose: () => tablist.removeEventListener('keydown', onKeydown),
  }
}
