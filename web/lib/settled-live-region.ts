// 地圖狀態在連續操作下會一句蓋一句:選縣市、載目錄、點站牌、讀路線,
// 每一步都寫一次狀態。逐句朗讀只會讓螢幕閱讀器不斷被打斷,使用者聽不完
// 任何一句。改成等最後一個狀態穩定下來再唸。
//
// 錯誤走 announceNow:出錯時使用者需要立刻知道,不能為了合併而延後。
export type SettledLiveRegionOptions = {
  node: HTMLElement
  /** 連續變動時等最後一個狀態穩定多久才朗讀,預設 600ms。 */
  settleMs?: number
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  cancelSchedule?: (timer: ReturnType<typeof setTimeout>) => void
}

export type SettledLiveRegion = {
  announce(message: string): void
  announceNow(message: string): void
  clear(): void
  dispose(): void
}

const DEFAULT_SETTLE_MS = 600

export function createSettledLiveRegion(options: SettledLiveRegionOptions): SettledLiveRegion {
  const { node } = options
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS
  const schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs))
  const cancelSchedule = options.cancelSchedule ?? clearTimeout

  let timer: ReturnType<typeof setTimeout> | undefined

  function cancel(): void {
    if (timer === undefined) return
    cancelSchedule(timer)
    timer = undefined
  }

  // 把同一句話再寫一次仍然是 DOM 變動,部分螢幕閱讀器會照唸不誤。
  function write(message: string): void {
    if (node.textContent === message) return
    node.textContent = message
  }

  return {
    announce(message) {
      cancel()
      timer = schedule(() => {
        timer = undefined
        write(message)
      }, settleMs)
    },

    announceNow(message) {
      cancel()
      write(message)
    },

    clear() {
      cancel()
      write('')
    },

    dispose: cancel,
  }
}
