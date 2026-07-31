// Skeleton 的顯示時機閘。兩個門檻各解一個問題:
//
//   delayMs      快請求根本不該閃過 skeleton。邊緣快取命中常在 50ms 內回來,
//                立刻換上 skeleton 只會製造一次多餘的畫面跳動。
//   minVisibleMs skeleton 一旦出現就不能只活幾十毫秒。出現又立刻消失比
//                從頭到尾不出現更像故障。
//
// 最壞情況總延遲 = delayMs + minVisibleMs。
//
// 這裡只管 skeleton 的顯示時機。「哪一個請求算數」仍歸呼叫端既有的機制
// (NavRequestCoordinator、各 controller 的 generation);abort() 是用來清掉
// 這個 gate 自己排的計時器,不是用來仲裁 staleness。
export type LoadingGateOptions = {
  /** 低於此時間完成就完全不顯示 skeleton,預設 120ms。 */
  delayMs?: number
  /** skeleton 一旦顯示的最短存續時間,預設 300ms。 */
  minVisibleMs?: number
  showLoading: () => void
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  cancelSchedule?: (timer: ReturnType<typeof setTimeout>) => void
  now?: () => number
}

export type LoadingGate = {
  start(): void
  /** render 會在滿足最短顯示時間後執行。 */
  settle(render: () => void): void
  /** 清掉所有排程;已排入但還沒執行的 render 不會執行。 */
  abort(): void
}

const DEFAULT_DELAY_MS = 120
const DEFAULT_MIN_VISIBLE_MS = 300

export function createLoadingGate(options: LoadingGateOptions): LoadingGate {
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS
  const minVisibleMs = options.minVisibleMs ?? DEFAULT_MIN_VISIBLE_MS
  const schedule = options.schedule ?? ((callback, ms) => setTimeout(callback, ms))
  const cancelSchedule = options.cancelSchedule ?? clearTimeout
  const now = options.now ?? (() => Date.now())

  let timer: ReturnType<typeof setTimeout> | undefined
  let shownAt: number | undefined

  function clearTimer(): void {
    if (timer === undefined) return
    cancelSchedule(timer)
    timer = undefined
  }

  function reset(): void {
    clearTimer()
    shownAt = undefined
  }

  return {
    start() {
      // 計時器歸屬呼叫端的 generation,不是 DrawerViewSession:在 0–delayMs
      // 的延遲窗內還沒 render,根本還沒有新的 session 存在。
      reset()
      timer = schedule(() => {
        timer = undefined
        shownAt = now()
        options.showLoading()
      }, delayMs)
    },

    settle(render) {
      if (shownAt === undefined) {
        // 還在延遲窗內(或這一輪根本沒開過 gate):skeleton 從未出現,直接交接。
        reset()
        render()
        return
      }
      const remaining = minVisibleMs - (now() - shownAt)
      if (remaining <= 0) {
        reset()
        render()
        return
      }
      clearTimer()
      timer = schedule(() => {
        reset()
        render()
      }, remaining)
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
