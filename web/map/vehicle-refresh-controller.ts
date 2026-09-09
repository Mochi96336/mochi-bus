export const VEHICLE_REFRESH_INTERVAL_MS = 20_000

type TimerHandle = unknown

export type VehicleRefreshSession<Route> = {
  cityCode: string
  route: Route
}

type VehicleRefreshOptions<Route, Response> = {
  load: (cityCode: string, route: Route, signal: AbortSignal) => Promise<Response>
  isActive: (session: VehicleRefreshSession<Route>) => boolean
  onResponse: (response: Response) => void
  onError: (error: unknown) => void
  onStop: () => void
  intervalMs?: number
  setInterval?: (callback: () => void, intervalMs: number) => TimerHandle
  clearInterval?: (handle: TimerHandle) => void
  createAbortController?: () => AbortController
  isVisible?: () => boolean
  subscribeVisibility?: (callback: () => void) => () => void
}

export type VehicleRefreshController<Route> = {
  start: (session: VehicleRefreshSession<Route>) => void
  refresh: () => Promise<void>
  stop: () => void
}

/**
 * Owns the timer, request cancellation, page visibility and stale-session checks
 * for live vehicle positions. Hidden tabs keep no polling timer and abort an
 * active request; returning to the foreground refreshes immediately.
 * Rendering remains outside this controller so Leaflet and drawer side effects
 * stay in the map entry layer.
 */
export function createVehicleRefreshController<Route, Response>(
  options: VehicleRefreshOptions<Route, Response>,
): VehicleRefreshController<Route> {
  const intervalMs = options.intervalMs ?? VEHICLE_REFRESH_INTERVAL_MS
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error('Vehicle refresh interval must be a positive finite number')
  }

  const setIntervalFn = options.setInterval
    ?? ((callback, delayMs) => globalThis.setInterval(callback, delayMs))
  const clearIntervalFn = options.clearInterval
    ?? ((handle) => globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>))
  const createAbortController = options.createAbortController ?? (() => new AbortController())
  const isVisible = options.isVisible
    ?? (() => typeof document === 'undefined' || document.visibilityState === 'visible')
  const subscribeVisibility = options.subscribeVisibility ?? ((callback) => {
    if (typeof document === 'undefined') return () => {}
    document.addEventListener('visibilitychange', callback)
    return () => document.removeEventListener('visibilitychange', callback)
  })

  let timer: TimerHandle | undefined
  let epoch = 0
  let session: VehicleRefreshSession<Route> | undefined
  let activeAbortController: AbortController | undefined
  let unsubscribeVisibility: (() => void) | undefined

  function clearScheduled(): void {
    if (timer === undefined) return
    clearIntervalFn(timer)
    timer = undefined
  }

  function schedule(): void {
    if (timer !== undefined || !session || !isVisible()) return
    timer = setIntervalFn(() => void refresh(), intervalMs)
  }

  function abortActive(): void {
    activeAbortController?.abort()
    activeAbortController = undefined
  }

  async function refresh(): Promise<void> {
    const currentSession = session
    const currentEpoch = epoch
    if (!currentSession || !isVisible() || !options.isActive(currentSession)) return

    abortActive()
    const abortController = createAbortController()
    activeAbortController = abortController

    try {
      const response = await options.load(
        currentSession.cityCode,
        currentSession.route,
        abortController.signal,
      )
      if (
        abortController.signal.aborted
        || epoch !== currentEpoch
        || session !== currentSession
        || !isVisible()
        || !options.isActive(currentSession)
      ) return
      options.onResponse(response)
    } catch (error) {
      if (
        !abortController.signal.aborted
        && epoch === currentEpoch
        && session === currentSession
        && isVisible()
        && options.isActive(currentSession)
      ) options.onError(error)
    } finally {
      if (activeAbortController === abortController) activeAbortController = undefined
    }
  }

  function visibilityChanged(): void {
    if (!session) return
    if (!isVisible()) {
      clearScheduled()
      abortActive()
      return
    }
    void refresh()
    schedule()
  }

  function stop(): void {
    epoch += 1
    session = undefined
    abortActive()
    clearScheduled()
    unsubscribeVisibility?.()
    unsubscribeVisibility = undefined
    options.onStop()
  }

  return {
    start(nextSession) {
      stop()
      session = nextSession
      unsubscribeVisibility = subscribeVisibility(visibilityChanged)
      if (!isVisible()) return
      void refresh()
      schedule()
    },
    refresh,
    stop,
  }
}
