import { parseReturnHomeMarker } from './return-home'

const RETURN_HOME_KEY = 'mochi.bus.return-home.v2'
const RETURN_TOKEN_STATE_KEY = '__mochiReturnHomeToken'

type StorageLike = Pick<Storage, 'getItem' | 'removeItem'>

type ReturnHomeEntryOptions = {
  raw: string | null
  currentPath: string
  state: unknown
  historyLength: number
  referrer: string
  origin: string
  now?: number
}

function historyToken(state: unknown): string | null {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return null
  const token = (state as Record<string, unknown>)[RETURN_TOKEN_STATE_KEY]
  return typeof token === 'string' ? token : null
}

export function returnHomeEntryIsTrusted(options: ReturnHomeEntryOptions): boolean {
  const marker = parseReturnHomeMarker(options.raw, options.now)
  if (!marker || marker.targetPath !== options.currentPath) return false
  if (historyToken(options.state) === marker.token) return true

  // A new tab may inherit sessionStorage and document.referrer from the opener,
  // but it has no previous home entry to return to. Only trust the referrer path
  // when this browsing context actually has an earlier history entry.
  if (!Number.isInteger(options.historyLength) || options.historyLength <= 1) return false
  try {
    const referrer = new URL(options.referrer)
    return referrer.origin === options.origin && referrer.pathname === marker.sourcePath
  } catch {
    return false
  }
}

/**
 * A session marker alone does not prove that this map/setup document came from
 * the tracked home entry. Reload/Forward carry the token in history.state;
 * a fresh cross-document navigation must carry a same-origin home referrer and
 * an actual earlier history entry in this browsing context.
 */
export function discardUntrustedReturnHomeEntry(options: {
  storage?: StorageLike
  currentPath?: string
  state?: unknown
  historyLength?: number
  referrer?: string
  origin?: string
  now?: number
} = {}): boolean {
  const storage = options.storage ?? window.sessionStorage
  let raw: string | null = null
  try {
    raw = storage.getItem(RETURN_HOME_KEY)
  } catch {
    return false
  }

  const trusted = returnHomeEntryIsTrusted({
    raw,
    currentPath: options.currentPath ?? window.location.pathname,
    state: options.state ?? window.history.state,
    historyLength: options.historyLength ?? window.history.length,
    referrer: options.referrer ?? document.referrer,
    origin: options.origin ?? window.location.origin,
    now: options.now,
  })
  if (!trusted) storage.removeItem(RETURN_HOME_KEY)
  return trusted
}
