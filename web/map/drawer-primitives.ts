import { createAsyncAction } from '../lib/async-action-state'

export type DegradedNoticeOptions = {
  message: string
  onRetry: () => void | Promise<void>
  credentialRecovery?: boolean
  /**
   * 只有當通知旁邊還有可用內容時才可折疊。通知本身就是整個畫面的內容時不行——
   * 那時候折疊等於把唯一的出口藏起來。
   */
  collapsible?: boolean
}

// 折疊狀態記在記憶體,不進 localStorage:問題仍然成立時,重新載入應該重新展開。
// 以訊息為鍵,是因為車輛定位每 20 秒重畫一次通知——不記住的話,使用者折疊完
// 二十秒後又會彈開。
const foldedNotices = new Set<string>()

export function degradedNotice(options: DegradedNoticeOptions): HTMLElement {
  const { message, onRetry, credentialRecovery, collapsible } = options
  const notice = document.createElement('section')
  notice.className = 'degraded-notice'
  if (credentialRecovery) notice.classList.add('credential-recovery')

  const actions = document.createElement('div')
  actions.className = 'degraded-actions'
  actions.appendChild(retryButton(onRetry))
  const setup = document.createElement('a')
  setup.className = 'quiet-link'
  setup.href = '/setup'
  setup.textContent = '檢查 TDX 設定'
  actions.appendChild(setup)

  if (!collapsible) {
    notice.appendChild(liveMessage(paragraph(message)))
    notice.appendChild(actions)
    return notice
  }

  // 折疊只收起處理動作,問題敘述一直留在 summary 上:使用者可以把仍然成立的
  // 問題縮小,不能讓它看起來不再存在。
  const fold = document.createElement('details')
  fold.className = 'degraded-fold'
  fold.open = !foldedNotices.has(message)
  const summary = document.createElement('summary')
  const copy = document.createElement('span')
  copy.textContent = message
  summary.appendChild(liveMessage(copy))
  fold.appendChild(summary)
  fold.appendChild(actions)
  fold.addEventListener('toggle', () => {
    if (fold.open) foldedNotices.delete(message)
    else foldedNotices.add(message)
  })
  notice.appendChild(fold)
  return notice
}

// role="status" 掛在訊息節點而不是整張通知:掛在容器上時,展開折疊會讓
// 按鈕文字進出 live region 而被重新朗讀,而且朗讀內容會變成把按鈕唸一遍。
// 要宣告的是問題本身。
function liveMessage(node: HTMLElement): HTMLElement {
  node.setAttribute('role', 'status')
  return node
}

export function isNoticeFolded(message: string): boolean {
  return foldedNotices.has(message)
}

export function resetFoldedNotices(): void {
  foldedNotices.clear()
}

export function heading(title: string, description: string): HTMLElement {
  const wrapper = document.createElement('div')
  wrapper.className = 'drawer-heading'
  const titleNode = document.createElement('h1')
  titleNode.textContent = title
  const descriptionNode = document.createElement('p')
  descriptionNode.textContent = description
  wrapper.appendChild(titleNode)
  wrapper.appendChild(descriptionNode)
  return wrapper
}

export function paragraph(text: string): HTMLElement {
  const node = document.createElement('p')
  node.className = 'drawer-copy'
  node.textContent = text
  return node
}

export function drawerBack(label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.className = 'drawer-back'
  button.textContent = `← ${label}`
  button.addEventListener('click', onClick)
  return button
}

// 讀取失敗時的統一退路:skeleton/loading 畫面不能停在原地不動,
// 一定要有明確的錯誤文字加上可以再試一次的按鈕。
//
// 只有 pending 態:重試會讓 drawer 重繪並丟掉這顆按鈕,success/error 永遠不會被看到
// (失敗時 renderError 也是建新按鈕)。沒有 settle 倒數,就沒有需要接 DrawerViewSession
// .onDispose 的計時器——那條線本來也接不起來,session 是 renderDrawer 的回傳值,
// 按鈕卻必須在 view.content 組好之前就建立。createAsyncAction 的 isConnected
// 檢查再擋一層殘留寫入。
export function retryButton(onClick: () => void | Promise<void>): HTMLButtonElement {
  const button = document.createElement('button')
  button.className = 'quiet-button'
  button.textContent = '再試一次'
  const action = createAsyncAction({
    button,
    labels: { idle: '再試一次', pending: '重試中…' },
  })
  button.addEventListener('click', () => { void action.run(async () => { await onClick() }) })
  return button
}

export function buttonGrid(
  items: Array<{ label: string; onClick: () => void }>,
  className?: string,
): HTMLElement {
  const grid = document.createElement('div')
  grid.className = 'selection-grid'
  if (className) grid.classList.add(className)
  for (const item of items) {
    const button = document.createElement('button')
    button.textContent = item.label
    button.addEventListener('click', item.onClick)
    grid.appendChild(button)
  }
  return grid
}
