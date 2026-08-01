import { createSettledLiveRegion, type SettledLiveRegionOptions } from '../lib/settled-live-region'

// 狀態列有兩個互相衝突的職責,所以拆成兩個節點:
//
//   可見的 toast  必須立即更新——loading gate 的延遲窗內,它是畫面上唯一
//                「已經收到了」的證據(見 docs/interaction-quality-plan.md §12.4)。
//   宣告          必須延後合併,否則連續導覽會把螢幕閱讀器一句句打斷。
//
// 兩者放在同一個 aria-live 節點上時只能二選一。
export type MapStatus = {
  set(text: string, error?: boolean): void
  /**
   * 只顯示,不朗讀。用於這則訊息已經由 drawer 內的降級通知宣告過的情形——
   * 同一句話讓兩個 live region 各唸一次是重複,不是強調。
   */
  show(text: string, error?: boolean): void
  clear(): void
}

export function createMapStatus(
  node: HTMLElement,
  announcer: HTMLElement,
  options: Omit<SettledLiveRegionOptions, 'node'> = {},
): MapStatus {
  const live = createSettledLiveRegion({ ...options, node: announcer })

  function paint(text: string, error: boolean): void {
    node.textContent = text
    node.classList.remove('dismissed')
    node.classList.toggle('error', error)
    node.removeAttribute('aria-hidden')
  }

  return {
    set(text, error = false) {
      paint(text, error)
      if (error) live.announceNow(text)
      else live.announce(text)
    },

    show(text, error = false) {
      paint(text, error)
      live.clear()
    },

    clear() {
      node.textContent = ''
      node.classList.add('dismissed')
      node.classList.remove('error')
      node.setAttribute('aria-hidden', 'true')
      live.clear()
    },
  }
}
