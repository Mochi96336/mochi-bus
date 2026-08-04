const RETURN_HOME_KEY = 'mochi.bus.return-home.v2'
const RETURN_HOME_MAX_AGE_MS = 30 * 60 * 1000
const RETURN_TOKEN_STATE_KEY = '__mochiReturnHomeToken'
const RETURN_DEPTH_STATE_KEY = '__mochiReturnHomeDepth'
const RETURN_HISTORY_PATCH_FLAG = '__mochiReturnHomeHistoryPatched'
const SECONDARY_PATHS = new Set(['/map', '/setup'])

export type ReturnHomeMarker = {
  version: 2
  sourcePath: '/'
  targetPath: '/map' | '/setup'
  token: string
  createdAt: number
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

type HistoryLike = Pick<History, 'state' | 'go' | 'pushState' | 'replaceState'> & {
  [RETURN_HISTORY_PATCH_FLAG]?: boolean
}

type ReturnHomeEnvironment = {
  storage: StorageLike
  now: () => number
  location: Pick<Location, 'href' | 'origin' | 'pathname'>
  history: HistoryLike
}

function defaultEnvironment(): ReturnHomeEnvironment {
  return {
    storage: window.sessionStorage,
    now: Date.now,
    location: window.location,
    history: window.history,
  }
}

export function parseReturnHomeMarker(
  raw: string | null,
  now = Date.now(),
): ReturnHomeMarker | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<ReturnHomeMarker>
    if (value.version !== 2) return null
    if (value.sourcePath !== '/') return null
    if (value.targetPath !== '/map' && value.targetPath !== '/setup') return null
    if (typeof value.token !== 'string' || value.token.length < 8) return null
    if (typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)) return null
    if (now - value.createdAt > RETURN_HOME_MAX_AGE_MS || value.createdAt - now > 60_000) return null
    return value as ReturnHomeMarker
  } catch {
    return null
  }
}

function historyRecord(state: unknown): Record<string, unknown> {
  return state && typeof state === 'object' && !Array.isArray(state)
    ? state as Record<string, unknown>
    : {}
}

function returnDepth(state: unknown, token: string): number | null {
  const record = historyRecord(state)
  if (record[RETURN_TOKEN_STATE_KEY] !== token) return null
  const depth = record[RETURN_DEPTH_STATE_KEY]
  return Number.isInteger(depth) && (depth as number) >= 0 ? depth as number : null
}

function withReturnDepth(state: unknown, token: string, depth: number): Record<string, unknown> {
  return {
    ...historyRecord(state),
    [RETURN_TOKEN_STATE_KEY]: token,
    [RETURN_DEPTH_STATE_KEY]: Math.max(0, Math.trunc(depth)),
  }
}

export function returnHomeDelta(
  marker: ReturnHomeMarker,
  currentPath: string,
  currentState: unknown,
): number | null {
  if (currentPath !== marker.targetPath) return null
  const depth = returnDepth(currentState, marker.token)
  return depth && depth > 0 ? -depth : null
}

function readMarker(environment: ReturnHomeEnvironment): ReturnHomeMarker | null {
  const marker = parseReturnHomeMarker(
    environment.storage.getItem(RETURN_HOME_KEY),
    environment.now(),
  )
  if (!marker) environment.storage.removeItem(RETURN_HOME_KEY)
  return marker
}

function writeMarker(environment: ReturnHomeEnvironment, marker: ReturnHomeMarker): void {
  try {
    environment.storage.setItem(RETURN_HOME_KEY, JSON.stringify(marker))
  } catch {
    // Private browsing / exhausted storage must never break navigation.
  }
}

function navigationToken(): string {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function sameOriginUrl(anchor: HTMLAnchorElement): URL | null {
  try {
    const url = new URL(anchor.href, window.location.href)
    return url.origin === window.location.origin ? url : null
  } catch {
    return null
  }
}

function isPlainPrimaryActivation(event: MouseEvent, anchor: HTMLAnchorElement): boolean {
  return event.button === 0
    && !event.metaKey
    && !event.ctrlKey
    && !event.shiftKey
    && !event.altKey
    && !anchor.download
    && (!anchor.target || anchor.target === '_self')
}

function installLeavingLayoutFreeze(): void {
  const root = document.documentElement
  if (root.dataset.mochiLayoutFreezeInstalled === 'true') return
  root.dataset.mochiLayoutFreezeInstalled = 'true'

  const style = document.createElement('style')
  style.id = 'mochi-navigation-stability'
  style.textContent = `
html[data-mochi-page-leaving="true"] body {
  width: var(--mochi-stable-layout-width);
  min-width: var(--mochi-stable-layout-width);
  max-width: var(--mochi-stable-layout-width);
  overflow-x: hidden;
}
`
  document.head.appendChild(style)

  const rememberWidth = () => {
    root.style.setProperty('--mochi-stable-layout-width', `${root.clientWidth}px`)
  }
  rememberWidth()
  window.addEventListener('pageshow', () => {
    root.removeAttribute('data-mochi-page-leaving')
    rememberWidth()
  })
  window.addEventListener('orientationchange', () => setTimeout(rememberWidth, 200))
}

function freezeLeavingLayout(): void {
  document.documentElement.style.setProperty(
    '--mochi-stable-layout-width',
    `${document.documentElement.clientWidth}px`,
  )
  document.documentElement.dataset.mochiPageLeaving = 'true'
}

/**
 * Installs before page-specific history wrappers. Every actual push increments
 * the distance from home; replace keeps it. Map's history compression can then
 * wrap these methods and still preserve an exact return distance.
 */
function installReturnDepthTracking(
  marker: ReturnHomeMarker,
  environment: ReturnHomeEnvironment,
): void {
  const managed = environment.history
  if (managed[RETURN_HISTORY_PATCH_FLAG]) return

  const nativePushState = managed.pushState.bind(managed)
  const nativeReplaceState = managed.replaceState.bind(managed)
  Object.defineProperty(managed, RETURN_HISTORY_PATCH_FLAG, { value: true })

  const landedDepth = returnDepth(managed.state, marker.token) ?? 1
  nativeReplaceState(withReturnDepth(managed.state, marker.token, landedDepth), '', environment.location.href)

  managed.pushState = (data: unknown, unused: string, url?: string | URL | null) => {
    const depth = returnDepth(managed.state, marker.token) ?? 1
    nativePushState(withReturnDepth(data, marker.token, depth + 1), unused, url)
  }
  managed.replaceState = (data: unknown, unused: string, url?: string | URL | null) => {
    const depth = returnDepth(managed.state, marker.token) ?? 1
    nativeReplaceState(withReturnDepth(data, marker.token, depth), unused, url)
  }
}

/**
 * Home owns the source history entry. Secondary pages can then return to that
 * exact entry instead of creating a new home document and replaying skeletons.
 */
export function installHomeDepartureTracking(
  environment: ReturnHomeEnvironment = defaultEnvironment(),
): () => void {
  installLeavingLayoutFreeze()
  // Keep a valid marker while the original home entry is active. This lets a
  // browser Forward back into the same map/setup document retain its exact
  // return path. A genuinely new home document has no matching source token,
  // so stale navigation state is cleared immediately.
  const existingMarker = readMarker(environment)
  const existingSourceDepth = existingMarker
    ? returnDepth(environment.history.state, existingMarker.token)
    : null
  if (!existingMarker || existingSourceDepth !== 0) {
    environment.storage.removeItem(RETURN_HOME_KEY)
  }

  const onClick = (event: MouseEvent) => {
    const target = event.target
    if (!(target instanceof Element)) return
    const anchor = target.closest<HTMLAnchorElement>('a[href]')
    if (!anchor || !isPlainPrimaryActivation(event, anchor)) return
    const url = sameOriginUrl(anchor)
    if (!url || !SECONDARY_PATHS.has(url.pathname)) return

    const marker: ReturnHomeMarker = {
      version: 2,
      sourcePath: '/',
      targetPath: url.pathname as ReturnHomeMarker['targetPath'],
      token: navigationToken(),
      createdAt: environment.now(),
    }
    environment.history.replaceState(
      withReturnDepth(environment.history.state, marker.token, 0),
      '',
      environment.location.href,
    )
    writeMarker(environment, marker)
    freezeLeavingLayout()
  }

  document.addEventListener('click', onClick, true)
  return () => document.removeEventListener('click', onClick, true)
}

/**
 * Installs on /map and /setup. Any matching home link skips all history states
 * created inside that page and lands on the original home entry in one step.
 */
export function installReturnHomeNavigation(
  selector: string,
  environment: ReturnHomeEnvironment = defaultEnvironment(),
): () => void {
  installLeavingLayoutFreeze()
  const marker = readMarker(environment)
  if (marker && marker.targetPath === environment.location.pathname) {
    installReturnDepthTracking(marker, environment)
  }

  const onClick = (event: MouseEvent) => {
    const target = event.target
    if (!(target instanceof Element)) return
    const anchor = target.closest<HTMLAnchorElement>(selector)
    if (!anchor || !isPlainPrimaryActivation(event, anchor)) return
    const url = sameOriginUrl(anchor)
    if (!url || url.pathname !== '/') return

    const currentMarker = readMarker(environment)
    if (!currentMarker) return
    const delta = returnHomeDelta(currentMarker, environment.location.pathname, environment.history.state)
    if (delta === null) return

    event.preventDefault()
    freezeLeavingLayout()
    environment.history.go(delta)
  }

  document.addEventListener('click', onClick, true)
  return () => document.removeEventListener('click', onClick, true)
}

export function clearReturnHomeMarker(
  environment: Pick<ReturnHomeEnvironment, 'storage'> = { storage: window.sessionStorage },
): void {
  environment.storage.removeItem(RETURN_HOME_KEY)
}
