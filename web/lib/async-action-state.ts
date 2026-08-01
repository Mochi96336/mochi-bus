// 非同步按鈕的可見狀態機:idle → pending → success/error → idle。
//
// 這裡只管按鈕外觀與宣告。請求取消與過期判定仍歸呼叫端既有的機制
// (NavRequestCoordinator、各 controller 的 generation),不在此另造一套世代,
// 否則同一個畫面會有兩套 staleness 判斷互相打架。
//
// 存在的首要理由不是文字狀態,而是「pending 一定會結束」:呼叫端各自用
// button.disabled 當互斥鎖卻忘了 try/finally 時,一次例外就會讓按鈕永久卡住。
export type AsyncActionPhase = 'idle' | 'pending' | 'success' | 'error'

export type AsyncActionLabels = {
  idle: string
  pending: string
  /** 省略即為 pending-only:結束後直接回 idle,不排任何倒數。 */
  success?: string
  error?: string
}

export type AsyncActionOptions = {
  button: HTMLButtonElement
  labels: AsyncActionLabels
  /** success / error 的停留時間,預設 1200ms。 */
  settleMs?: number
  /** 寫入呼叫端自己的 status 節點;回到 idle 時會收到空字串以便清除。 */
  announce?: (message: string) => void
  /**
   * aria-busy 的掛載對象,預設不設。
   * 按鈕在 pending 期間仍可互動時才掛在按鈕上;按鈕會被 disabled 時,
   * disabled 已經把它移出 AT 的互動模型,busy 應該指向內容正在變動的區域。
   */
  busyTarget?: HTMLElement
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  cancelSchedule?: (timer: ReturnType<typeof setTimeout>) => void
}

/**
 * skipped 與 rejected 必須可分辨:「因為還在 pending 所以沒跑」和「跑了但失敗」
 * 是兩件事,呼叫端的處理也不同。例外的 reason 一律原樣交還,不得吞成 undefined
 * ——renderer bug 是真的應用程式失敗,不能被偽裝成沒事發生。
 */
export type AsyncActionResult<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; reason: unknown }
  | { status: 'skipped' }

export type AsyncActionRunOptions = {
  /** 自動更新用:成功時不改 label、不宣告。失敗仍照常呈現。 */
  quiet?: boolean
}

export type AsyncAction = {
  run<T>(task: () => Promise<T>, options?: AsyncActionRunOptions): Promise<AsyncActionResult<T>>
  phase(): AsyncActionPhase
  dispose(): void
}

const DEFAULT_SETTLE_MS = 1200

export function createAsyncAction(options: AsyncActionOptions): AsyncAction {
  const { button, labels, busyTarget, announce } = options
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS
  const schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs))
  const cancelSchedule = options.cancelSchedule ?? clearTimeout

  let phase: AsyncActionPhase = 'idle'
  let settleTimer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  function clearSettle(): void {
    if (settleTimer === undefined) return
    cancelSchedule(settleTimer)
    settleTimer = undefined
  }

  // Drawer 換 view 會 replaceChildren,舊按鈕當場 detached。殘留的倒數回呼
  // 仍可能觸發,此時所有 DOM 寫入都跳過。(手刻測試替身沒有 isConnected,視為可寫。)
  function writable(): boolean {
    return !disposed && button.isConnected !== false
  }

  function labelFor(next: AsyncActionPhase): string {
    if (next === 'pending') return labels.pending
    if (next === 'success') return labels.success ?? labels.idle
    if (next === 'error') return labels.error ?? labels.idle
    return labels.idle
  }

  function paint(next: AsyncActionPhase, message?: string): void {
    phase = next
    if (!writable()) return
    button.disabled = next === 'pending'
    button.textContent = labelFor(next)
    if (busyTarget) {
      if (next === 'pending') busyTarget.setAttribute('aria-busy', 'true')
      else busyTarget.removeAttribute('aria-busy')
    }
    if (message !== undefined) announce?.(message)
  }

  function settleLabel(outcome: 'success' | 'error', quiet: boolean): string | undefined {
    // quiet 抑制的是成功回饋,不是失敗:自動更新裡的 renderer bug 若也靜默,
    // 就等於把「按鈕卡死」換成「卡死但沒人知道」。
    if (quiet && outcome === 'success') return undefined
    return outcome === 'success' ? labels.success : labels.error
  }

  function finish(outcome: 'success' | 'error', quiet: boolean): void {
    const label = settleLabel(outcome, quiet)
    if (label === undefined) {
      paint('idle', '')
      return
    }
    paint(outcome, label)
    settleTimer = schedule(() => {
      settleTimer = undefined
      paint('idle', '')
    }, settleMs)
  }

  return {
    async run<T>(task: () => Promise<T>, runOptions?: AsyncActionRunOptions): Promise<AsyncActionResult<T>> {
      if (disposed || phase === 'pending') return { status: 'skipped' }
      clearSettle()
      paint('pending')
      const quiet = runOptions?.quiet === true
      // try/finally 的實質:task 無論同步拋出、非同步 reject 或正常完成,
      // 都一定會離開 pending。這是本模組的核心保證。
      try {
        const value = await task()
        finish('success', quiet)
        return { status: 'fulfilled', value }
      } catch (reason) {
        finish('error', quiet)
        return { status: 'rejected', reason }
      }
    },

    phase: () => phase,

    dispose() {
      disposed = true
      clearSettle()
    },
  }
}
