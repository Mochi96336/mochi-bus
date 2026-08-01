// Skeleton 的顯示時機閘。只有一個門檻:
//
//   delayMs  快請求根本不該閃過 skeleton。邊緣快取命中常在 50ms 內回來,
//            立刻換上 skeleton 只會製造一次多餘的畫面跳動。
//
// 曾經還有一個 minVisibleMs(skeleton 一旦出現就撐滿最短存續時間),已移除。
// 它是用「延後真實內容」換「不要閃一下」,而抽屜現在會平滑過渡高度,閃一下
// 的代價比當初低得多;相對地,讓已經到手的資料多等 300ms 才上畫面是實打實
// 的變慢。真要壓抖動應該調 delayMs,不是把結果扣住。
//
// 這裡只管 skeleton 的顯示時機。「哪一個請求算數」仍歸呼叫端既有的機制
// (NavRequestCoordinator、各 controller 的 generation);abort() 是用來清掉
// 這個 gate 自己排的計時器,不是用來仲裁 staleness。
export type LoadingGateOptions = {
  /** 低於此時間完成就完全不顯示 skeleton,預設 120ms。 */
  delayMs?: number
  showLoading: () => void
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  cancelSchedule?: (timer: ReturnType<typeof setTimeout>) => void
}

export type LoadingGate = {
  start(): void
  /** 資料到手就立刻交接,不論 skeleton 已經顯示多久。 */
  settle(render: () => void): void
  /** 清掉所有排程;已排入但還沒執行的 skeleton 不會出現。 */
  abort(): void
}

const DEFAULT_DELAY_MS = 120

export function createLoadingGate(options: LoadingGateOptions): LoadingGate {
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS
  const schedule = options.schedule ?? ((callback, ms) => setTimeout(callback, ms))
  const cancelSchedule = options.cancelSchedule ?? clearTimeout

  let timer: ReturnType<typeof setTimeout> | undefined

  function reset(): void {
    if (timer === undefined) return
    cancelSchedule(timer)
    timer = undefined
  }

  return {
    start() {
      // 計時器歸屬呼叫端的 generation,不是 DrawerViewSession:在 0–delayMs
      // 的延遲窗內還沒 render,根本還沒有新的 session 存在。
      reset()
      timer = schedule(() => {
        timer = undefined
        options.showLoading()
      }, delayMs)
    },

    settle(render) {
      reset()
      render()
    },

    abort: reset,
  }
}

/**
 * Gate 加上「記住這一輪要拿什麼參數畫 skeleton」。因為 skeleton 是延後才畫的,
 * 呼叫端不能在 start() 當下就渲染,只能把參數交出去等 gate 決定。
 */
export type LoadingHandoff<T> = {
  start(value: T): void
  settle(render: () => void): void
  abort(): void
}

export function createLoadingHandoff<T>(
  showLoading: (value: T) => void,
  options: Omit<LoadingGateOptions, 'showLoading'> = {},
): LoadingHandoff<T> {
  let pending: T | undefined
  const gate = createLoadingGate({
    ...options,
    showLoading: () => {
      if (pending !== undefined) showLoading(pending)
    },
  })
  return {
    start(value) {
      pending = value
      gate.start()
    },
    settle: gate.settle,
    abort: gate.abort,
  }
}
