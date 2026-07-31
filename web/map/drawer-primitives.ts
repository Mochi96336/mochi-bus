import { createAsyncAction } from '../lib/async-action-state'

export function degradedNotice(
  message: string,
  onRetry: () => void,
  credentialRecovery = false,
): HTMLElement {
  const notice = document.createElement('section')
  notice.className = 'degraded-notice'
  if (credentialRecovery) notice.classList.add('credential-recovery')
  notice.setAttribute('role', 'status')
  notice.appendChild(paragraph(message))
  const actions = document.createElement('div')
  actions.className = 'degraded-actions'
  actions.appendChild(retryButton(onRetry))
  const setup = document.createElement('a')
  setup.className = 'quiet-link'
  setup.href = '/setup'
  setup.textContent = '檢查 TDX 設定'
  actions.appendChild(setup)
  notice.appendChild(actions)
  return notice
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
