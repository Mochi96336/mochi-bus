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
export function retryButton(onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.className = 'quiet-button'
  button.textContent = '再試一次'
  button.addEventListener('click', onClick)
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
