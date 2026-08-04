import modalStyles from './picker-modal.css?inline'

type PickerStep = 'routes' | 'stops' | 'suggestions'

type PickerModalElements = {
  panel: HTMLElement
  toolbar: HTMLElement
  closeButton: HTMLButtonElement
  addButton: HTMLButtonElement
  routePicker: HTMLElement
  directionStep: HTMLElement
  suggestionStep: HTMLElement
}

function installModalStyles(): void {
  if (document.querySelector('#picker-modal-styles')) return
  const style = document.createElement('style')
  style.id = 'picker-modal-styles'
  style.textContent = modalStyles
  document.head.appendChild(style)
}

function currentStep(elements: Pick<PickerModalElements, 'routePicker' | 'directionStep' | 'suggestionStep'>): PickerStep {
  if (!elements.suggestionStep.hidden) return 'suggestions'
  if (!elements.directionStep.hidden) return 'stops'
  return 'routes'
}

function stepLabel(step: PickerStep): string {
  if (step === 'stops') return '第 2 步，共 3 步 · 選擇方向與站牌'
  if (step === 'suggestions') return '第 3 步，共 3 步 · 確認同站公車'
  return '第 1 步，共 3 步 · 先選路線'
}

export function enhanceSetupPickerModal(elements: PickerModalElements): () => void {
  const { panel, toolbar, closeButton, addButton } = elements
  panel.classList.add('picker-modal')
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-modal', 'true')

  const title = toolbar.querySelector<HTMLElement>('strong')
  if (!title) throw new Error('setup picker modal requires a toolbar title')
  title.id ||= 'picker-modal-title'
  panel.setAttribute('aria-labelledby', title.id)

  const subtitle = document.createElement('span')
  subtitle.id = 'picker-modal-subtitle'
  subtitle.className = 'picker-modal-subtitle'
  subtitle.setAttribute('aria-live', 'polite')
  closeButton.insertAdjacentElement('beforebegin', subtitle)
  panel.setAttribute('aria-describedby', subtitle.id)

  // 遮罩是 modal 的操作層，不是 setup-page 的背景內容。放在 body 才不會
  // 混進 main.ts 啟動時固定下來的 inert siblings，也不會改變既有焦點邊界。
  const backdrop = document.createElement('div')
  backdrop.className = 'picker-modal-backdrop'
  backdrop.hidden = true
  backdrop.setAttribute('aria-hidden', 'true')
  document.body.insertAdjacentElement('beforeend', backdrop)

  let lockedScrollY = 0
  let backgroundLocked = false
  let scrollRestoreGeneration = 0
  let previousScrollRestoration: ScrollRestoration | null = null

  function lockBackground(): void {
    // 快速關閉後立刻重開時，讓前一次排程中的 scroll restore 自動失效。
    scrollRestoreGeneration += 1
    if (backgroundLocked) return
    backgroundLocked = true
    lockedScrollY = window.scrollY
    previousScrollRestoration ??= history.scrollRestoration
    history.scrollRestoration = 'manual'
    document.documentElement.style.setProperty('--picker-modal-scroll-y', `${lockedScrollY}px`)
    document.documentElement.classList.add('picker-modal-open')
    document.body.classList.add('picker-modal-open')
  }

  function unlockBackground(): void {
    if (!backgroundLocked) return
    backgroundLocked = false
    const targetScrollY = lockedScrollY
    const restoreGeneration = ++scrollRestoreGeneration
    document.documentElement.classList.remove('picker-modal-open')
    document.body.classList.remove('picker-modal-open')
    document.documentElement.style.removeProperty('--picker-modal-scroll-y')

    const restoreScroll = () => {
      if (backgroundLocked || restoreGeneration !== scrollRestoreGeneration) return
      window.scrollTo(0, targetScrollY)
    }

    // hidePickerView 會還焦點，history traversal 也可能在 MutationObserver 之後
    // 套用瀏覽器自己的捲動位置。立即恢復一次，再跨兩次 paint 校正，才能在
    // 鍵盤、取消按鈕、遮罩與瀏覽器 Back 四種關閉路徑都維持原頁面位置。
    restoreScroll()
    requestAnimationFrame(() => {
      restoreScroll()
      requestAnimationFrame(() => {
        restoreScroll()
        if (backgroundLocked || restoreGeneration !== scrollRestoreGeneration) return
        if (previousScrollRestoration !== null) {
          history.scrollRestoration = previousScrollRestoration
          previousScrollRestoration = null
        }
      })
    })
  }

  function updateStepCopy(): void {
    subtitle.textContent = stepLabel(currentStep(elements))
  }

  function syncOpenState(): void {
    const open = !panel.hidden
    backdrop.hidden = !open
    updateStepCopy()
    if (open) lockBackground()
    else unlockBackground()
  }

  // 先記住觸發前的位置，避免既有 showRoutePicker() 的 scrollIntoView
  // 在 observer 執行前改掉背景捲動；若按鈕沒有真的開啟 picker，下一個
  // microtask 會立刻解除鎖定。
  const prepareOpen = () => {
    lockBackground()
    queueMicrotask(syncOpenState)
  }
  const cancelFromBackdrop = () => closeButton.click()

  addButton.addEventListener('click', prepareOpen, true)
  backdrop.addEventListener('click', cancelFromBackdrop)

  const observer = new MutationObserver((records) => {
    if (records.some((record) => record.attributeName === 'hidden')) syncOpenState()
  })
  observer.observe(panel, { attributes: true, attributeFilter: ['hidden'], subtree: true })

  syncOpenState()

  return () => {
    observer.disconnect()
    addButton.removeEventListener('click', prepareOpen, true)
    backdrop.removeEventListener('click', cancelFromBackdrop)
    subtitle.remove()
    backdrop.remove()
    unlockBackground()
  }
}

installModalStyles()

const panel = document.querySelector<HTMLElement>('#picker-panel')
const toolbar = panel?.querySelector<HTMLElement>('.picker-toolbar') ?? null
const closeButton = document.querySelector<HTMLButtonElement>('#close-picker')
const addButton = document.querySelector<HTMLButtonElement>('#add-board-button')
const routePicker = document.querySelector<HTMLElement>('#route-picker')
const directionStep = document.querySelector<HTMLElement>('#direction-step')
const suggestionStep = document.querySelector<HTMLElement>('#suggestion-step')

if (panel && toolbar && closeButton && addButton && routePicker && directionStep && suggestionStep) {
  enhanceSetupPickerModal({ panel, toolbar, closeButton, addButton, routePicker, directionStep, suggestionStep })
}
