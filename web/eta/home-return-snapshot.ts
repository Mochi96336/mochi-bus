import { busKey, migrateBoards, resolveHomeBoard } from '../boards/store'

const SNAPSHOT_KEY = 'mochi.bus.home-view.v2'
const SNAPSHOT_MAX_AGE_MS = 3 * 60 * 1000
const ALLOWED_ETA_CLASSES = new Set(['estimated', 'urgent', 'non-numeric'])

type SnapshotNoticePart =
  | { kind: 'text'; value: string }
  | { kind: 'setup-link'; value: string }

export type HomeViewSnapshotRow = {
  key: string
  href: string
  routeName: string
  directionLabel: string
  eta: {
    classes: string[]
    ariaLabel: string
    signature: string
    prefix: string
    value: string
    suffix: string
    freshness: string
  }
}

export type HomeViewSnapshot = {
  version: 2
  savedAt: number
  boardFingerprint: string
  title: string
  rows: HomeViewSnapshotRow[]
  updatedText: string
  notice: SnapshotNoticePart[]
}

function boardFingerprint(): string | null {
  const board = resolveHomeBoard(migrateBoards())
  if (!board) return null
  return JSON.stringify({
    id: board.id,
    title: board.title,
    city: board.city,
    placeId: board.placeId,
    updatedAt: board.updatedAt,
    buses: board.buses.map((bus) => busKey(bus)),
  })
}

function boundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length <= maxLength
}

function validSnapshotHref(value: unknown): value is string {
  if (!boundedString(value, 2_048)) return false
  return value === '#' || value === '/route' || value.startsWith('/route?')
}

function validNoticePart(value: unknown): value is SnapshotNoticePart {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const part = value as Partial<SnapshotNoticePart>
  return (part.kind === 'text' && boundedString(part.value, 2_000))
    || (part.kind === 'setup-link' && boundedString(part.value, 120))
}

function validSnapshotRow(value: unknown): value is HomeViewSnapshotRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Partial<HomeViewSnapshotRow>
  if (!boundedString(row.key, 2_048) || !row.key || !validSnapshotHref(row.href)) return false
  if (!boundedString(row.routeName, 240) || !boundedString(row.directionLabel, 500)) return false
  if (!row.eta || typeof row.eta !== 'object' || Array.isArray(row.eta)) return false
  const eta = row.eta as Partial<HomeViewSnapshotRow['eta']>
  if (!Array.isArray(eta.classes)
    || eta.classes.length > ALLOWED_ETA_CLASSES.size
    || !eta.classes.every((name) => typeof name === 'string' && ALLOWED_ETA_CLASSES.has(name))) return false
  return boundedString(eta.ariaLabel, 500)
    && boundedString(eta.signature, 1_000)
    && boundedString(eta.prefix, 120)
    && boundedString(eta.value, 240)
    && boundedString(eta.suffix, 120)
    && boundedString(eta.freshness, 120)
}

export function parseHomeViewSnapshot(
  raw: string | null,
  fingerprint: string | null,
  now = Date.now(),
): HomeViewSnapshot | null {
  if (!raw || !fingerprint) return null
  try {
    const value = JSON.parse(raw) as Partial<HomeViewSnapshot>
    if (value.version !== 2 || value.boardFingerprint !== fingerprint) return null
    if (typeof value.savedAt !== 'number' || !Number.isFinite(value.savedAt)) return null
    if (now - value.savedAt > SNAPSHOT_MAX_AGE_MS || value.savedAt - now > 60_000) return null
    if (!boundedString(value.title, 500) || !boundedString(value.updatedText, 500)) return null
    if (!Array.isArray(value.rows) || !value.rows.length || value.rows.length > 100) return null
    if (!value.rows.every(validSnapshotRow)) return null
    if (!Array.isArray(value.notice) || value.notice.length > 20 || !value.notice.every(validNoticePart)) return null
    return value as HomeViewSnapshot
  } catch {
    return null
  }
}

function readSnapshot(): HomeViewSnapshot | null {
  const fingerprint = boardFingerprint()
  try {
    const snapshot = parseHomeViewSnapshot(
      sessionStorage.getItem(SNAPSHOT_KEY),
      fingerprint,
    )
    if (!snapshot) sessionStorage.removeItem(SNAPSHOT_KEY)
    return snapshot
  } catch {
    return null
  }
}

function appendTextElement(
  parent: HTMLElement,
  className: string,
  text: string,
): HTMLElement | null {
  if (!text) return null
  const element = document.createElement(className === 'eta-freshness' ? 'small' : 'span')
  element.className = className
  element.textContent = text
  parent.appendChild(element)
  return element
}

function rowFromSnapshot(row: HomeViewSnapshotRow): HTMLAnchorElement {
  const anchor = document.createElement('a')
  anchor.className = 'bus-row'
  anchor.dataset.busKey = row.key
  anchor.href = row.href

  const routeCopy = document.createElement('span')
  routeCopy.className = 'bus-route-copy'
  const route = document.createElement('strong')
  route.className = 'bus-name'
  route.textContent = row.routeName
  routeCopy.appendChild(route)

  const eta = document.createElement('span')
  eta.className = ['bus-eta', ...row.eta.classes].join(' ')
  eta.dataset.signature = row.eta.signature
  eta.setAttribute('aria-label', row.eta.ariaLabel)
  const etaCopy = document.createElement('span')
  etaCopy.className = 'eta-copy'
  appendTextElement(etaCopy, 'eta-prefix', row.eta.prefix)
  appendTextElement(etaCopy, 'eta-value', row.eta.value)
  appendTextElement(etaCopy, 'eta-suffix', row.eta.suffix)
  appendTextElement(etaCopy, 'eta-freshness', row.eta.freshness)
  eta.appendChild(etaCopy)

  const direction = document.createElement('small')
  direction.className = 'bus-direction'
  direction.textContent = row.directionLabel
  direction.hidden = !row.directionLabel
  anchor.replaceChildren(routeCopy, eta, direction)
  return anchor
}

function restoreNotice(
  notice: HTMLParagraphElement,
  parts: SnapshotNoticePart[],
): void {
  const nodes = parts.map((part): Node => {
    if (part.kind === 'text') return document.createTextNode(part.value)
    const link = document.createElement('a')
    link.href = '/setup'
    link.textContent = part.value
    return link
  })
  notice.replaceChildren(...nodes)
}

function restoreSnapshotDOM(snapshot: HomeViewSnapshot): boolean {
  const title = document.querySelector<HTMLHeadingElement>('#board-title')
  const list = document.querySelector<HTMLDivElement>('#bus-list')
  const updated = document.querySelector<HTMLSpanElement>('#updated')
  const notice = document.querySelector<HTMLParagraphElement>('#notice')
  if (!title || !list || !updated || !notice) return false

  title.textContent = snapshot.title
  list.replaceChildren(...snapshot.rows.map(rowFromSnapshot))
  list.removeAttribute('aria-busy')
  updated.textContent = snapshot.updatedText
  restoreNotice(notice, snapshot.notice)
  document.documentElement.dataset.mochiHomeSnapshot = 'restored'
  return true
}

/** Runs before eta/main so a restored document never has to paint the SSR skeleton. */
export function restoreHomeViewBeforeMain(): HomeViewSnapshot | null {
  const snapshot = readSnapshot()
  if (!snapshot) return null
  return restoreSnapshotDOM(snapshot) ? snapshot : null
}

/**
 * eta/main rebuilds local rows synchronously. Put the last successful rows back
 * after that bootstrap, but only when the live row identity is exactly the same.
 * The in-flight refresh then updates these nodes in place.
 */
export function reapplyHomeViewAfterMain(snapshot: HomeViewSnapshot | null): boolean {
  if (!snapshot) return false
  const list = document.querySelector<HTMLDivElement>('#bus-list')
  if (!list) return false
  const currentRows = Array.from(list.querySelectorAll<HTMLAnchorElement>(':scope > .bus-row[data-bus-key]'))
  const currentKeys = new Set(currentRows.map((row) => row.dataset.busKey))
  const snapshotKeys = snapshot.rows.map((row) => row.key)
  if (currentKeys.size !== snapshotKeys.length
    || snapshotKeys.some((key) => !currentKeys.has(key))) {
    sessionStorage.removeItem(SNAPSHOT_KEY)
    document.documentElement.removeAttribute('data-mochi-home-snapshot')
    return false
  }

  const busy = list.getAttribute('aria-busy')
  if (!restoreSnapshotDOM(snapshot)) return false
  if (busy !== null) list.setAttribute('aria-busy', busy)
  return true
}

function snapshotRow(row: HTMLAnchorElement): HomeViewSnapshotRow | null {
  const key = row.dataset.busKey
  const routeName = row.querySelector<HTMLElement>('.bus-name')?.textContent ?? ''
  const directionLabel = row.querySelector<HTMLElement>('.bus-direction')?.textContent ?? ''
  const eta = row.querySelector<HTMLElement>('.bus-eta')
  const copy = eta?.querySelector<HTMLElement>(':scope > .eta-copy:not(.eta-copy-exit)')
  const value = copy?.querySelector<HTMLElement>('.eta-value')?.textContent ?? ''
  if (!key || !eta || !copy || !value) return null

  const href = row.getAttribute('href') ?? '#'
  if (!validSnapshotHref(href)) return null
  return {
    key,
    href,
    routeName,
    directionLabel,
    eta: {
      classes: Array.from(eta.classList).filter((name) => ALLOWED_ETA_CLASSES.has(name)),
      ariaLabel: eta.getAttribute('aria-label') ?? '',
      signature: eta.dataset.signature ?? '',
      prefix: copy.querySelector<HTMLElement>('.eta-prefix')?.textContent ?? '',
      value,
      suffix: copy.querySelector<HTMLElement>('.eta-suffix')?.textContent ?? '',
      freshness: copy.querySelector<HTMLElement>('.eta-freshness')?.textContent ?? '',
    },
  }
}

function snapshotNotice(notice: HTMLParagraphElement): SnapshotNoticePart[] {
  return Array.from(notice.childNodes).flatMap((node): SnapshotNoticePart[] => {
    if (node.nodeType === Node.TEXT_NODE) {
      return [{ kind: 'text', value: node.textContent ?? '' }]
    }
    if (node instanceof HTMLAnchorElement && new URL(node.href, location.origin).pathname === '/setup') {
      return [{ kind: 'setup-link', value: node.textContent ?? '' }]
    }
    return [{ kind: 'text', value: node.textContent ?? '' }]
  })
}

function captureHomeView(): void {
  const fingerprint = boardFingerprint()
  if (!fingerprint) return
  const title = document.querySelector<HTMLHeadingElement>('#board-title')
  const list = document.querySelector<HTMLDivElement>('#bus-list')
  const updated = document.querySelector<HTMLSpanElement>('#updated')
  const notice = document.querySelector<HTMLParagraphElement>('#notice')
  if (!title || !list || !updated || !notice) return
  if (list.querySelector('.skeleton-row')) return

  const rows = Array.from(list.querySelectorAll<HTMLAnchorElement>(':scope > .bus-row[data-bus-key]'))
    .map(snapshotRow)
  if (!rows.length || rows.some((row) => row === null)) return
  if (rows.every((row) => !row?.eta.value || row.eta.value === '更新中')) return

  const snapshot: HomeViewSnapshot = {
    version: 2,
    savedAt: Date.now(),
    boardFingerprint: fingerprint,
    title: title.textContent ?? '',
    rows: rows as HomeViewSnapshotRow[],
    updatedText: updated.textContent ?? '',
    notice: snapshotNotice(notice),
  }
  try {
    sessionStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot))
  } catch {
    // Snapshotting is an enhancement; storage failure must be invisible.
  }
}

export function installHomeViewSnapshotPersistence(): () => void {
  const observed = [
    document.querySelector('#board-title'),
    document.querySelector('#bus-list'),
    document.querySelector('#updated'),
    document.querySelector('#notice'),
  ].filter((node): node is Element => node !== null)

  let timer: number | undefined
  const scheduleCapture = () => {
    window.clearTimeout(timer)
    timer = window.setTimeout(captureHomeView, 60)
  }
  const observer = new MutationObserver(scheduleCapture)
  for (const node of observed) observer.observe(node, { childList: true, subtree: true, characterData: true })
  window.addEventListener('pagehide', captureHomeView)
  document.addEventListener('visibilitychange', scheduleCapture)
  scheduleCapture()

  return () => {
    observer.disconnect()
    window.clearTimeout(timer)
    window.removeEventListener('pagehide', captureHomeView)
    document.removeEventListener('visibilitychange', scheduleCapture)
  }
}
