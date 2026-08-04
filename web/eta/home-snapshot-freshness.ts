const SNAPSHOT_KEY = 'mochi.bus.home-view.v2'
const SNAPSHOT_MAX_AGE_MS = 3 * 60 * 1000
const FUTURE_TOLERANCE_MS = 60 * 1000
const DAY_SECONDS = 24 * 60 * 60

type StorageLike = Pick<Storage, 'getItem' | 'removeItem'>

function taipeiClockSeconds(timestamp: number): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(timestamp))
  const values = new Map(parts.map((part) => [part.type, part.value]))
  const hour = Number(values.get('hour'))
  const minute = Number(values.get('minute'))
  const second = Number(values.get('second'))
  if (![hour, minute, second].every(Number.isFinite)) return 0
  return hour * 60 * 60 + minute * 60 + second
}

function updatedClockSeconds(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const match = value.match(/(?:^|\s)(\d{1,2}):(\d{2}):(\d{2})(?:\s|$)/)
  if (!match) return null
  let hour = Number(match[1])
  const minute = Number(match[2])
  const second = Number(match[3])
  if (hour === 24) hour = 0
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null
  if (!Number.isInteger(second) || second < 0 || second > 59) return null
  return hour * 60 * 60 + minute * 60 + second
}

/**
 * Reconstruct the ETA source time from the visible `資料 HH:mm:ss` label and
 * the capture time. Re-capturing unchanged DOM therefore does not renew old ETA.
 */
export function homeSnapshotSourceTimestamp(raw: string | null): number | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as { savedAt?: unknown; updatedText?: unknown }
    if (typeof value.savedAt !== 'number' || !Number.isFinite(value.savedAt)) return null
    const sourceClock = updatedClockSeconds(value.updatedText)
    if (sourceClock === null) return null

    const capturedClock = taipeiClockSeconds(value.savedAt)
    let ageSeconds = capturedClock - sourceClock
    if (ageSeconds < -60) ageSeconds += DAY_SECONDS
    if (ageSeconds < 0) ageSeconds = 0
    return value.savedAt - ageSeconds * 1000
  } catch {
    return null
  }
}

export function homeSnapshotSourceIsFresh(
  raw: string | null,
  now = Date.now(),
): boolean {
  const sourceTimestamp = homeSnapshotSourceTimestamp(raw)
  if (sourceTimestamp === null) return false
  return now - sourceTimestamp <= SNAPSHOT_MAX_AGE_MS
    && sourceTimestamp - now <= FUTURE_TOLERANCE_MS
}

export function discardStaleHomeSnapshot(options: {
  storage?: StorageLike
  now?: number
} = {}): boolean {
  const storage = options.storage ?? window.sessionStorage
  let raw: string | null = null
  try {
    raw = storage.getItem(SNAPSHOT_KEY)
  } catch {
    return false
  }
  const fresh = homeSnapshotSourceIsFresh(raw, options.now)
  if (!fresh && raw !== null) storage.removeItem(SNAPSHOT_KEY)
  return fresh
}
